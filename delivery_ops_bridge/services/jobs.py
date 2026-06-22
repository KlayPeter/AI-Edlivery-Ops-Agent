from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List

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
        for member in self.config.members:
            if not member.is_active:
                continue
            result = self.feishu.send_private_text(
                member.open_id,
                f"每日站会（{day.isoformat()}）\n\n{member.name}，请回复以下内容：\n\n【昨日完成】\n1.\n\n【今日计划】\n1.\n\n【阻塞/需要帮助】\n无\n\n【风险/可能延期】\n无\n\n【需要决策】\n无",
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
                        target_open_id=member.open_id,
                        metadata={"date": day.isoformat()},
                    )
                )
            count += 1
        return {"sent": count}

    def standup_remind(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        submitted = {item.get("open_id") for item in self.store.list_standups(day.isoformat())}
        count = 0
        for member in self.config.members:
            if member.is_active and member.open_id not in submitted:
                self.feishu.send_private_text(member.open_id, f"{member.name}，今日站会还未提交，请方便时补充一下。")
                count += 1
        return {"reminded": count}

    def standup_summary(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        standups = self.store.list_standups(day.isoformat())
        submitted = {item.get("open_id") for item in standups}
        missing = [member.name for member in self.config.members if member.is_active and member.open_id not in submitted]
        lines = [f"【今日站会汇总｜{day.isoformat()}】", "", "一、今日计划"]
        if standups:
            for item in standups:
                lines.append(f"- {item.get('user_name')}：{'；'.join(item.get('today_plan', [])) or '未填写'}")
        else:
            lines.append("暂无站会提交。")
        blockers = [blocker for item in standups for blocker in item.get("blockers", [])]
        lines.extend(["", "二、阻塞/需要帮助"])
        lines.extend([f"{idx}. {item}" for idx, item in enumerate(blockers, 1)] or ["暂无明确阻塞。"])
        lines.extend(["", "三、未提交情况", f"- 未提交人数：{len(missing)}"])
        if self.config.runtime.public_missing_standups and missing:
            lines.append(f"- 未提交成员：{'、'.join(missing)}")
        self.feishu.send_group_text("\n".join(lines), self.config.feishu.group_chat_id)
        return {"submitted": len(standups), "missing": len(missing)}

    def daily_summary(self, day: date | None = None) -> Dict[str, str]:
        summary = build_daily_summary(self.store, self.config.feishu.group_chat_id, day, self.llm)
        self.store.save_daily_summary(summary)
        text = render_daily_summary(summary)
        self.feishu.send_group_text(text, self.config.feishu.group_chat_id)
        return {"summary_id": summary.id}

    def dashboard_generate(self, day: date | None = None) -> Dict[str, str]:
        artifact = self.dashboard.generate(day)
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

        self.feishu.send_group_text(text, self.config.feishu.group_chat_id)
        return {"artifact": artifact.html_path, "public_url": artifact.public_url or ""}

    def overdue_scan(self, day: date | None = None) -> Dict[str, int]:
        day = day or date.today()
        counts = {"due_tomorrow": 0, "due_today": 0, "overdue_day1": 0, "overdue_risk": 0}
        risk_items: List[str] = []
        for raw_task in self.store.list_tasks():
            due = raw_task.get("due_date")
            if not due or raw_task.get("status") in {TASK_STATUS_ACCEPTED, TASK_STATUS_CANCELLED}:
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
                    risk_items.append(f"{len(risk_items) + 1}. {raw_task.get('title')}，原定 {due} 完成{owner_text}，当前仍未完成。")
        if risk_items:
            self.feishu.send_group_text("以下任务存在延期风险：\n" + "\n".join(risk_items), self.config.feishu.group_chat_id)
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
