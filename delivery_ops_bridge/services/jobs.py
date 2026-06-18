from __future__ import annotations

from datetime import date, datetime
from typing import Dict, List

from ..adapters.feishu import FeishuAdapter
from ..config import AppConfig
from ..models import BotMessageContext, TASK_STATUS_ACCEPTED, TASK_STATUS_CANCELLED, TASK_STATUS_OVERDUE, Task, utc_now_iso
from ..storage import JsonStore
from .dashboard import DashboardService
from .summaries import build_daily_summary, render_daily_summary


class ScheduledJobs:
    def __init__(self, config: AppConfig, store: JsonStore, feishu: FeishuAdapter, dashboard: DashboardService):
        self.config = config
        self.store = store
        self.feishu = feishu
        self.dashboard = dashboard

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
        summary = build_daily_summary(self.store, self.config.feishu.group_chat_id, day)
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
        count = 0
        for raw_task in self.store.list_tasks():
            due = raw_task.get("due_date")
            if not due or raw_task.get("status") in {TASK_STATUS_ACCEPTED, TASK_STATUS_CANCELLED}:
                continue
            try:
                due_date = date.fromisoformat(due)
            except ValueError:
                continue
            if due_date < day:
                raw_task["status"] = TASK_STATUS_OVERDUE
                raw_task["updated_at"] = utc_now_iso()
                self.store.save_task(Task(**raw_task))
                owner = raw_task.get("primary_owner_open_id", "")
                self.feishu.send_private_text(owner, f"这个任务已超期，是否需要更新一下当前进展？\n任务：{raw_task.get('title')}\n原截止时间：{due}")
                count += 1
        if count:
            self.feishu.send_group_text(f"以下任务存在延期风险：{count} 个。详情已私聊负责人确认。", self.config.feishu.group_chat_id)
        return {"overdue": count}
