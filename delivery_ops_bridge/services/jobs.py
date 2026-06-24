from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List
import json

from ..adapters.llm import LLMAdapter
from ..adapters.feishu import FeishuAdapter
from ..config import AppConfig
from ..models import BotMessageContext, TASK_STATUS_ACCEPTED, TASK_STATUS_CANCELLED, TASK_STATUS_OVERDUE, Task, TaskUpdate, utc_now_iso
from ..storage import JsonStore
from .dashboard import DashboardService
from .summaries import build_daily_summary, render_daily_summary


class ScheduledJobs:
    def __init__(
        self,
        config: AppConfig,
        store: JsonStore,
        feishu: FeishuAdapter,
        dashboard: DashboardService,
        llm: LLMAdapter | None = None,
    ):
        self.config = config
        self.store = store
        self.feishu = feishu
        self.dashboard = dashboard
        self.llm = llm

    def standup_push(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        count = 0
        seen_open_ids = set()
        for group in self.config.groups:
            for member in group.members:
                if not member.is_active or member.open_id in seen_open_ids:
                    continue
                seen_open_ids.add(member.open_id)
                result = self.feishu.send_private_text(
                    member.open_id,
                    f"每日站会（{day.isoformat()}）\\n\\n{member.name}，请回复以下内容：\\n\\n【昨日完成】\\n1.\\n\\n【今日计划】\\n1.\\n\\n【阻塞/需要帮助】\\n无\\n\\n【风险/可能延期】\\n无\\n\\n【需要决策】\\n无",
                )
                if result.chat_id:
                    self.store.update_chat_id(member.open_id, result.chat_id)
                if result.message_id:
                    self.store.save_bot_message_context(
                        BotMessageContext(
                            message_id=result.message_id,
                            context_type="standup_prompt",
                            created_at=utc_now_iso(),
                            chat_id=result.chat_id or "",
                            chat_type="p2p",
                            target_open_id=member.open_id,
                            metadata={"date": day.isoformat()},
                        )
                    )
                count += 1
        return {"sent": count}

    def standup_remind(self, day: date | None = None) -> Dict[str, int]:
        return self._standup_remind(day, stage="first")

    def standup_second_remind(self, day: date | None = None) -> Dict[str, int]:
        return self._standup_remind(day, stage="second")

    def _standup_remind(self, day: date | None = None, stage: str = "first") -> Dict[str, int]:
        day = day or date.today()
        missing = self._missing_standup_members(day)
        count = 0
        stage_text = "今日站会还未提交，请方便时补充一下。"
        if stage == "second":
            stage_text = "今日站会仍未提交，如有阻塞也可以直接简要回复，我会帮你记录。"
        for member in missing:
            self.feishu.send_private_text(member.open_id, f"{member.name}，{stage_text}")
            count += 1
        self.store.append_audit_log(
            "standup_reminder_sent",
            {
                "date": day.isoformat(),
                "stage": stage,
                "reminded": count,
                "missing_open_ids": [member.open_id for member in missing],
                "missing_names": [member.name for member in missing],
            },
        )
        return {"reminded": count, "stage": stage}

    def standup_mark_missing(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        missing = self._missing_standup_members(day)
        payload = {
            "date": day.isoformat(),
            "missing": len(missing),
            "missing_open_ids": [member.open_id for member in missing],
            "missing_names": [member.name for member in missing],
        }
        self.store.save_standup_missing(day.isoformat(), payload)
        self.store.append_audit_log("standup_missing_marked", payload)
        return {"missing": len(missing)}

    def standup_summary(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        total_submitted = 0
        total_missing = 0
        all_standups = self.store.list_standups(day.isoformat())
        
        for group in self.config.groups:
            group_open_ids = {m.open_id for m in group.members}
            standups = [s for s in all_standups if s.get("open_id") in group_open_ids]
            submitted = {item.get("open_id") for item in standups}
            missing = [member.name for member in group.members if member.is_active and member.open_id not in submitted]
            
            if not standups:
                missing_text = f"七、未提交情况\\n- 未提交人数：{len(missing)}"
                if self.config.runtime.public_missing_standups and missing:
                    missing_text += f"\\n- 未提交成员：{'、'.join(missing)}"
                self.feishu.send_group_text(f"【今日站会汇总｜{day.isoformat()}】\\n\\n暂无站会提交。\\n\\n{missing_text}", group.chat_id)
                total_missing += len(missing)
                continue

            missing_text = f"- 未提交人数：{len(missing)}"
            if self.config.runtime.public_missing_standups and missing:
                missing_text += f"\\n- 未提交成员：{'、'.join(missing)}"

            sent_ai = False
            if self.llm:
                payload = json.dumps([
                    {
                        "name": s.get("user_name"),
                        "yesterday_done": s.get("yesterday_done", []),
                        "today_plan": s.get("today_plan", []),
                        "blockers": s.get("blockers", []),
                        "risks": s.get("risks", []),
                        "decisions_needed": s.get("decisions_needed", [])
                    }
                    for s in standups
                ], ensure_ascii=False)
                prompt = (
                    f"你是研发团队助理，请根据以下 JSON 格式的成员站会提交记录，生成今日站会汇总报告。\\n"
                    f"请严格按照以下格式输出，如果没有相关内容，请在该模块下写“暂无”：\\n\\n"
                    f"【今日站会汇总｜{day.isoformat()}】\\n\\n"
                    f"一、团队今日重点\\n"
                    f"1. xxx\\n\\n"
                    f"二、昨日完成\\n"
                    f"- 张三：xxx\\n\\n"
                    f"三、今日计划\\n"
                    f"- 张三：xxx\\n\\n"
                    f"四、阻塞/需要帮助\\n"
                    f"1. [发起人姓名]：xxx\\n"
                    f"   - 相关人：xxx\\n"
                    f"   - 建议动作：xxx\\n\\n"
                    f"五、风险/可能延期\\n"
                    f"1. [发起人姓名]：xxx\\n"
                    f"   - 风险等级：高 / 中 / 低\\n"
                    f"   - 建议动作：xxx\\n\\n"
                    f"六、需要决策\\n"
                    f"1. [发起人姓名]：xxx\\n"
                    f"   - 建议决策人：xxx\\n\\n"
                    f"请保持格式完全一致，不要输出多余的Markdown代码块符号（如```）。"
                )
                res = self.llm.chat(prompt, payload)
                if res.ok and res.content.strip():
                    text = res.content.strip()
                    if text.startswith("```"):
                        lines = text.split("\\n")
                        if len(lines) > 2:
                            text = "\\n".join(lines[1:-1]).strip()
                    text += f"\\n\\n七、未提交情况\\n{missing_text}"
                    self.feishu.send_group_text(text, group.chat_id)
                    total_submitted += len(standups)
                    total_missing += len(missing)
                    sent_ai = True
                else:
                    self.store.append_audit_log(
                        "ai_standup_summary_failed",
                        {
                            "date": day.isoformat(),
                            "reason": res.error or "empty_response",
                            "submitted": len(standups),
                        },
                    )

            if not sent_ai:
                lines = [f"【今日站会汇总｜{day.isoformat()}】", "", "一、团队今日重点", "1. 暂无", "", "二、昨日完成"]
                for item in standups:
                    lines.append(f"- {item.get('user_name')}：{'；'.join(item.get('yesterday_done', [])) or '暂无'}")
                lines.extend(["", "三、今日计划"])
                for item in standups:
                    lines.append(f"- {item.get('user_name')}：{'；'.join(item.get('today_plan', [])) or '暂无'}")
                lines.extend(["", "四、阻塞/需要帮助"])
                blockers = [(item.get("user_name"), blocker) for item in standups for blocker in item.get("blockers", [])]
                if blockers:
                    for idx, (name, item) in enumerate(blockers, 1):
                        lines.extend([f"{idx}. {name}：{item}", "   - 相关人：待确认", "   - 建议动作：待确认"])
                else:
                    lines.append("暂无。")
                lines.extend(["", "五、风险/可能延期", "暂无。", "", "六、需要决策", "暂无。", "", "七、未提交情况", missing_text])
                self.feishu.send_group_text("\\n".join(lines), group.chat_id)
                total_submitted += len(standups)
                total_missing += len(missing)
                
        return {"submitted": total_submitted, "missing": total_missing}

    def daily_summary(self, day: date | None = None) -> Dict[str, str]:
        day = day or date.today()
        period = self.config.runtime.daily_summary_period
        summary_ids = []
        for group in self.config.groups:
            self._backfill_group_messages_for_summary(group.chat_id, day, period)
            summary = build_daily_summary(self.store, group.chat_id, day, self.llm, period)
            self.store.save_daily_summary(summary)
            text = render_daily_summary(summary)
            self.feishu.send_group_text(text, group.chat_id)
            summary_ids.append(summary.id)
        return {"summary_ids": ",".join(summary_ids)}

    def dashboard_generate(self, day: date | None = None) -> Dict[str, str]:
        day = day or date.today()
        urls = []
        for group in self.config.groups:
            artifact = self.dashboard.generate_for_group(group, day)
            publish = self.feishu.publish_file(artifact.html_path)
            if publish.url:
                artifact.public_url = publish.url
                self.store.save_dashboard_artifact(artifact)

            if publish.ok and artifact.public_url:
                text = f"今日进度看板已生成：\n{artifact.public_url}"
                if publish.warning:
                    text = f"{text}\n\n{publish.warning}"
            elif publish.ok and publish.warning:
                text = f"今日进度看板已生成，但飞书云盘共享未配置完成：\n{publish.warning}\n本地文件：{artifact.html_path}"
            elif publish.ok:
                text = f"今日进度看板已生成：\n{artifact.html_path}"
            else:
                text = f"今日进度看板已生成，但飞书云盘发布失败：\n{self.feishu.explain_error(publish)}\n本地文件：{artifact.html_path}"

            self.feishu.send_group_text(text, group.chat_id)
            self.store.append_audit_log("dashboard_generated", {"group_id": group.chat_id, "artifact_path": artifact.html_path, "public_url": artifact.public_url or "", "trigger": "job"})
            urls.append(artifact.public_url or artifact.html_path)
        return {"artifacts": ",".join(urls)}

    def overdue_scan(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        counts = {"due_tomorrow": 0, "due_today": 0, "overdue_day1": 0, "overdue_risk": 0}
        risk_items = {group.chat_id: [] for group in self.config.groups}
        for raw_task in self.store.list_tasks():
            due = raw_task.get("due_date")
            if not due or raw_task.get("status") in {TASK_STATUS_ACCEPTED, TASK_STATUS_CANCELLED}:
                continue
            group_id = raw_task.get("source_group_id")
            if group_id not in risk_items:
                continue
            try:
                due_date = date.fromisoformat(due)
            except ValueError:
                continue
            days_to_due = (due_date - day).days
            if days_to_due == 1:
                if self._send_due_reminder_once(raw_task, day, "due_tomorrow", f"这个任务明天截止，请确认当前进展和风险。\n任务：{raw_task.get('title')}\n截止时间：{due}"):
                    counts["due_tomorrow"] += 1
            elif days_to_due == 0:
                if self._send_due_reminder_once(raw_task, day, "due_today", f"这个任务今天截止，请同步当前进展。\n任务：{raw_task.get('title')}\n截止时间：{due}"):
                    counts["due_today"] += 1
            elif days_to_due == -1:
                changed = self._mark_overdue_if_needed(raw_task, "overdue_day1")
                if self._send_due_reminder_once(raw_task, day, "overdue_day1", f"这个任务已超期 1 天，是否需要更新一下当前进展？\n任务：{raw_task.get('title')}\n原截止时间：{due}"):
                    counts["overdue_day1"] += 1
                if changed:
                    raw_task["status"] = TASK_STATUS_OVERDUE
            elif days_to_due <= -2:
                self._mark_overdue_if_needed(raw_task, "overdue_risk")
                if self._send_due_reminder_once(raw_task, day, "overdue_risk", f"这个任务已超期超过 2 天，已进入日报和看板风险，请尽快更新进展。\n任务：{raw_task.get('title')}\n原截止时间：{due}"):
                    counts["overdue_risk"] += 1
                    owner_text = f"，负责人：{raw_task.get('primary_owner_name', '')}" if self.config.runtime.public_overdue_owners else ""
                    risk_items[group_id].append(f"{len(risk_items[group_id]) + 1}. {raw_task.get('title')}，原定 {due} 完成{owner_text}，当前仍未完成。")
        for group in self.config.groups:
            if risk_items[group.chat_id]:
                self.feishu.send_group_text("以下任务存在延期风险：\n" + "\n".join(risk_items[group.chat_id]), group.chat_id)
        return counts

    def _send_due_reminder_once(self, task: Dict[str, Any], day: date, scenario: str, text: str) -> bool:
        reminders = dict(task.get("overdue_reminders") or {})
        last_sent = self._parse_iso_datetime(reminders.get(scenario, ""))
        if last_sent and datetime.utcnow() - last_sent < self._task_reminder_interval():
            return False
        owner = task.get("primary_owner_open_id", "")
        self.feishu.send_private_text(owner, text)
        reminders[scenario] = utc_now_iso()
        task["overdue_reminders"] = reminders
        try:
            self.store.save_task(Task(**task))
        except TypeError:
            pass
        self.store.append_audit_log("overdue_reminder_sent", {"task_id": task.get("id"), "scenario": scenario, "due_date": task.get("due_date")})
        return True

    def _mark_overdue_if_needed(self, raw_task: Dict[str, Any], reason: str) -> bool:
        if raw_task.get("status") == TASK_STATUS_OVERDUE:
            return False
        raw_task["status"] = TASK_STATUS_OVERDUE
        raw_task["updated_at"] = utc_now_iso()
        task = Task(**raw_task)
        self.store.save_task(task)
        update = TaskUpdate(
            id=f"update-{task.id}-{len(self.store.list_task_updates(task.id)) + 1}",
            task_id=task.id,
            user_open_id="system",
            user_name="系统",
            update_type="overdue",
            content=f"任务已超期：{task.due_date}",
            source="system",
            source_message_id=None,
            created_at=utc_now_iso(),
            metadata={"reason": reason, "due_date": task.due_date},
        )
        self.store.save_task_update(update)
        self.store.append_audit_log("task_status_updated", {"task_id": task.id, "status": TASK_STATUS_OVERDUE, "update_type": "overdue", "reason": reason})
        return True

    def _task_reminder_interval(self) -> timedelta:
        raw_value = self.config.schedule.get("task_reminder_frequency_hours", 24)
        try:
            hours = float(raw_value)
        except (TypeError, ValueError):
            hours = 24
        return timedelta(hours=max(hours, 1))

    def _parse_iso_datetime(self, value: str) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", ""))
        except ValueError:
            return None

    def _missing_standup_members(self, day: date) -> List[Any]:
        submitted = {item.get("open_id") for item in self.store.list_standups(day.isoformat())}
        missing = {}
        for group in self.config.groups:
            for member in group.members:
                if member.is_active and member.open_id not in submitted:
                    missing[member.open_id] = member
        return list(missing.values())

    def _backfill_group_messages_for_summary(self, chat_id: str, day: date, period: str) -> None:
        if not self.config.runtime.daily_summary_fetch_history:
            return
        if not chat_id:
            return

        start_time, end_time = self._summary_period_range(day, period)
        try:
            history = self.feishu.fetch_chat_history(
                chat_id,
                start_time,
                end_time,
                page_size=self.config.runtime.daily_summary_fetch_page_size,
            )
        except Exception as exc:
            self.store.append_audit_log(
                "daily_summary_history_sync_failed",
                {
                    "date": day.isoformat(),
                    "chat_id": chat_id,
                    "reason": str(exc),
                },
            )
            return

        synced = 0
        inserted = 0
        for message in history:
            existed = self.store.get_source_message(message.id) is not None
            self.store.save_source_message(message)
            synced += 1
            if not existed:
                inserted += 1

        self.store.append_audit_log(
            "daily_summary_history_synced",
            {
                "date": day.isoformat(),
                "chat_id": chat_id,
                "start_time": start_time.isoformat(),
                "end_time": end_time.isoformat(),
                "synced": synced,
                "inserted": inserted,
            },
        )

    def _summary_period_range(self, day: date, period: str) -> tuple[datetime, datetime]:
        start_str, end_str = period.split("-") if "-" in period else ("00:00", "23:59")
        h_start, m_start = map(int, start_str.split(":"))
        h_end, m_end = map(int, end_str.split(":"))

        if h_start > h_end or (h_start == h_end and m_start >= m_end):
            start_day = day - timedelta(days=1)
        else:
            start_day = day

        start_time = datetime(start_day.year, start_day.month, start_day.day, h_start, m_start, 0)
        end_time = datetime(day.year, day.month, day.day, h_end, m_end, 59, 999999)
        return start_time, end_time
