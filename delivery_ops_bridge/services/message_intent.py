from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional

from ..adapters.llm import LLMAdapter
from ..models import Member, Mention, SourceMessage


SUPPORTED_INTENTS = {"update_task", "create_task", "add_progress", "change_status", "unknown"}
SUPPORTED_STATUS_ACTIONS = {"接受", "拒绝", "需要澄清", "验收通过", "打回", "已完成", "完成了", "阻塞", "阻塞了"}
SUPPORTED_PRIORITIES = {"P0", "P1", "P2", "P3"}


@dataclass
class IntentTaskRef:
    task_id: str = ""
    tapd_story_id: str = ""
    title: str = ""


@dataclass
class IntentFields:
    title: str = ""
    due_date: str = ""
    priority: str = ""
    owner_open_id: str = ""
    progress: str = ""
    status_action: str = ""


@dataclass
class MessageIntent:
    intent: str = "unknown"
    confidence: float = 0.0
    task_ref: IntentTaskRef = field(default_factory=IntentTaskRef)
    fields: IntentFields = field(default_factory=IntentFields)
    needs_clarification: bool = False
    clarification: str = ""
    error: str = ""

    @property
    def available(self) -> bool:
        return not self.error


class MessageIntentParser:
    def __init__(self, llm: LLMAdapter):
        self.llm = llm

    def parse(
        self,
        message: SourceMessage,
        reply_context: Optional[Dict[str, Any]],
        task_context: Optional[Dict[str, Any]],
        members: List[Member],
        today: date | None = None,
    ) -> MessageIntent:
        today = today or date.today()
        payload = {
            "today": today.isoformat(),
            "message": {
                "id": message.id,
                "chat_type": message.chat_type,
                "sender_open_id": message.sender_open_id,
                "sender_name": message.sender_name,
                "text": message.text,
                "mentions": [{"open_id": item.open_id, "name": item.name} for item in message.mentions],
            },
            "reply_context": self._compact_reply_context(reply_context),
            "task_context": self._compact_task(task_context),
            "members": [{"open_id": member.open_id, "name": member.name, "role": member.role} for member in members if member.is_active],
        }
        result = self.llm.chat(self._system_prompt(), json.dumps(payload, ensure_ascii=False))
        if not result.ok:
            return MessageIntent(error=result.error or "llm_error")
        if not result.content.strip():
            return MessageIntent(error="llm_unavailable")
        try:
            raw = json.loads(self._extract_json(result.content))
        except json.JSONDecodeError as exc:
            return MessageIntent(error=f"invalid_json: {exc}")
        return self._normalize(raw)

    def _system_prompt(self) -> str:
        return (
            "你是研发交付飞书机器人的意图解析器。只输出 JSON，不要 Markdown。\n"
            "根据输入消息、引用上下文、任务上下文和成员列表，判断用户意图并抽取字段。\n"
            "只能使用这些 intent: update_task, create_task, add_progress, change_status, unknown。\n"
            "输出格式必须是："
            "{\"intent\":\"update_task|create_task|add_progress|change_status|unknown\","
            "\"confidence\":0.0,"
            "\"task_ref\":{\"task_id\":\"\",\"tapd_story_id\":\"\",\"title\":\"\"},"
            "\"fields\":{\"title\":\"\",\"due_date\":\"YYYY-MM-DD\",\"priority\":\"P0|P1|P2|P3\","
            "\"owner_open_id\":\"\",\"progress\":\"\",\"status_action\":\"接受|拒绝|需要澄清|验收通过|打回|已完成|阻塞\"},"
            "\"needs_clarification\":false,\"clarification\":\"\"}。\n"
            "高置信度只在任务和字段都明确时给出；如果需要确认或任务不明确，needs_clarification=true 并给出中文澄清。"
        )

    def _extract_json(self, content: str) -> str:
        text = content.strip()
        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
        if fenced:
            return fenced.group(1)
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end >= start:
            return text[start : end + 1]
        return text

    def _normalize(self, raw: Dict[str, Any]) -> MessageIntent:
        intent = raw.get("intent") if isinstance(raw.get("intent"), str) else "unknown"
        if intent not in SUPPORTED_INTENTS:
            intent = "unknown"
        confidence = raw.get("confidence", 0.0)
        if not isinstance(confidence, (int, float)):
            confidence = 0.0
        confidence = max(0.0, min(float(confidence), 1.0))

        task_ref_raw = raw.get("task_ref", {})
        if not isinstance(task_ref_raw, dict):
            task_ref_raw = {}
        fields_raw = raw.get("fields", {})
        if not isinstance(fields_raw, dict):
            fields_raw = {}

        priority = self._string(fields_raw.get("priority")).upper()
        if priority not in SUPPORTED_PRIORITIES:
            priority = ""
        status_action = self._string(fields_raw.get("status_action"))
        if status_action not in SUPPORTED_STATUS_ACTIONS:
            status_action = ""

        return MessageIntent(
            intent=intent,
            confidence=confidence,
            task_ref=IntentTaskRef(
                task_id=self._string(task_ref_raw.get("task_id")),
                tapd_story_id=self._string(task_ref_raw.get("tapd_story_id")),
                title=self._string(task_ref_raw.get("title")),
            ),
            fields=IntentFields(
                title=self._string(fields_raw.get("title")),
                due_date=self._string(fields_raw.get("due_date")),
                priority=priority,
                owner_open_id=self._string(fields_raw.get("owner_open_id")),
                progress=self._string(fields_raw.get("progress")),
                status_action=status_action,
            ),
            needs_clarification=bool(raw.get("needs_clarification", False)),
            clarification=self._string(raw.get("clarification")),
        )

    def _compact_reply_context(self, context: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not context:
            return None
        return {
            "context_type": context.get("context_type", ""),
            "task_id": context.get("task_id", ""),
            "task_title": context.get("task_title", ""),
            "target_open_id": context.get("target_open_id", ""),
            "metadata": context.get("metadata", {}),
        }

    def _compact_task(self, task: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not task:
            return None
        return {
            "id": task.get("id", ""),
            "title": task.get("title", ""),
            "tapd_story_id": task.get("tapd_story_id", ""),
            "primary_owner_open_id": task.get("primary_owner_open_id", ""),
            "primary_owner_name": task.get("primary_owner_name", ""),
            "priority": task.get("priority", ""),
            "due_date": task.get("due_date", ""),
            "status": task.get("status", ""),
        }

    def _string(self, value: Any) -> str:
        return value.strip() if isinstance(value, str) else ""
