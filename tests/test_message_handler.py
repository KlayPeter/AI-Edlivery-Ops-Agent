from __future__ import annotations

from datetime import date, timedelta

from delivery_ops_bridge.adapters.feishu import WORKING_REACTION_EMOJI_TYPE, SendResult
from delivery_ops_bridge.models import BotMessageContext, Task, utc_now_iso
from delivery_ops_bridge.services.message_intent import IntentFields, IntentTaskRef, MessageIntent
from tests.conftest import feishu_event, mention


class FakeIntentParser:
    def __init__(self, intent: MessageIntent):
        self.intent = intent
        self.calls = []

    def parse(self, message, reply_context, task_context, members):
        self.calls.append((message, reply_context, task_context, members))
        return self.intent


def test_url_like_task_create_creates_tapd_story_and_task(handler):
    event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一 截止时间：明天 优先级：P1 验收标准：前端可展示对应提示",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )

    result = handler.handle_event(event)

    assert result["action"] == "task_created"
    tasks = handler.store.list_tasks()
    assert len(tasks) == 1
    assert tasks[0]["primary_owner_open_id"] == "ou_zhangsan"
    assert tasks[0]["priority"] == "P1"
    assert tasks[0]["tapd_story_id"].startswith("dry-")


def test_rule_matched_task_create_does_not_call_ai(handler):
    parser = FakeIntentParser(MessageIntent(intent="unknown", confidence=1.0))
    handler.intent_parser = parser
    event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )

    result = handler.handle_event(event)

    assert result["action"] == "task_created"
    assert parser.calls == []


def test_working_reaction_uses_on_it_emoji(handler):
    reactions = []
    removals = []

    def add_reaction(message_id, emoji_type=WORKING_REACTION_EMOJI_TYPE):
        reactions.append((message_id, emoji_type))
        return "reaction_1"

    handler.feishu.add_reaction = add_reaction
    handler.feishu.remove_reaction = lambda message_id, reaction_id: removals.append((message_id, reaction_id))

    result = handler.handle_event(feishu_event("普通聊天", message_id="om_working"))

    assert result["handled"] is False
    assert reactions == [("om_working", WORKING_REACTION_EMOJI_TYPE)]
    assert removals == [("om_working", "reaction_1")]


def test_group_task_create_replies_to_source_message(handler):
    replies = []

    def send_reply_text(message_id, text):
        replies.append((message_id, text))
        return SendResult(ok=True, raw={"reply_to": message_id}, message_id="om_bot_group_notice")

    handler.feishu.send_reply_text = send_reply_text
    event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        message_id="om_group_direct_mention",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )

    result = handler.handle_event(event)

    assert result["action"] == "task_created"
    assert replies[-1][0] == "om_group_direct_mention"
    assert "已创建任务" in replies[-1][1]


def test_group_context_required_reply_quotes_source_message(handler):
    replies = []
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 接受",
            message_id="om_group_accept_without_context",
            mentions=[mention("ou_bot", "AI交付助理")],
        )
    )

    assert result["action"] == "task_context_required"
    assert replies == [("om_group_accept_without_context", "请引用对应任务消息回复，或直接带上任务ID。")]


def test_group_reply_updates_due_date_from_task_context(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：负责任务完成前端页面渲染",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_create_due_change",
    )
    created = handler.handle_event(create_event)
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_bot_created_due_change",
            context_type="task_group_notice",
            created_at=utc_now_iso(),
            chat_id="oc_group",
            task_id=created["task_id"],
            task_title="负责任务完成前端页面渲染",
            metadata={"tapd_story_id": created["tapd_story_id"]},
        )
    )
    replies = []
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})
    expected_due = (date.today() + timedelta(days=(2 - date.today().weekday()) % 7)).isoformat()

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 截止时间设置为本周三",
            mentions=[mention("ou_bot", "AI交付助理")],
            message_id="om_due_change",
            parent_id="om_bot_created_due_change",
        )
    )

    assert result["action"] == "due_date_updated"
    assert result["due_date"] == expected_due
    assert handler.store.get_task(created["task_id"])["due_date"] == expected_due
    assert replies == [("om_due_change", f"截止时间已更新：负责任务完成前端页面渲染 -> {expected_due}")]


def test_ai_high_confidence_updates_priority_from_task_context(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_ai_priority_create",
    )
    created = handler.handle_event(create_event)
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_bot_ai_priority",
            context_type="task_group_notice",
            created_at=utc_now_iso(),
            chat_id="oc_group",
            task_id=created["task_id"],
            task_title="完成登录接口错误码统一",
            metadata={"tapd_story_id": created["tapd_story_id"]},
        )
    )
    handler.intent_parser = FakeIntentParser(
        MessageIntent(intent="update_task", confidence=0.92, fields=IntentFields(priority="P1"))
    )
    replies = []
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 优先级拉到 P1",
            mentions=[mention("ou_bot", "AI交付助理")],
            message_id="om_ai_priority",
            parent_id="om_bot_ai_priority",
        )
    )

    assert result["action"] == "ai_task_updated"
    assert handler.store.get_task(created["task_id"])["priority"] == "P1"
    assert replies == [("om_ai_priority", "已更新任务：完成登录接口错误码统一\n优先级：P1")]


def test_ai_low_confidence_replies_clarification_without_update(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_ai_low_create",
    )
    created = handler.handle_event(create_event)
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_bot_ai_low",
            context_type="task_group_notice",
            created_at=utc_now_iso(),
            chat_id="oc_group",
            task_id=created["task_id"],
            task_title="完成登录接口错误码统一",
        )
    )
    handler.intent_parser = FakeIntentParser(
        MessageIntent(
            intent="update_task",
            confidence=0.4,
            fields=IntentFields(priority="P1"),
            needs_clarification=True,
            clarification="我没理解要改哪个字段，请说清楚一点。",
        )
    )
    replies = []
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event("@AI交付助理 改一下", mentions=[mention("ou_bot", "AI交付助理")], message_id="om_ai_low", parent_id="om_bot_ai_low")
    )

    assert result["action"] == "ai_clarification"
    assert handler.store.get_task(created["task_id"])["priority"] == "P2"
    assert replies == [("om_ai_low", "我没理解要改哪个字段，请说清楚一点。")]


def test_ai_missing_task_context_does_not_execute(handler):
    handler.intent_parser = FakeIntentParser(
        MessageIntent(intent="update_task", confidence=0.94, task_ref=IntentTaskRef(title="不存在的任务"), fields=IntentFields(priority="P1"))
    )
    replies = []
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event("@AI交付助理 优先级调成 P1", mentions=[mention("ou_bot", "AI交付助理")], message_id="om_ai_missing_task")
    )

    assert result["action"] == "task_context_required"
    assert handler.store.list_tasks() == []
    assert replies == [("om_ai_missing_task", "请引用对应任务消息回复，或直接带上任务ID。")]


def test_plain_chat_does_not_create_task(handler):
    event = feishu_event("张三今天看看登录接口吧", mentions=[])

    result = handler.handle_event(event)

    assert result["handled"] is False
    assert handler.store.list_tasks() == []


def test_duplicate_source_message_is_idempotent(handler):
    event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )

    first = handler.handle_event(event)
    second = handler.handle_event(event)

    assert first["action"] == "task_created"
    assert second["action"] == "idempotent_skip"
    assert len(handler.store.list_tasks()) == 1


def test_multi_assignee_without_primary_owner_stays_draft(handler):
    event = feishu_event(
        "@AI交付助理 @张三 @李四 创建任务：完成支付联调",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三"), mention("ou_lisi", "李四")],
    )

    result = handler.handle_event(event)

    assert result["action"] == "pending_primary_owner"
    task = handler.store.list_tasks()[0]
    assert task["status"] == "pending_primary_owner"
    assert task["is_draft"] is True
    assert task["tapd_story_id"] is None


def test_owner_can_accept_task(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )
    created = handler.handle_event(create_event)

    accept_event = feishu_event(
        f"接受{created['tapd_story_id']}",
        message_id="om_2",
        chat_type="private",
        sender="ou_zhangsan",
        chat_id="oc_private_zhangsan",
    )
    result = handler.handle_event(accept_event)

    assert result["action"] == "accepted_by_owner"
    assert handler.store.list_tasks()[0]["status"] == "confirmed"


def test_private_standup_is_saved(handler):
    event = feishu_event(
        "【昨日完成】\n1. 完成登录接口错误码统一\n【今日计划】\n1. 联调前端\n【阻塞/需要帮助】\n无\n【风险/可能延期】\n无\n【需要决策】\n无",
        message_id="om_standup",
        chat_type="private",
        sender="ou_zhangsan",
        chat_id="oc_private_zhangsan",
    )

    result = handler.handle_event(event)

    assert result["action"] == "standup_saved"
    standups = handler.store.list_standups(date.today().isoformat())
    assert len(standups) == 1
    assert standups[0]["today_plan"] == ["联调前端"]


def test_private_reply_to_standup_prompt_uses_context(handler):
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_bot_standup",
            context_type="standup_prompt",
            created_at=utc_now_iso(),
            chat_id="oc_private_zhangsan",
            target_open_id="ou_zhangsan",
            metadata={"date": "2026-06-18"},
        )
    )
    event = feishu_event(
        "昨天修好了登录报错，今天继续联调前端，当前卡在测试环境。",
        message_id="om_reply_standup",
        chat_type="private",
        sender="ou_zhangsan",
        chat_id="oc_private_zhangsan",
        parent_id="om_bot_standup",
    )

    result = handler.handle_event(event)

    assert result["action"] == "standup_saved"
    standups = handler.store.list_standups(date.today().isoformat())
    assert standups[0]["today_plan"]


def test_dashboard_generation(handler):
    event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )
    handler.handle_event(event)

    result = handler.handle_event(
        feishu_event("@AI交付助理 生成今日进度看板", message_id="om_dashboard", mentions=[mention("ou_bot", "AI交付助理")])
    )

    assert result["action"] == "dashboard"
    assert result["artifact"].endswith(".html")


def test_private_reply_accept_uses_task_context(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )
    created = handler.handle_event(create_event)
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_bot_task",
            context_type="task_confirmation",
            created_at=utc_now_iso(),
            chat_id="oc_private_zhangsan",
            target_open_id="ou_zhangsan",
            task_id=created["task_id"],
            task_title="完成登录接口错误码统一",
            metadata={"tapd_story_id": created["tapd_story_id"]},
        )
    )

    accept_event = feishu_event(
        "接受",
        message_id="om_context_accept",
        chat_type="private",
        sender="ou_zhangsan",
        chat_id="oc_private_zhangsan",
        parent_id="om_bot_task",
    )
    result = handler.handle_event(accept_event)

    assert result["action"] == "accepted_by_owner"
    assert handler.store.list_tasks()[0]["status"] == "confirmed"


def test_private_plain_accept_without_context_requires_identifier(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_create_1",
    )
    handler.handle_event(create_event)
    second_event = feishu_event(
        "@AI交付助理 @张三 创建任务：补充错误码文档",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_create_2",
    )
    handler.handle_event(second_event)

    accept_event = feishu_event(
        "接受",
        message_id="om_ambiguous_accept",
        chat_type="private",
        sender="ou_zhangsan",
        chat_id="oc_private_zhangsan",
    )
    result = handler.handle_event(accept_event)

    assert result["action"] == "task_context_required"


def test_group_reply_acceptance_uses_task_context(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_group_create",
    )
    created = handler.handle_event(create_event)
    task = handler.store.get_task(created["task_id"])
    assert task is not None
    task["status"] = "owner_marked_done"
    handler.store.save_task(Task(**task))
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_group_acceptance",
            context_type="task_acceptance_prompt",
            created_at=utc_now_iso(),
            chat_id="oc_group",
            task_id=created["task_id"],
            task_title="完成登录接口错误码统一",
            metadata={"tapd_story_id": created["tapd_story_id"]},
        )
    )

    accept_event = feishu_event(
        "验收通过",
        message_id="om_group_accept",
        chat_type="group",
        sender="ou_creator",
        chat_id="oc_group",
        parent_id="om_group_acceptance",
    )
    result = handler.handle_event(accept_event)

    assert result["action"] == "accepted"
