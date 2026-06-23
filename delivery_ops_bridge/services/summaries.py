from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from typing import Any, Dict, List

from ..adapters.llm import LLMAdapter
from ..models import DailySummary, utc_now_iso
from ..storage import JsonStore

TASK_HINTS = ("任务", "负责", "跟进", "处理", "完成", "联调", "提测", "修复")
PROGRESS_HINTS = ("进度", "完成了", "已完成", "推进", "联调", "提测", "上线")
BLOCKER_HINTS = ("阻塞", "卡住", "无法", "等待", "需要帮助", "需要协助")
DECISION_HINTS = ("决定", "决策", "结论", "确认", "拍板", "定为")
RISK_HINTS = ("风险", "延期", "来不及", "不稳定", "影响", "超期")
SHARE_HINTS = ("分享", "文档", "链接", "资料", "http://", "https://")

STATUS_MAP = {
    "pending_primary_owner": "待主负责人处理",
    "pending_confirmation": "待确认",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "blocked": "已阻塞",
    "owner_marked_done": "负责人已标记完成",
    "accepted": "已验收",
    "cancelled": "已取消",
    "overdue": "已超期",
}


def build_daily_summary(store: JsonStore, group_id: str, day: date | None = None, llm: LLMAdapter | None = None, period: str = "00:00-23:59") -> DailySummary:
    day = day or date.today()
    date_text = day.isoformat()
    
    start_str, end_str = period.split("-") if "-" in period else ("00:00", "23:59")
    h_start, m_start = map(int, start_str.split(":"))
    h_end, m_end = map(int, end_str.split(":"))
    
    if h_start > h_end or (h_start == h_end and m_start >= m_end):
        yesterday = day - timedelta(days=1)
        start_time = datetime(yesterday.year, yesterday.month, yesterday.day, h_start, m_start, 0)
    else:
        start_time = datetime(day.year, day.month, day.day, h_start, m_start, 0)
        
    end_time = datetime(day.year, day.month, day.day, h_end, m_end, 59, 999999)

    def _in_period(dt_str: str) -> bool:
        if not dt_str:
            return False
        s = str(dt_str)
        if s.isdigit():
            dt = datetime.fromtimestamp(int(s) / 1000.0)
        else:
            try:
                dt_utc = datetime.fromisoformat(s.replace("Z", ""))
                offset = datetime.now() - datetime.utcnow()
                dt = dt_utc + offset
            except ValueError:
                return False
        return start_time <= dt <= end_time

    source_messages = store.list_source_messages()
    source_messages_by_id = {item.get("id", ""): item for item in source_messages if item.get("id")}
    all_tasks = [t for t in store.list_tasks() if t.get("status") != "deleted"]
    tasks_by_id = {item.get("id", ""): item for item in all_tasks if item.get("id")}
    group_task_ids = {item.get("id", "") for item in all_tasks if _item_group_id(item, source_messages_by_id) == group_id}

    messages = [
        item
        for item in source_messages
        if _in_period(item.get("sent_at", "")) and item.get("chat_id") == group_id
    ]
    tasks = [
        _task_summary_item(item, source_messages_by_id)
        for item in all_tasks
        if _in_period(item.get("created_at", "")) and _item_group_id(item, source_messages_by_id) == group_id
    ]
    updates = [
        _update_summary_item(item, source_messages_by_id)
        for item in store.list_task_updates()
        if _in_period(item.get("created_at", ""))
        and (_item_group_id(item, source_messages_by_id) == group_id or item.get("task_id") in group_task_ids)
    ]
    classified = _classify_messages(messages, llm)
    progress_updates = updates + classified["progress_updates"]
    task_blockers = [
        _risk_summary_item(item, source_messages_by_id, item_type="blocker")
        for item in all_tasks
        if item.get("status") == "blocked"
        and _blocked_long_enough(item)
        and _item_group_id(item, source_messages_by_id) == group_id
    ]
    blockers = [
        item
        for item in updates
        if item.get("type") == "blocker" and _blocked_long_enough(tasks_by_id.get(item.get("task_id", ""), {}))
    ] + task_blockers + classified["blockers"]
    risks = [
        _risk_summary_item(item, source_messages_by_id)
        for item in all_tasks
        if (item.get("status") == "overdue" or (item.get("status") == "blocked" and _blocked_long_enough(item)))
        and _item_group_id(item, source_messages_by_id) == group_id
    ]
    risks.extend(classified["risks"])
    highlights = _highlights(tasks, progress_updates, blockers, classified["decisions"], risks, classified["helps"], classified["shares"], classified["meetings"])

    ai_abstract = None
    if llm:
        prompt = (
            "你是研发团队的助理，请根据以下今日统计数据，写一段 50 字左右的精炼总结，"
            "指出今日主要推进了什么，有多少风险/阻塞，语气要专业简练。\n"
            f"任务数：{len(tasks)}，进度数：{len(progress_updates)}，"
            f"阻塞数：{len(blockers)}，决策数：{len(classified['decisions'])}，"
            f"风险数：{len(risks)}"
        )
        try:
            res = llm.chat(prompt, "")
            if res.ok and res.content.strip():
                ai_abstract = res.content.strip()
        except Exception:
            pass

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
        helps=classified["helps"],
        shares=classified["shares"],
        meetings=classified["meetings"],
        created_at=utc_now_iso(),
        ai_abstract=ai_abstract,
    )


def render_daily_summary(summary: DailySummary) -> str:
    if not any([summary.highlights, summary.tasks, summary.progress_updates, summary.blockers, summary.decisions, summary.risks, summary.shares]):
        return "今日群内无可总结的有效工作信息。"
    lines = [f"【今日研发群聊总结｜{summary.date}】", ""]
    if summary.ai_abstract:
        lines.extend(["🤖 AI 总结：", summary.ai_abstract, ""])
    lines.extend(["一、今日重点"])
    lines.extend(f"{idx}. {item}" for idx, item in enumerate(summary.highlights or ["暂无重点"], 1))
    lines.extend(["", "二、任务与进度"])
    if summary.tasks:
        for idx, task in enumerate(summary.tasks, 1):
            lines.append(f"{idx}. {task.get('title', '')}")
            lines.append(f"   - 负责人：{task.get('primary_owner_name', '')}")
            lines.append(f"   - 当前状态：{STATUS_MAP.get(task.get('status', ''), task.get('status', ''))}")
    elif summary.progress_updates:
        for idx, item in enumerate(summary.progress_updates, 1):
            sender = _sender_name(item)
            lines.append(f"{idx}. {sender}：{item.get('title', '')}")
    else:
        lines.append("暂无新增任务。")
    lines.extend(["", "三、阻塞事项"])
    if summary.blockers:
        for idx, item in enumerate(summary.blockers, 1):
            sender = _sender_name(item)
            lines.append(f"{idx}. {sender}：{item.get('title') or item.get('content', '')}")
            ai = item.get("ai_result") or {}
            related = "、".join(ai.get("related_users", [])) or "待定"
            lines.append(f"   - 需要协助人：{related}")
            lines.append(f"   - 建议动作：跟进解决阻塞")
    else:
        lines.append("暂无明确阻塞。")
    lines.extend(["", "四、决策结论"])
    if summary.decisions:
        for idx, item in enumerate(summary.decisions, 1):
            sender = _sender_name(item)
            lines.append(f"{idx}. {sender}：{item.get('title', '')}")
            ai = item.get("ai_result") or {}
            related = "、".join(ai.get("related_users", [])) or item.get('sender_name', '未知')
            lines.append(f"   - 决策人：{related}")
            lines.append(f"   - 影响范围：团队全员或相关人")
    else:
        lines.append("暂无明确决策。")
    lines.extend(["", "五、风险提示"])
    if summary.risks:
        for idx, item in enumerate(summary.risks, 1):
            sender = _sender_name(item)
            status = f"，当前状态：{STATUS_MAP.get(item.get('status', ''), item.get('status', ''))}" if item.get("status") else ""
            lines.append(f"{idx}. {sender}：{item.get('title', '')}{status}")
            ai = item.get("ai_result") or {}
            risk_level = ai.get("risk_level") or "中"
            lines.append(f"   - 风险等级：{risk_level}")
            lines.append(f"   - 建议动作：跟进风险情况")
    else:
        lines.append("暂无明显风险。")
    lines.extend(["", "六、求助问题"])
    if summary.helps:
        for idx, item in enumerate(summary.helps, 1):
            sender = _sender_name(item)
            lines.append(f"{idx}. {sender}：{item.get('title', '')}")
    else:
        lines.append("暂无求助问题。")
    lines.extend(["", "七、资料分享"])
    if summary.shares:
        for idx, item in enumerate(summary.shares, 1):
            sender = _sender_name(item)
            lines.append(f"{idx}. {sender}：{item.get('title', '')}")
            ai = item.get("ai_result") or {}
            if ai.get("url"):
                lines.append(f"   - 链接：{ai.get('url')}")
    else:
        lines.append("暂无资料分享。")
    lines.extend(["", "八、会议/通知"])
    if summary.meetings:
        for idx, item in enumerate(summary.meetings, 1):
            sender = _sender_name(item)
            lines.append(f"{idx}. {sender}：{item.get('title', '')}")
    else:
        lines.append("暂无会议/通知。")
    lines.extend(["", "九、需要管理者关注"])
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
    helps: List[Dict[str, Any]],
    shares: List[Dict[str, Any]],
    meetings: List[Dict[str, Any]],
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
    if helps:
        values.append(f"今日收到 {len(helps)} 个求助问题。")
    if shares:
        values.append(f"今日沉淀 {len(shares)} 条资料分享。")
    if meetings:
        values.append(f"今日发布 {len(meetings)} 条会议或重要通知。")
    return values[:5]


def _classify_messages(messages: List[Dict[str, Any]], llm: LLMAdapter | None = None) -> Dict[str, List[Dict[str, Any]]]:
    if llm:
        classified = _classify_messages_with_ai(messages, llm)
        if classified is not None:
            return classified
    return _classify_messages_with_rules(messages)


def _classify_messages_with_rules(messages: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    result = _empty_classification()
    for message in messages:
        text = str(message.get("text", "")).strip()
        if not text:
            continue
        if _has_any(text, BLOCKER_HINTS):
            result["blockers"].append(_message_summary_item(message, "blocker", 0.72, parser="rule_daily_summary"))
        if _has_any(text, RISK_HINTS):
            result["risks"].append(_message_summary_item(message, "risk", 0.68, parser="rule_daily_summary"))
        if _has_any(text, DECISION_HINTS):
            result["decisions"].append(_message_summary_item(message, "decision", 0.7, parser="rule_daily_summary"))
        if _has_any(text, SHARE_HINTS):
            result["shares"].append(_message_summary_item(message, "share", 0.72, parser="rule_daily_summary"))
        if _has_any(text, TASK_HINTS) or _has_any(text, PROGRESS_HINTS):
            result["progress_updates"].append(_message_summary_item(message, "progress", 0.62, parser="rule_daily_summary"))
    return result


def _classify_messages_with_ai(messages: List[Dict[str, Any]], llm: LLMAdapter) -> Dict[str, List[Dict[str, Any]]] | None:
    if not messages:
        return _empty_classification()
    payload = {
        "messages": [
            {
                "id": item.get("id", ""),
                "sender_name": item.get("sender_name", ""),
                "sent_at": item.get("sent_at", ""),
                "text": item.get("text", ""),
            }
            for item in messages
        ]
    }
    system = (
        "你是研发交付群聊日报分类器。只输出 JSON，不要 Markdown。"
        "从每条消息中识别 progress(进度更新)、blocker(阻塞事项)、decision(决策结论)、risk(风险提示)、help(求助问题)、share(资料分享)、meeting(会议/通知)，可一条消息产生多个 items。"
        "输出格式：{\"items\":[{\"message_id\":\"\",\"type\":\"progress|blocker|decision|risk|help|share|meeting\","
        "\"title\":\"简短中文标题(如原文包含具体时间、截止日期等关键时间信息，必须在标题中完整保留)\",\"related_users\":[\"姓名\"],\"risk_level\":\"low|medium|high|\",\"url\":\"原文中的链接(如果有)\",\"confidence\":0.0}]}。"
        "重要：必须在 related_users 提取原文中出现的真实姓名，绝对不能输出 _user_1 这种占位符！如果没有特定协助人则留空。"
        "不要编造消息 ID；没有价值的闲聊/噪音不要输出 item。"
    )
    result = llm.chat(system, json.dumps(payload, ensure_ascii=False))
    if not result.ok or not result.content.strip():
        return None
    try:
        raw = json.loads(_extract_json(result.content))
    except json.JSONDecodeError:
        return None
    raw_items = raw.get("items", []) if isinstance(raw, dict) else raw
    if not isinstance(raw_items, list):
        return None
    messages_by_id = {item.get("id", ""): item for item in messages}
    classified = _empty_classification()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        item_type = _normalize_summary_type(raw_item.get("type"))
        message_id = _first_message_id(raw_item)
        message = messages_by_id.get(message_id)
        if not item_type or not message:
            continue
        confidence = _confidence(raw_item.get("confidence", 1.0))
        title = _string(raw_item.get("title")) or _compact_title(str(message.get("text", "")))
        if confidence < 0.85 and confidence != 1.0:
            title = f"可能：{title}"
        ai_result = {
            "type": item_type,
            "parser": "llm_daily_summary",
            "title": title,
            "related_users": _string_list(raw_item.get("related_users")),
            "risk_level": _string(raw_item.get("risk_level")),
            "url": _string(raw_item.get("url")),
        }
        item = _message_summary_item(message, item_type, confidence, title=title, ai_result=ai_result)
        classified[_summary_bucket(item_type)].append(item)
    return classified


def _message_summary_item(
    message: Dict[str, Any],
    item_type: str,
    confidence: float,
    parser: str = "llm_daily_summary",
    title: str | None = None,
    ai_result: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    text = str(message.get("text", "")).strip()
    title = title or _compact_title(text)
    ai_result = ai_result or {"type": item_type, "parser": parser, "title": title}
    trace = _message_trace(message, ai_result, confidence)
    item = {
        "type": item_type,
        "title": title,
        "source_message_ids": trace["source_message_ids"],
        "source_group_id": trace["source_group_id"],
        "sender_open_id": trace["sender_open_id"],
        "sender_name": trace["sender_name"],
        "sent_at": trace["sent_at"],
        "raw_text": trace["raw_text"],
        "ai_result": ai_result,
        "confidence": confidence,
        "trace": trace,
    }
    if ai_result.get("related_users"):
        item["related_users"] = ai_result["related_users"]
    if ai_result.get("risk_level"):
        item["risk_level"] = ai_result["risk_level"]
    return item


def _task_summary_item(task: Dict[str, Any], messages_by_id: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    item = dict(task)
    source_message_id = item.get("source_message_id")
    ai_result = item.get("ai_result") or {"type": "task", "parser": "structured_record", "title": item.get("title", "")}
    confidence = item.get("confidence") if item.get("confidence") is not None else 1.0
    trace = item.get("trace") or _trace_from_source(item, messages_by_id, ai_result, confidence)
    item["type"] = "task"
    item["source_message_ids"] = [source_message_id] if source_message_id else []
    item["ai_result"] = ai_result
    item["confidence"] = confidence
    item["trace"] = trace
    _copy_trace_to_top_level(item, trace)
    return item


def _update_summary_item(update: Dict[str, Any], messages_by_id: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    item = dict(update)
    source_message_id = item.get("source_message_id")
    ai_result = item.get("ai_result") or {"type": item.get("update_type", "progress"), "parser": "structured_record"}
    confidence = item.get("confidence") if item.get("confidence") is not None else 1.0
    trace = item.get("trace") or _trace_from_source(item, messages_by_id, ai_result, confidence)
    item["type"] = "blocker" if item.get("update_type") == "blocked" else "progress"
    item["title"] = item.get("content", "")
    item["source_message_ids"] = [source_message_id] if source_message_id else []
    item["ai_result"] = ai_result
    item["confidence"] = confidence
    item["trace"] = trace
    _copy_trace_to_top_level(item, trace)
    return item


def _risk_summary_item(task: Dict[str, Any], messages_by_id: Dict[str, Dict[str, Any]], item_type: str = "risk") -> Dict[str, Any]:
    item = _task_summary_item(task, messages_by_id)
    item["type"] = item_type
    item["ai_result"] = {"type": item_type, "parser": "structured_record", "title": item.get("title", "")}
    if item.get("trace"):
        item["trace"]["ai_result"] = item["ai_result"]
    return item


def _sender_name(item: Dict[str, Any]) -> str:
    return item.get("source_sender_name") or item.get("sender_name") or item.get("creator_name") or "未知"


def _blocked_long_enough(task: Dict[str, Any]) -> bool:
    if not task or task.get("status") != "blocked":
        return False
    blocked_at = _parse_iso_datetime(str(task.get("blocked_at") or ""))
    if not blocked_at:
        return False
    return datetime.utcnow() - blocked_at >= timedelta(hours=24)


def _parse_iso_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", ""))
    except ValueError:
        return None


def _has_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text for keyword in keywords)


def _compact_title(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip(" ，,。")
    return cleaned[:80] + ("..." if len(cleaned) > 80 else "")


def _empty_classification() -> Dict[str, List[Dict[str, Any]]]:
    return {"progress_updates": [], "blockers": [], "decisions": [], "risks": [], "helps": [], "shares": [], "meetings": []}


def _message_trace(message: Dict[str, Any], ai_result: Dict[str, Any], confidence: float) -> Dict[str, Any]:
    message_id = str(message.get("id", ""))
    return {
        "source_group_id": str(message.get("chat_id", "")),
        "source_message_id": message_id,
        "source_message_ids": [message_id] if message_id else [],
        "sender_open_id": str(message.get("sender_open_id", "")),
        "sender_name": str(message.get("sender_name", "")),
        "sent_at": str(message.get("sent_at", "")),
        "raw_text": str(message.get("text", "")),
        "ai_result": ai_result,
        "confidence": confidence,
    }


def _trace_from_source(
    item: Dict[str, Any],
    messages_by_id: Dict[str, Dict[str, Any]],
    ai_result: Dict[str, Any],
    confidence: float,
) -> Dict[str, Any]:
    source_message_id = item.get("source_message_id")
    message = messages_by_id.get(source_message_id or "")
    if message:
        return _message_trace(message, ai_result, confidence)
    return {
        "source_group_id": str(item.get("source_group_id", "")),
        "source_message_id": source_message_id or "",
        "source_message_ids": [source_message_id] if source_message_id else [],
        "sender_open_id": str(item.get("source_sender_open_id", "")),
        "sender_name": str(item.get("source_sender_name", "")),
        "sent_at": str(item.get("source_sent_at", "")),
        "raw_text": str(item.get("raw_text", "")),
        "ai_result": ai_result,
        "confidence": confidence,
    }


def _copy_trace_to_top_level(item: Dict[str, Any], trace: Dict[str, Any]) -> None:
    item["source_group_id"] = trace.get("source_group_id", item.get("source_group_id", ""))
    item["source_message_ids"] = trace.get("source_message_ids", item.get("source_message_ids", []))
    item["sender_open_id"] = trace.get("sender_open_id", item.get("sender_open_id", ""))
    item["sender_name"] = trace.get("sender_name", item.get("sender_name", ""))
    item["sent_at"] = trace.get("sent_at", item.get("sent_at", ""))
    item["raw_text"] = trace.get("raw_text", item.get("raw_text", ""))


def _item_group_id(item: Dict[str, Any], messages_by_id: Dict[str, Dict[str, Any]]) -> str:
    if item.get("source_group_id"):
        return str(item.get("source_group_id"))
    source_message_id = str(item.get("source_message_id", ""))
    return str(messages_by_id.get(source_message_id, {}).get("chat_id", ""))


def _normalize_summary_type(value: Any) -> str:
    item_type = _string(value)
    return item_type if item_type in {"progress", "blocker", "decision", "risk", "help", "share", "meeting"} else ""


def _summary_bucket(item_type: str) -> str:
    return {
        "progress": "progress_updates",
        "blocker": "blockers",
        "decision": "decisions",
        "risk": "risks",
        "help": "helps",
        "share": "shares",
        "meeting": "meetings",
    }[item_type]


def _first_message_id(item: Dict[str, Any]) -> str:
    if item.get("message_id"):
        return _string(item.get("message_id"))
    if item.get("source_message_id"):
        return _string(item.get("source_message_id"))
    ids = item.get("source_message_ids")
    if isinstance(ids, list) and ids:
        return _string(ids[0])
    return ""


def _confidence(value: Any) -> float:
    if not isinstance(value, (int, float)):
        return 1.0
    return max(0.0, min(float(value), 1.0))


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [_string(item) for item in value if _string(item)]


def _extract_json(content: str) -> str:
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        return fenced.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end >= start:
        return text[start : end + 1]
    return text
