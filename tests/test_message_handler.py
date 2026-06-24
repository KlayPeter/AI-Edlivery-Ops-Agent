from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from delivery_ops_bridge.adapters.feishu import WORKING_REACTION_EMOJI_TYPE, SendResult
from delivery_ops_bridge.adapters.llm import LLMResult
from delivery_ops_bridge.models import BotMessageContext, SourceMessage, Task, utc_now_iso
from delivery_ops_bridge.services.jobs import ScheduledJobs
from delivery_ops_bridge.services.scheduler import InProcessScheduler
from delivery_ops_bridge.services.message_intent import IntentFields, IntentTaskRef, MessageIntent
from delivery_ops_bridge.services.summaries import build_daily_summary, render_daily_summary
from tests.conftest import feishu_event, mention


class FakeIntentParser:
    def __init__(self, intent: MessageIntent):
        self.intent = intent
        self.calls = []

    def parse(self, message, reply_context, task_context, members):
        self.calls.append((message, reply_context, task_context, members))
        return self.intent


class FakeSummaryLLM:
    def __init__(self, items):
        self.items = items
        self.calls = []

    def chat(self, system_prompt, user_message):
        self.calls.append((system_prompt, user_message))
        return LLMResult(ok=True, content=json.dumps({"items": self.items}, ensure_ascii=False))


class FailingLLM:
    def chat(self, system_prompt, user_message):
        return LLMResult(ok=False, error="boom")


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
    assert tasks[0]["trace"]["source_message_id"] == tasks[0]["source_message_id"]
    assert tasks[0]["trace"]["raw_text"].startswith("@AI交付助理")
    assert tasks[0]["ai_result"]["type"] == "task_command"
    assert tasks[0]["confidence"] == 1.0


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
    assert result["reason"] == "not_directed_at_bot"
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


def test_explicit_create_missing_assignee_prompts_for_owner(handler):
    replies = []
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 创建任务：完成登录接口错误码统一",
            message_id="om_missing_assignee",
            mentions=[mention("ou_bot", "AI交付助理")],
        )
    )

    assert result["action"] == "task_field_missing"
    assert result["reason"] == "no_assignee_mentioned"
    assert replies == [("om_missing_assignee", "请 @ 任务负责人后再创建任务。")]


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
    source_message = handler.store.get_source_message("om_ai_priority")
    assert source_message["ai_result"]["parser"] == "llm"
    assert source_message["ai_result"]["intent"] == "update_task"
    assert source_message["confidence"] == 0.92
    updates = handler.store.list_task_updates(created["task_id"])
    ai_update = [item for item in updates if item["update_type"] == "ai_task_updated"][0]
    assert ai_update["trace"]["source_message_id"] == "om_ai_priority"
    assert ai_update["trace"]["raw_text"] == "@AI交付助理 优先级拉到 P1"
    assert ai_update["ai_result"]["type"] == "ai_task_updated"


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


def test_ai_create_task_requires_explicit_assignee_mention(handler):
    handler.intent_parser = FakeIntentParser(
        MessageIntent(
            intent="create_task",
            confidence=0.95,
            fields=IntentFields(title="整理登录接口问题", owner_open_id="ou_zhangsan"),
        )
    )

    result = handler.handle_event(
        feishu_event("@AI交付助理 帮我给张三建个任务整理登录接口问题", mentions=[mention("ou_bot", "AI交付助理")])
    )

    assert result["handled"] is True
    assert result["action"] == "task_field_missing"
    assert result["reason"] == "no_assignee_mentioned"
    assert handler.store.list_tasks() == []


def test_plain_chat_does_not_create_task(handler):
    event = feishu_event("张三今天看看登录接口吧", mentions=[])

    result = handler.handle_event(event)

    assert result["handled"] is False
    assert result["reason"] == "not_directed_at_bot"
    assert handler.store.list_tasks() == []


def test_unknown_private_user_notifies_admin(handler):
    private_messages = []
    group_messages = []
    handler.feishu.send_private_text = lambda open_id, text: private_messages.append((open_id, text)) or SendResult(ok=True, raw={})
    handler.feishu.send_group_text = lambda text, chat_id=None: group_messages.append((chat_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            "今天站会：完成登录接口",
            message_id="om_unknown_private",
            chat_type="private",
            sender="ou_unknown",
            chat_id="oc_private_unknown",
        )
    )

    assert result["action"] == "unknown_user"
    assert private_messages == [("ou_unknown", "暂未识别你的身份，请联系管理员完成成员绑定。")]
    assert group_messages and "无法识别私聊用户：ou_unknown" in group_messages[0][1]


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


def test_owner_can_request_clarification(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_clarify_create",
    )
    created = handler.handle_event(create_event)
    replies = []
    handler.feishu.send_private_text = lambda open_id, text: replies.append((open_id, text)) or SendResult(ok=True, raw={})
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            f"需要澄清{created['tapd_story_id']}，验收环境是哪一个？",
            message_id="om_clarify",
            chat_type="private",
            sender="ou_zhangsan",
            chat_id="oc_private_zhangsan",
        )
    )

    task = handler.store.get_task(created["task_id"])
    updates = handler.store.list_task_updates(created["task_id"])
    assert result["action"] == "clarification_requested"
    assert task["status"] == "pending_confirmation"
    assert any(item["update_type"] == "clarification_requested" for item in updates)
    assert any("澄清请求" in item[1] for item in replies)


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
    assert standups[0]["trace"]["source_message_id"] == "om_standup"
    assert standups[0]["raw_text"].startswith("【昨日完成】")
    assert standups[0]["ai_result"]["type"] == "standup"


def test_private_standup_links_task_progress_and_done_status(handler):
    created = handler.handle_event(
        feishu_event(
            "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
            mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
            message_id="om_standup_task_create",
        )
    )

    result = handler.handle_event(
        feishu_event(
            "【昨日完成】\n1. 登录接口错误码统一已完成\n【今日计划】\n1. 补充接口文档\n【阻塞/需要帮助】\n无\n【风险/可能延期】\n无\n【需要决策】\n无",
            message_id="om_standup_link",
            chat_type="private",
            sender="ou_zhangsan",
            chat_id="oc_private_zhangsan",
        )
    )

    assert result["linked_task_ids"] == [created["task_id"]]
    task = handler.store.get_task(created["task_id"])
    assert task["status"] == "owner_marked_done"
    updates = handler.store.list_task_updates(created["task_id"])
    assert any(item["source"] == "standup" and item["update_type"] == "progress" for item in updates)


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
    html = handler.config.data_path.joinpath("dashboards", result["artifact"].split("/")[-1]).read_text(encoding="utf-8")
    assert "状态统计" in html
    assert "阻塞事项" in html
    assert "风险提示" in html
    assert "今日站会摘要" in html


def test_group_command_generates_yesterday_daily_summary(handler):
    replies = []
    history_calls = []
    handler.feishu.fetch_chat_history = lambda chat_id, start_time, end_time, page_size=50: history_calls.append(
        (chat_id, start_time, end_time, page_size)
    ) or [
        SourceMessage(
            id="om_yesterday_summary_item",
            chat_id="oc_group",
            chat_type="group",
            sender_open_id="ou_zhangsan",
            sender_name="张三",
            text="测试环境无法登录，影响 App 回归，需要后端协助。资料：https://example.com/doc",
            message_type="text",
            sent_at="2026-06-17T10:00:00Z",
            raw_payload={"source": "history_sync"},
            mentions=[],
        )
    ]
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 生成昨日的日报",
            message_id="om_generate_yesterday_summary",
            mentions=[mention("ou_bot", "AI交付助理")],
        )
    )

    assert result["action"] == "daily_summary"
    assert result["date"] == "2026-06-17"
    assert history_calls
    assert replies[0][0] == "om_generate_yesterday_summary"
    assert "测试环境无法登录" in replies[0][1]
    assert "https://example.com/doc" in replies[0][1]
    assert handler.store.get_source_message("om_yesterday_summary_item") is not None


def test_group_command_generates_explicit_date_daily_summary(handler):
    replies = []
    handler.feishu.fetch_chat_history = lambda chat_id, start_time, end_time, page_size=50: [
        SourceMessage(
            id="om_date_summary_item",
            chat_id="oc_group",
            chat_type="group",
            sender_open_id="ou_zhangsan",
            sender_name="张三",
            text="结论：今天先暂停回归，等测试环境恢复。",
            message_type="text",
            sent_at="2026-06-16T10:00:00Z",
            raw_payload={"source": "history_sync"},
            mentions=[],
        )
    ]
    handler.feishu.send_reply_text = lambda message_id, text: replies.append((message_id, text)) or SendResult(ok=True, raw={})

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 生成 2026-06-16 的日报",
            message_id="om_generate_date_summary",
            mentions=[mention("ou_bot", "AI交付助理")],
        )
    )

    assert result["action"] == "daily_summary"
    assert result["date"] == "2026-06-16"
    assert replies[0][0] == "om_generate_date_summary"
    assert "今天先暂停回归" in replies[0][1]


def test_blocked_task_saves_structured_info_and_enters_views_after_24h(handler):
    created = handler.handle_event(
        feishu_event(
            "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
            mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
            message_id="om_blocked_create",
        )
    )

    result = handler.handle_event(
        feishu_event(
            "@AI交付助理 任务 登录接口错误码统一 阻塞了，原因：等待测试环境恢复，需要李四协助",
            mentions=[mention("ou_bot", "AI交付助理"), mention("ou_lisi", "李四")],
            message_id="om_blocked",
            sender="ou_zhangsan",
        )
    )

    task = handler.store.get_task(created["task_id"])
    assert result["action"] == "blocked"
    assert task["status"] == "blocked"
    assert task["blocker_info"]["reason"] == "等待测试环境恢复"
    assert task["blocker_info"]["blocked_by_name"] == "张三"
    assert task["blocker_info"]["assistance_needed"] == ["李四"]

    task["blocked_at"] = (datetime.utcnow() - timedelta(hours=25)).replace(microsecond=0).isoformat() + "Z"
    handler.store.save_task(Task(**task))
    artifact = handler.dashboard.generate(date.today())
    html = handler.config.data_path.joinpath("dashboards", artifact.html_path.split("/")[-1]).read_text(encoding="utf-8")
    summary = build_daily_summary(handler.store, "oc_group", date.today())

    assert "等待测试环境恢复" in html
    assert any(item["type"] == "blocker" and item["title"] == "完成登录接口错误码统一" for item in summary.blockers)


def test_overdue_scan_sends_staged_reminders_and_logs_status(handler):
    base_day = date(2026, 6, 22)
    task_ids = []
    for idx, (title, due) in enumerate(
        [
            ("明天到期", base_day + timedelta(days=1)),
            ("今天到期", base_day),
            ("超期一天", base_day - timedelta(days=1)),
            ("超期两天", base_day - timedelta(days=2)),
        ],
        1,
    ):
        created = handler.handle_event(
            feishu_event(
                f"@AI交付助理 @张三 创建任务：{title}",
                mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
                message_id=f"om_overdue_create_{idx}",
            )
        )
        task = handler.store.get_task(created["task_id"])
        task["due_date"] = due.isoformat()
        task["status"] = "confirmed"
        handler.store.save_task(Task(**task))
        task_ids.append(created["task_id"])

    private_messages = []
    group_messages = []
    handler.feishu.send_private_text = lambda open_id, text: private_messages.append((open_id, text)) or SendResult(ok=True, raw={})
    handler.feishu.send_group_text = lambda text, chat_id=None: group_messages.append((chat_id, text)) or SendResult(ok=True, raw={})
    jobs = ScheduledJobs(handler.config, handler.store, handler.feishu, handler.dashboard)

    result = jobs.overdue_scan(base_day)

    assert result == {"due_tomorrow": 1, "due_today": 1, "overdue_day1": 1, "overdue_risk": 1}
    assert len(private_messages) == 4
    assert any("明天截止" in text for _, text in private_messages)
    assert any("今天截止" in text for _, text in private_messages)
    assert any("超期 1 天" in text for _, text in private_messages)
    assert any("超期超过 2 天" in text for _, text in private_messages)
    assert len(group_messages) == 1
    assert "超期两天" in group_messages[0][1]
    assert handler.store.get_task(task_ids[2])["status"] == "overdue"
    assert handler.store.get_task(task_ids[3])["status"] == "overdue"
    assert any(item["update_type"] == "overdue" for item in handler.store.list_task_updates(task_ids[2]))

    private_messages.clear()
    group_messages.clear()
    second = jobs.overdue_scan(base_day)

    assert second == {"due_tomorrow": 0, "due_today": 0, "overdue_day1": 0, "overdue_risk": 0}
    assert private_messages == []
    assert group_messages == []


def test_standup_second_remind_and_mark_missing_records_missing_members(handler):
    private_messages = []
    handler.feishu.send_private_text = lambda open_id, text: private_messages.append((open_id, text)) or SendResult(ok=True, raw={})
    jobs = ScheduledJobs(handler.config, handler.store, handler.feishu, handler.dashboard)

    reminded = jobs.standup_second_remind(date(2026, 6, 22))
    marked = jobs.standup_mark_missing(date(2026, 6, 22))

    assert reminded == {"reminded": 3, "stage": "second"}
    assert marked == {"missing": 3}
    assert any("仍未提交" in text for _, text in private_messages)
    missing = handler.store.get_standup_missing("2026-06-22")
    assert missing["missing_names"] == ["Figo", "张三", "李四"]
    logs = (handler.config.data_path / "logs" / "audit.jsonl").read_text(encoding="utf-8")
    assert "standup_reminder_sent" in logs
    assert "standup_missing_marked" in logs


def test_daily_summary_backfills_group_history_before_rendering(handler):
    history_calls = []
    group_messages = []

    handler.feishu.fetch_chat_history = lambda chat_id, start_time, end_time, page_size=50: history_calls.append(
        (chat_id, start_time, end_time, page_size)
    ) or [
        SourceMessage(
            id="om_history_summary_1",
            chat_id="oc_group",
            chat_type="group",
            sender_open_id="ou_zhangsan",
            sender_name="张三",
            text="测试环境无法登录，影响 App 回归，需要后端协助。资料：https://example.com/doc",
            message_type="text",
            sent_at="2026-06-18T10:00:00Z",
            raw_payload={"source": "history_sync"},
            mentions=[],
        ),
        SourceMessage(
            id="om_history_summary_2",
            chat_id="oc_group",
            chat_type="group",
            sender_open_id="ou_zhangsan",
            sender_name="张三",
            text="@所有人 OSS 本月流量已经用到 95%，请上传大文件时尽量压缩。",
            message_type="text",
            sent_at="2026-06-18T11:00:00Z",
            raw_payload={"source": "history_sync"},
            mentions=[],
        ),
    ]
    handler.feishu.send_group_text = lambda text, chat_id=None: group_messages.append((chat_id, text)) or SendResult(ok=True, raw={})
    jobs = ScheduledJobs(handler.config, handler.store, handler.feishu, handler.dashboard)

    result = jobs.daily_summary(date(2026, 6, 18))

    assert result["summary_id"] == "summary-2026-06-18"
    assert history_calls
    assert handler.store.get_source_message("om_history_summary_1") is not None
    assert handler.store.get_source_message("om_history_summary_2") is not None
    assert group_messages
    assert "测试环境无法登录" in group_messages[0][1]
    assert "https://example.com/doc" in group_messages[0][1]
    logs = (handler.config.data_path / "logs" / "audit.jsonl").read_text(encoding="utf-8")
    assert "daily_summary_history_synced" in logs


def test_daily_summary_logs_history_sync_failure_and_falls_back(handler):
    group_messages = []
    handler.feishu.fetch_chat_history = lambda chat_id, start_time, end_time, page_size=50: (_ for _ in ()).throw(RuntimeError("history unavailable"))
    handler.feishu.send_group_text = lambda text, chat_id=None: group_messages.append((chat_id, text)) or SendResult(ok=True, raw={})
    handler.handle_event(feishu_event("测试环境无法登录。", message_id="om_summary_history_fallback", mentions=[]))
    jobs = ScheduledJobs(handler.config, handler.store, handler.feishu, handler.dashboard)

    jobs.daily_summary(date(2026, 6, 18))

    assert group_messages
    assert "测试环境无法登录" in group_messages[0][1]
    logs = (handler.config.data_path / "logs" / "audit.jsonl").read_text(encoding="utf-8")
    assert "daily_summary_history_sync_failed" in logs


def test_scheduler_runs_configured_job_once(handler):
    handler.config.schedule = {
        "standup_mark_missing": "11:00",
        "standup_mark_missing_enabled": True,
    }
    scheduler = InProcessScheduler(lambda: handler)

    first = scheduler.tick(datetime(2026, 6, 22, 11, 0))
    second = scheduler.tick(datetime(2026, 6, 22, 11, 0))

    assert first == {"standup-mark-missing": "completed"}
    assert second == {}
    assert handler.store.get_standup_missing("2026-06-22")["missing"] == 3


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


def test_private_reply_to_plan_request_saves_structured_task_plan(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
    )
    created = handler.handle_event(create_event)
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_bot_plan",
            context_type="task_plan_request",
            created_at=utc_now_iso(),
            chat_id="oc_private_zhangsan",
            target_open_id="ou_zhangsan",
            task_id=created["task_id"],
            task_title="完成登录接口错误码统一",
            metadata={"tapd_story_id": created["tapd_story_id"]},
        )
    )

    result = handler.handle_event(
        feishu_event(
            "预计完成时间：明天\n拆分步骤：\n1. 统一错误码\n2. 更新接口文档\n依赖对象：前端联调环境\n风险点：测试环境不稳定\n是否需要协助：否",
            message_id="om_plan_reply",
            chat_type="private",
            sender="ou_zhangsan",
            chat_id="oc_private_zhangsan",
            parent_id="om_bot_plan",
        )
    )

    task = handler.store.get_task(created["task_id"])
    assert result["action"] == "task_plan_saved"
    assert task["task_plan"]["estimated_time"] == "明天"
    assert task["task_plan"]["steps"] == ["统一错误码", "更新接口文档"]
    assert task["task_plan"]["dependencies"] == ["前端联调环境"]
    assert task["task_plan"]["risks"] == ["测试环境不稳定"]
    assert task["task_plan"]["need_help"] is False


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


def test_group_acceptance_requires_task_creator(handler):
    create_event = feishu_event(
        "@AI交付助理 @张三 创建任务：完成登录接口错误码统一",
        mentions=[mention("ou_bot", "AI交付助理"), mention("ou_zhangsan", "张三")],
        message_id="om_group_create_creator_only",
    )
    created = handler.handle_event(create_event)
    task = handler.store.get_task(created["task_id"])
    task["status"] = "owner_marked_done"
    handler.store.save_task(Task(**task))
    handler.store.save_bot_message_context(
        BotMessageContext(
            message_id="om_group_acceptance_creator_only",
            context_type="task_acceptance_prompt",
            created_at=utc_now_iso(),
            chat_id="oc_group",
            task_id=created["task_id"],
            task_title="完成登录接口错误码统一",
        )
    )

    result = handler.handle_event(
        feishu_event(
            "验收通过",
            message_id="om_group_accept_by_other",
            chat_type="group",
            sender="ou_lisi",
            chat_id="oc_group",
            parent_id="om_group_acceptance_creator_only",
        )
    )

    assert result["action"] == "unauthorized"
    assert handler.store.get_task(created["task_id"])["status"] == "owner_marked_done"


def test_daily_summary_classifies_group_messages_with_traceability(handler):
    handler.handle_event(
        feishu_event(
            "测试环境无法登录，影响 App 回归，需要后端协助。结论：今天先暂停回归。资料：https://example.com/doc",
            message_id="om_summary_trace",
            mentions=[],
        )
    )

    summary = build_daily_summary(handler.store, "oc_group", date(2026, 6, 18))
    rendered = render_daily_summary(summary)

    assert summary.blockers[0]["source_message_ids"] == ["om_summary_trace"]
    assert summary.blockers[0]["confidence"] > 0
    assert summary.decisions[0]["source_message_ids"] == ["om_summary_trace"]
    assert summary.risks[0]["source_message_ids"] == ["om_summary_trace"]
    assert summary.shares[0]["source_message_ids"] == ["om_summary_trace"]
    assert "四、决策结论" in rendered
    assert "六、资料分享" in rendered


def test_daily_summary_prefers_ai_classification_with_traceability(handler):
    handler.handle_event(
        feishu_event(
            "测试环境登录失败，今天回归被挡住。",
            message_id="om_summary_ai",
            mentions=[],
        )
    )
    llm = FakeSummaryLLM(
        [
            {
                "message_id": "om_summary_ai",
                "type": "blocker",
                "title": "测试环境登录阻塞",
                "related_users": ["张三"],
                "risk_level": "high",
                "confidence": 0.91,
            }
        ]
    )

    summary = build_daily_summary(handler.store, "oc_group", date(2026, 6, 18), llm)

    assert llm.calls
    assert summary.blockers[0]["title"] == "测试环境登录阻塞"
    assert summary.blockers[0]["ai_result"]["parser"] == "llm_daily_summary"
    assert summary.blockers[0]["confidence"] == 0.91
    assert summary.blockers[0]["trace"]["source_message_id"] == "om_summary_ai"
    assert summary.blockers[0]["trace"]["raw_text"] == "测试环境登录失败，今天回归被挡住。"


def test_daily_summary_ai_confidence_filter_and_possible_label(handler):
    handler.handle_event(feishu_event("测试环境登录失败。", message_id="om_summary_medium", mentions=[]))
    handler.handle_event(feishu_event("无效闲聊。", message_id="om_summary_low", mentions=[]))
    llm = FakeSummaryLLM(
        [
            {"message_id": "om_summary_medium", "type": "blocker", "title": "测试环境阻塞", "confidence": 0.7},
            {"message_id": "om_summary_low", "type": "risk", "title": "低置信风险", "confidence": 0.5},
        ]
    )

    summary = build_daily_summary(handler.store, "oc_group", date(2026, 6, 18), llm)

    assert [item["title"] for item in summary.blockers] == ["可能：测试环境阻塞"]
    assert summary.risks == []


def test_daily_summary_logs_ai_failures_and_falls_back_to_rules(handler):
    handler.handle_event(feishu_event("测试环境无法登录。", message_id="om_summary_ai_fail", mentions=[]))

    summary = build_daily_summary(handler.store, "oc_group", date(2026, 6, 18), FailingLLM())

    assert summary.blockers
    logs = (handler.config.data_path / "logs" / "audit.jsonl").read_text(encoding="utf-8")
    assert "ai_daily_summary_failed" in logs
