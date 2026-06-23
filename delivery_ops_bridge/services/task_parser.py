from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import List, Optional

from ..models import Mention


TASK_INTENT_KEYWORDS = [
    "创建任务",
    "创建需求",
    "新建任务",
    "新建需求",
    "建任务",
    "建个任务",
    "建一个任务",
    "创建子任务",
    "新建子任务",
    "建个子任务",
    "建一个子任务",
    "子任务：",
    "子任务:",
    "子任务",
    "安排一下",
    "麻烦处理",
    "请完成",
    "负责一下",
    "跟进一下",
    "做一下",
    "任务：",
    "任务:",
    "需求：",
    "需求:",
    "今天完成",
    "明天完成",
    "本周完成",
    "截止时间",
    "验收标准",
]

INDEPENDENT_KEYWORDS = ["每个人", "各自", "分别", "每人", "都要", "各写一份", "每个端", "各模块"]
WEEKDAY_NAMES = {
    "一": 0,
    "二": 1,
    "三": 2,
    "四": 3,
    "五": 4,
    "六": 5,
    "日": 6,
    "天": 6,
}


@dataclass
class ParsedTaskCommand:
    should_create: bool
    reason: str
    title: str = ""
    primary_owner: Optional[Mention] = None
    assignees: List[Mention] = field(default_factory=list)
    priority: str = "P2"
    tapd_priority_label: str = "Low"
    due_date: Optional[str] = None
    acceptance_criteria: List[str] = field(default_factory=list)
    description: str = ""
    is_independent: bool = False
    missing_primary_owner: bool = False
    is_subtask: bool = False


def has_task_intent(text: str) -> bool:
    return any(keyword in text for keyword in TASK_INTENT_KEYWORDS)


def parse_task_command(
    text: str,
    mentions: List[Mention],
    bot_open_id: str,
    today: Optional[date] = None,
    is_private: bool = False,
) -> ParsedTaskCommand:
    today = today or date.today()
    bot_mentioned = any(item.open_id == bot_open_id for item in mentions)
    assignees = [item for item in mentions if item.open_id != bot_open_id]
    if not is_private and not bot_mentioned:
        return ParsedTaskCommand(False, "bot_not_mentioned")
    if not assignees:
        return ParsedTaskCommand(False, "no_assignee_mentioned")
    if not has_task_intent(text):
        return ParsedTaskCommand(False, "no_task_intent")

    title = _extract_title(text)
    if not title:
        return ParsedTaskCommand(False, "missing_title", assignees=assignees)

    priority, tapd_priority = _extract_priority(text)
    due = _extract_due_date(text, today)
    acceptance = _extract_acceptance_criteria(text)
    is_independent = any(keyword in text for keyword in INDEPENDENT_KEYWORDS)
    primary = _extract_primary_owner(text, assignees)
    missing_primary_owner = len(assignees) > 1 and not primary and not is_independent
    if len(assignees) == 1:
        primary = assignees[0]

    description_parts = []
    if acceptance:
        description_parts.append("验收标准：" + "；".join(acceptance))
    if due:
        description_parts.append(f"截止时间：{due}")
    description = "\n".join(description_parts)
    return ParsedTaskCommand(
        should_create=True,
        reason="ok",
        title=title,
        primary_owner=primary,
        assignees=assignees,
        priority=priority,
        tapd_priority_label=tapd_priority,
        due_date=due,
        acceptance_criteria=acceptance,
        description=description,
        is_independent=is_independent,
        missing_primary_owner=missing_primary_owner,
        is_subtask="子任务" in text,
    )


def _extract_title(text: str) -> str:
    patterns = [
        r"(?:创建任务|创建需求|新建任务|新建需求|任务|需求|创建子任务|新建子任务|子任务)\s*[:：]\s*(.+)",
        r"(?:安排一下|麻烦处理|请完成|负责一下|跟进一下|做一下)\s*(.+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.S)
        if match:
            value = match.group(1).strip()
            value = re.split(r"(?:截止时间|截止|优先级|验收标准|验收|标准|要求)\s*[:：]?", value)[0].strip()
            value = re.sub(r"^@\S+\s*", "", value).strip(" ，,。\n")
            if value:
                return value
    return ""


def _extract_priority(text: str) -> tuple[str, str]:
    upper = text.upper()
    if any(token in upper for token in ["P0", "紧急", "马上", "立刻", "高"]):
        return "P0", "High"
    if any(token in upper for token in ["P1", "中", "一般"]):
        return "P1", "Middle"
    if any(token in upper for token in ["P2", "低", "不急"]):
        return "P2", "Low"
    return "P2", "Low"


def parse_due_date_text(text: str, today: Optional[date] = None) -> Optional[str]:
    today = today or date.today()
    if "今天" in text or "今晚" in text:
        return today.isoformat()
    if "明天" in text or "明晚" in text:
        return (today + timedelta(days=1)).isoformat()
    if "后天" in text:
        return (today + timedelta(days=2)).isoformat()
        
    match = re.search(r"(?:(\d{4})[-年/])?(?:(1[0-2]|0?[1-9])[-月/])?(3[01]|[12][0-9]|0?[1-9])(?:日|号)", text)
    if match:
        y_str, m_str, d_str = match.groups()
        y = int(y_str) if y_str else today.year
        m = int(m_str) if m_str else today.month
        d = int(d_str)
        try:
            return date(y, m, d).isoformat()
        except ValueError:
            pass

    match = re.search(r"(\d{4}-\d{1,2}-\d{1,2})", text)
    if match:
        y, m, d = [int(part) for part in match.group(1).split("-")]
        try:
            return date(y, m, d).isoformat()
        except ValueError:
            pass

    weekday_match = re.search(r"(下下周|下周|本周|这周|周)([一二三四五六日天])", text)
    if weekday_match:
        prefix = weekday_match.group(1)
        target_weekday = WEEKDAY_NAMES[weekday_match.group(2)]
        current_weekday = today.weekday()
        
        weeks_add = 0
        if prefix == "下周":
            weeks_add = 1
        elif prefix == "下下周":
            weeks_add = 2
            
        days = target_weekday - current_weekday + 7 * weeks_add
        if days < 0 and weeks_add == 0:
            days += 7
            
        return (today + timedelta(days=days)).isoformat()

    return None


def _extract_due_date(text: str, today: date) -> Optional[str]:
    return parse_due_date_text(text, today)


def _extract_acceptance_criteria(text: str) -> List[str]:
    match = re.search(r"(?:验收标准|验收|标准|要求)\s*[:：]\s*(.+)", text, re.S)
    if not match:
        return []
    raw = match.group(1).strip()
    raw = re.split(r"(?:优先级|截止时间|截止)\s*[:：]?", raw)[0]
    values = [item.strip(" ，,。；;\n") for item in re.split(r"[；;\n]", raw) if item.strip()]
    return values[:5]


def _extract_primary_owner(text: str, assignees: List[Mention]) -> Optional[Mention]:
    for assignee in assignees:
        if assignee.name and re.search(re.escape(assignee.name) + r"\s*(?:主责|主负责人|owner)", text, re.I):
            return assignee
    match = re.search(r"主负责人\s*@?([^\s，,。]+)", text)
    if match:
        name = match.group(1)
        for assignee in assignees:
            if assignee.name == name:
                return assignee
    return None
