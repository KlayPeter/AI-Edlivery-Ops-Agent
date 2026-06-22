from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List

from ..models import DailySummary, utc_now_iso
from ..storage import JsonStore

TASK_HINTS = ("任务", "负责", "跟进", "处理", "完成", "联调", "提测", "修复")
PROGRESS_HINTS = ("进度", "完成了", "已完成", "推进", "联调", "提测", "上线")
BLOCKER_HINTS = ("阻塞", "卡住", "无法", "等待", "需要帮助", "需要协助")
DECISION_HINTS = ("决定", "决策", "结论", "确认", "拍板", "定为")
RISK_HINTS = ("风险", "延期", "来不及", "不稳定", "影响", "超期")
SHARE_HINTS = ("分享", "文档", "链接", "资料", "http://", "https://")


def build_daily_summary(store: JsonStore, group_id: str, day: date | None = None) -> DailySummary:
    day = day or date.today()
    date_text = day.isoformat()
    messages = [
        item
        for item in store.list_source_messages()
        if str(item.get("sent_at", "")).startswith(date_text) and item.get("chat_id") == group_id
    ]
    tasks = [_task_summary_item(item) for item in store.list_tasks() if str(item.get("created_at", "")).startswith(date_text)]
    updates = [
        _update_summary_item(item)
        for item in store.list_task_updates()
        if str(item.get("created_at", "")).startswith(date_text)
    ]
    classified = _classify_messages(messages)
    progress_updates = updates + classified["progress_updates"]
    blockers = [item for item in updates if item.get("type") == "blocker"] + classified["blockers"]
    risks = [_risk_summary_item(item) for item in store.list_tasks() if item.get("status") in {"blocked", "overdue"}]
    risks.extend(classified["risks"])
    highlights = _highlights(tasks, progress_updates, blockers, classified["decisions"], risks, classified["shares"])
    return DailySummary(
        id=f"summary-{date_text}",
        group_id=group_id,
        date=date_text,
        highlights=highlights,
        tasks=tasks,
        progress_updates=progress_updates,
        blockers=blockers,
        decisions=classified["decisions"],
        risks=risks,
        shares=classified["shares"],
        created_at=utc_now_iso(),
    )


def render_daily_summary(summary: DailySummary) -> str:
    if not any([summary.highlights, summary.tasks, summary.progress_updates, summary.blockers, summary.decisions, summary.risks, summary.shares]):
        return "今日群内无可总结的有效工作信息。"
    lines = [f"【今日研发群聊总结｜{summary.date}】", "", "一、今日重点"]
    lines.extend(f"{idx}. {item}" for idx, item in enumerate(summary.highlights or ["暂无重点"], 1))
    lines.extend(["", "二、任务与进度"])
    if summary.tasks:
        for idx, task in enumerate(summary.tasks, 1):
            lines.append(f"{idx}. {task.get('title', '')}")
            lines.append(f"   - 负责人：{task.get('primary_owner_name', '')}")
            lines.append(f"   - 当前状态：{task.get('status', '')}")
            lines.append(f"   - 来源：{_source_text(task)}")
    elif summary.progress_updates:
        for idx, item in enumerate(summary.progress_updates, 1):
            lines.append(f"{idx}. {item.get('title', '')}")
            lines.append(f"   - 来源：{_source_text(item)}")
    else:
        lines.append("暂无新增任务。")
    lines.extend(["", "三、阻塞事项"])
    if summary.blockers:
        for idx, item in enumerate(summary.blockers, 1):
            lines.append(f"{idx}. {item.get('title') or item.get('content', '')}")
            lines.append(f"   - 来源：{_source_text(item)}")
    else:
        lines.append("暂无明确阻塞。")
    lines.extend(["", "四、决策结论"])
    if summary.decisions:
        for idx, item in enumerate(summary.decisions, 1):
            lines.append(f"{idx}. {item.get('title', '')}")
            lines.append(f"   - 来源：{_source_text(item)}")
    else:
        lines.append("暂无明确决策。")
    lines.extend(["", "五、风险提示"])
    if summary.risks:
        for idx, item in enumerate(summary.risks, 1):
            status = f"，当前状态：{item.get('status', '')}" if item.get("status") else ""
            lines.append(f"{idx}. {item.get('title', '')}{status}")
            lines.append(f"   - 来源：{_source_text(item)}")
    else:
        lines.append("暂无明显风险。")
    lines.extend(["", "六、资料分享"])
    if summary.shares:
        for idx, item in enumerate(summary.shares, 1):
            lines.append(f"{idx}. {item.get('title', '')}")
            lines.append(f"   - 来源：{_source_text(item)}")
    else:
        lines.append("暂无资料分享。")
    lines.extend(["", "七、需要管理者关注"])
    attention = summary.blockers + summary.risks
    if attention:
        for idx, item in enumerate(attention[:5], 1):
            lines.append(f"{idx}. {item.get('title') or item.get('content', '')}")
    else:
        lines.append("暂无需要管理者特别关注的事项。")
    return "\n".join(lines)


def _highlights(
    tasks: List[Dict[str, Any]],
    progress_updates: List[Dict[str, Any]],
    blockers: List[Dict[str, Any]],
    decisions: List[Dict[str, Any]],
    risks: List[Dict[str, Any]],
    shares: List[Dict[str, Any]],
) -> List[str]:
    values: List[str] = []
    if tasks:
        values.append(f"今日新增 {len(tasks)} 个显式任务。")
    if progress_updates:
        values.append(f"今日记录 {len(progress_updates)} 条任务或进度信息。")
    if blockers:
        values.append(f"今日记录 {len(blockers)} 条阻塞，需要关注协助动作。")
    if decisions:
        values.append(f"今日沉淀 {len(decisions)} 条决策结论。")
    if risks:
        values.append(f"{len(risks)} 个任务存在阻塞或超期风险。")
    if shares:
        values.append(f"今日沉淀 {len(shares)} 条资料分享。")
    return values[:5]


def _classify_messages(messages: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    result = {
        "progress_updates": [],
        "blockers": [],
        "decisions": [],
        "risks": [],
        "shares": [],
    }
    for message in messages:
        text = str(message.get("text", "")).strip()
        if not text:
            continue
        if _has_any(text, BLOCKER_HINTS):
            result["blockers"].append(_message_summary_item(message, "blocker", 0.72))
        if _has_any(text, RISK_HINTS):
            result["risks"].append(_message_summary_item(message, "risk", 0.68))
        if _has_any(text, DECISION_HINTS):
            result["decisions"].append(_message_summary_item(message, "decision", 0.7))
        if _has_any(text, SHARE_HINTS):
            result["shares"].append(_message_summary_item(message, "share", 0.72))
        if _has_any(text, TASK_HINTS) or _has_any(text, PROGRESS_HINTS):
            result["progress_updates"].append(_message_summary_item(message, "progress", 0.62))
    return result


def _message_summary_item(message: Dict[str, Any], item_type: str, confidence: float) -> Dict[str, Any]:
    text = str(message.get("text", "")).strip()
    return {
        "type": item_type,
        "title": _compact_title(text),
        "source_message_ids": [message.get("id", "")],
        "source_group_id": message.get("chat_id", ""),
        "sender_open_id": message.get("sender_open_id", ""),
        "sender_name": message.get("sender_name", ""),
        "sent_at": message.get("sent_at", ""),
        "raw_text": text,
        "confidence": confidence,
    }


def _task_summary_item(task: Dict[str, Any]) -> Dict[str, Any]:
    item = dict(task)
    source_message_id = item.get("source_message_id")
    item["type"] = "task"
    item["source_message_ids"] = [source_message_id] if source_message_id else []
    item["confidence"] = 1.0
    return item


def _update_summary_item(update: Dict[str, Any]) -> Dict[str, Any]:
    item = dict(update)
    source_message_id = item.get("source_message_id")
    item["type"] = "blocker" if item.get("update_type") == "blocked" else "progress"
    item["title"] = item.get("content", "")
    item["source_message_ids"] = [source_message_id] if source_message_id else []
    item["confidence"] = 1.0
    return item


def _risk_summary_item(task: Dict[str, Any]) -> Dict[str, Any]:
    item = _task_summary_item(task)
    item["type"] = "risk"
    return item


def _source_text(item: Dict[str, Any]) -> str:
    ids = [value for value in item.get("source_message_ids", []) if value]
    return "、".join(ids) if ids else "结构化记录"


def _has_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text for keyword in keywords)


def _compact_title(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip(" ，,。")
    return cleaned[:80] + ("..." if len(cleaned) > 80 else "")
