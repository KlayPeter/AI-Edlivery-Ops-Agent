from __future__ import annotations

import json

from delivery_ops_bridge.adapters.llm import LLMResult
from delivery_ops_bridge.models import SourceMessage
from delivery_ops_bridge.services.message_intent import MessageIntentParser


class FakeLLM:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def chat(self, system_prompt: str, user_message: str) -> LLMResult:
        self.calls.append((system_prompt, user_message))
        return LLMResult(ok=True, content=json.dumps(self.payload, ensure_ascii=False), raw={"fake": True})


def source_message(text: str) -> SourceMessage:
    return SourceMessage(
        id="om_ai",
        chat_id="oc_group",
        chat_type="group",
        sender_open_id="ou_creator",
        sender_name="Figo",
        text=text,
        message_type="text",
        sent_at="2026-06-18T10:00:00Z",
        raw_payload={},
    )


def parse_payload(text: str, payload):
    parser = MessageIntentParser(FakeLLM(payload))
    return parser.parse(source_message(text), None, None, [])


def test_ai_parser_normalizes_due_date_update():
    intent = parse_payload(
        "截止时间改到本周三",
        {
            "intent": "update_task",
            "confidence": 0.91,
            "task_ref": {"task_id": "task-1"},
            "fields": {"due_date": "2026-06-24"},
        },
    )

    assert intent.intent == "update_task"
    assert intent.confidence == 0.91
    assert intent.task_ref.task_id == "task-1"
    assert intent.fields.due_date == "2026-06-24"


def test_ai_parser_normalizes_priority_update():
    intent = parse_payload("优先级调成 P1", {"intent": "update_task", "confidence": 0.9, "fields": {"priority": "p1"}})

    assert intent.fields.priority == "P1"


def test_ai_parser_normalizes_owner_update():
    intent = parse_payload("负责人换成张三", {"intent": "update_task", "confidence": 0.93, "fields": {"owner_open_id": "ou_zhangsan"}})

    assert intent.fields.owner_open_id == "ou_zhangsan"


def test_ai_parser_normalizes_progress():
    intent = parse_payload("这个卡在接口联调", {"intent": "add_progress", "confidence": 0.88, "fields": {"progress": "卡在接口联调"}})

    assert intent.intent == "add_progress"
    assert intent.fields.progress == "卡在接口联调"


def test_ai_parser_keeps_unknown_for_non_task_chat():
    intent = parse_payload("今天午饭吃什么", {"intent": "unknown", "confidence": 0.2, "fields": {}})

    assert intent.intent == "unknown"
    assert intent.confidence == 0.2
