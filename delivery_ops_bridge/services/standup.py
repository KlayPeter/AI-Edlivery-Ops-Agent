from __future__ import annotations

import re
from datetime import date
from typing import Dict, List

from ..models import Standup, utc_now_iso


STANDUP_KEYWORDS = ["昨日完成", "昨天完成", "今日计划", "今天计划", "阻塞", "风险", "需要决策"]


def looks_like_standup(text: str) -> bool:
    return sum(1 for keyword in STANDUP_KEYWORDS if keyword in text) >= 2


def parse_standup(open_id: str, user_name: str, text: str, message_id: str, today: date | None = None) -> Standup:
    today = today or date.today()
    sections = {
        "yesterday_done": _extract_section(text, ["昨日完成", "昨天完成"]),
        "today_plan": _extract_section(text, ["今日计划", "今天计划"]),
        "blockers": _extract_section(text, ["阻塞/需要帮助", "阻塞", "需要帮助"]),
        "risks": _extract_section(text, ["风险/可能延期", "风险", "可能延期"]),
        "decisions_needed": _extract_section(text, ["需要决策", "决策"]),
    }
    if not any(sections.values()):
        sections = _parse_natural_language(text)
    return Standup(
        id=f"standup-{today.isoformat()}-{open_id}",
        open_id=open_id,
        user_name=user_name,
        date=today.isoformat(),
        yesterday_done=sections["yesterday_done"],
        today_plan=sections["today_plan"],
        blockers=sections["blockers"],
        risks=sections["risks"],
        decisions_needed=sections["decisions_needed"],
        submitted_at=utc_now_iso(),
        source_message_id=message_id,
        raw_text=text,
    )


def _extract_section(text: str, names: List[str]) -> List[str]:
    name_pattern = "|".join(re.escape(name) for name in names)
    all_headers = "昨日完成|昨天完成|今日计划|今天计划|阻塞/需要帮助|阻塞|需要帮助|风险/可能延期|风险|可能延期|需要决策|决策"
    match = re.search(rf"(?:【(?:{name_pattern})】|(?:{name_pattern})\s*[:：])(.+?)(?=(?:【(?:{all_headers})】|(?:{all_headers})\s*[:：])|$)", text, re.S)
    if not match:
        return []
    return _split_items(match.group(1))


def _split_items(value: str) -> List[str]:
    cleaned = value.strip()
    if not cleaned or cleaned in {"无", "暂无", "没有"}:
        return []
    parts = re.split(r"\n+|\d+[.、)]", cleaned)
    return [part.strip(" -，,。；;") for part in parts if part.strip(" -，,。；;") and part.strip() not in {"无", "暂无", "没有"}]


def _parse_natural_language(text: str) -> Dict[str, List[str]]:
    result = {
        "yesterday_done": [],
        "today_plan": [],
        "blockers": [],
        "risks": [],
        "decisions_needed": [],
    }
    yesterday = re.search(r"昨天(.+?)(?:今天|现在|目前|$)", text)
    if yesterday:
        result["yesterday_done"] = [yesterday.group(1).strip(" ，,。")]
    today = re.search(r"今天(.+?)(?:现在|目前|阻塞|风险|$)", text)
    if today:
        result["today_plan"] = [today.group(1).strip(" ，,。")]
    if any(keyword in text for keyword in ["卡住", "阻塞", "需要帮", "无法", "等待"]):
        result["blockers"] = [text.strip()]
    if any(keyword in text for keyword in ["风险", "延期", "来不及"]):
        result["risks"] = [text.strip()]
    return result
