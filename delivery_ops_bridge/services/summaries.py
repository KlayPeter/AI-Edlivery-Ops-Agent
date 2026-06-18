from __future__ import annotations

from datetime import date
from typing import Any, Dict, List

from ..models import DailySummary, utc_now_iso
from ..storage import JsonStore


def build_daily_summary(store: JsonStore, group_id: str, day: date | None = None) -> DailySummary:
    day = day or date.today()
    date_text = day.isoformat()
    messages = [item for item in store.list_source_messages() if str(item.get("sent_at", "")).startswith(date_text)]
    tasks = [item for item in store.list_tasks() if str(item.get("created_at", "")).startswith(date_text)]
    updates = [item for item in store.list_task_updates() if str(item.get("created_at", "")).startswith(date_text)]
    blockers = [item for item in updates if item.get("update_type") == "blocked"]
    risks = [item for item in store.list_tasks() if item.get("status") in {"blocked", "overdue"}]
    highlights = _highlights(messages, tasks, blockers, risks)
    return DailySummary(
        id=f"summary-{date_text}",
        group_id=group_id,
        date=date_text,
        highlights=highlights,
        tasks=tasks,
        progress_updates=updates,
        blockers=blockers,
        decisions=[],
        risks=risks,
        shares=[],
        created_at=utc_now_iso(),
    )


def render_daily_summary(summary: DailySummary) -> str:
    if not summary.highlights and not summary.tasks and not summary.blockers and not summary.risks:
        return "今日群内无可总结的有效工作信息。"
    lines = [f"【今日研发群聊总结｜{summary.date}】", "", "一、今日重点"]
    lines.extend(f"{idx}. {item}" for idx, item in enumerate(summary.highlights or ["暂无重点"], 1))
    lines.extend(["", "二、任务与进度"])
    if summary.tasks:
        for idx, task in enumerate(summary.tasks, 1):
            lines.append(f"{idx}. {task.get('title', '')}")
            lines.append(f"   - 负责人：{task.get('primary_owner_name', '')}")
            lines.append(f"   - 当前状态：{task.get('status', '')}")
    else:
        lines.append("暂无新增任务。")
    lines.extend(["", "三、阻塞事项"])
    if summary.blockers:
        for idx, item in enumerate(summary.blockers, 1):
            lines.append(f"{idx}. {item.get('content', '')}")
    else:
        lines.append("暂无明确阻塞。")
    lines.extend(["", "四、风险提示"])
    if summary.risks:
        for idx, task in enumerate(summary.risks, 1):
            lines.append(f"{idx}. {task.get('title', '')}，当前状态：{task.get('status', '')}")
    else:
        lines.append("暂无明显风险。")
    return "\n".join(lines)


def _highlights(
    messages: List[Dict[str, Any]],
    tasks: List[Dict[str, Any]],
    blockers: List[Dict[str, Any]],
    risks: List[Dict[str, Any]],
) -> List[str]:
    values: List[str] = []
    if tasks:
        values.append(f"今日新增 {len(tasks)} 个显式任务。")
    if blockers:
        values.append(f"今日记录 {len(blockers)} 条阻塞，需要关注协助动作。")
    if risks:
        values.append(f"{len(risks)} 个任务存在阻塞或超期风险。")
    if messages:
        values.append(f"今日沉淀 {len(messages)} 条群聊/私聊原始消息。")
    return values[:5]
