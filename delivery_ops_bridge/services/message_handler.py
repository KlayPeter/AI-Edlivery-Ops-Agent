from __future__ import annotations

import re
import time
from datetime import date
from typing import Any, Dict, List, Optional

from ..adapters.feishu import WORKING_REACTION_EMOJI_TYPE, WORKING_REACTION_EMOJI_TYPES, FeishuAdapter, FeishuEventParser
from ..adapters.tapd import TapdAdapter
from ..config import AppConfig
from ..models import (
    BotMessageContext,
    Mention,
    SourceMessage,
    Standup,
    Task,
    TaskUpdate,
    TASK_STATUS_ACCEPTED,
    TASK_STATUS_BLOCKED,
    TASK_STATUS_CANCELLED,
    TASK_STATUS_CONFIRMED,
    TASK_STATUS_IN_PROGRESS,
    TASK_STATUS_OWNER_MARKED_DONE,
    TASK_STATUS_PENDING_CONFIRMATION,
    TASK_STATUS_PENDING_PRIMARY_OWNER,
    utc_now_iso,
)
from ..storage import JsonStore
from .dashboard import DashboardService
from .message_intent import IntentFields, MessageIntent, MessageIntentParser
from .standup import looks_like_standup, parse_standup
from .task_parser import ParsedTaskCommand, has_task_intent, parse_due_date_text, parse_task_command


TAPD_STATUS_IN_PROGRESS = "status_14"
TAPD_STATUS_TESTING = "status_3"
TAPD_STATUS_DONE = "status_5"
TAPD_STATUS_CANCELLED = "status_20"
TAPD_STATUS_BLOCKED = "workflow_suspended"
WORKING_REACTION_MIN_SECONDS = 1.2
AI_CONFIDENCE_THRESHOLD = 0.85
PRIORITY_TO_TAPD_LABEL = {"P0": "High", "P1": "High", "P2": "Middle", "P3": "Low"}


class MessageHandler:
    def __init__(
        self,
        config: AppConfig,
        store: JsonStore,
        feishu: FeishuAdapter,
        tapd: TapdAdapter,
        dashboard: DashboardService,
        intent_parser: MessageIntentParser | None = None,
    ):
        self.config = config
        self.store = store
        self.feishu = feishu
        self.tapd = tapd
        self.dashboard = dashboard
        self.intent_parser = intent_parser
        self.parser = FeishuEventParser(
            bot_open_id=config.feishu.bot_open_id,
            known_names={member.open_id: member.name for member in config.members},
        )

    def handle_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        message = self.parser.parse(payload)
        if message is None:
            return {"handled": False, "reason": "not_message_event"}

        reply_context = self._resolve_reply_context(message)
        is_explicit = message.chat_type == "p2p" or reply_context is not None or any(m.open_id == self.config.feishu.bot_open_id for m in message.mentions)

        reaction_id, reaction_started_at = None, time.monotonic()
        if is_explicit:
            reaction_id, reaction_started_at = self._add_working_reaction(message)
        try:
            self.store.save_source_message(message)
            self.store.append_audit_log("source_message_received", {
                "message_id": message.id, 
                "chat_id": message.chat_id,
                "chat_type": message.chat_type,
                "sent_at": message.sent_at,
                "sender": message.sender_name,
                "text": message.text[:200]
            })

            if self._is_system_noise(message.text):
                return {"handled": False, "reason": "system_noise"}
            if message.chat_type == "group":
                return self._handle_group_message(message, reply_context)
            return self._handle_private_message(message, reply_context)
        finally:
            if reaction_id:
                if not self.feishu.dry_run:
                    elapsed = time.monotonic() - reaction_started_at
                    if elapsed < WORKING_REACTION_MIN_SECONDS:
                        time.sleep(WORKING_REACTION_MIN_SECONDS - elapsed)
                self.feishu.remove_reaction(message.id, reaction_id)

    def _handle_group_message(self, message: SourceMessage, reply_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if reply_context is None:
            reply_context = self._resolve_reply_context(message)
            
        if reply_context and reply_context.get("context_type") == "missing_task_field":
            original_text = reply_context.get("metadata", {}).get("original_text", "")
            if original_text:
                message.text = f"{original_text} {message.text}"

        if "生成今日进度看板" in message.text or "生成看板" in message.text or "进度看板" in message.text:
            artifact = self.dashboard.generate()
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
            self.feishu.send_reply_text(message.id, text)
            self.store.append_audit_log("dashboard_generated", {"artifact_path": artifact.html_path, "public_url": artifact.public_url})
            return {"handled": True, "action": "dashboard", "artifact": artifact.html_path}

        status_result = self._maybe_handle_status_update(message, source="group", reply_context=reply_context)
        if status_result:
            return status_result

        command = parse_task_command(message.text, message.mentions, self.config.feishu.bot_open_id)
        if not command.should_create:
            field_result = self._maybe_reply_missing_task_field(message, "group", command.reason) if has_task_intent(message.text) else None
            if field_result:
                return field_result
            ai_result = self._maybe_handle_ai_intent(message, "group", reply_context)
            if ai_result:
                return ai_result
            is_explicit = any(m.open_id == self.config.feishu.bot_open_id for m in message.mentions) or reply_context is not None
            if is_explicit:
                self._reply(message, "group", "抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n- 创建/安排任务\n- 对我回复接受、打回、完成某任务\n- 回复具体进度")
                return {"handled": True, "action": "unrecognized_command", "reason": command.reason}
            return {"handled": False, "reason": "not_directed_at_bot"}
        key = f"{message.id}:create_task"
        if self.store.has_idempotency_key(key):
            return {"handled": True, "action": "idempotent_skip"}
        message.ai_result = {
            "type": "task_command",
            "parser": "rule",
            "reason": command.reason,
            "title": command.title,
            "priority": command.priority,
            "due_date": command.due_date,
        }
        message.confidence = 1.0
        self.store.save_source_message(message)
        result = self._create_task_from_command(message, command)
        self.store.set_idempotency_key(key, result)
        return result

    def _handle_private_message(self, message: SourceMessage, reply_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if reply_context is None:
            reply_context = self._resolve_reply_context(message)
        sender = self._resolve_private_sender(message)
        if sender:
            message.sender_open_id = sender.open_id
            message.sender_name = sender.name
            self.store.save_source_message(message)
        elif message.sender_open_id:
            self.feishu.send_group_text(
                f"无法识别私聊用户：{message.sender_open_id}。请管理员在配置 members 中绑定该用户后再处理。",
                self.config.feishu.group_chat_id,
            )
            self.feishu.send_private_text(message.sender_open_id, "暂未识别你的身份，请联系管理员完成成员绑定。")
            self.store.append_audit_log("unknown_user", {"open_id": message.sender_open_id, "chat_id": message.chat_id})
            return {"handled": True, "action": "unknown_user"}
        reply_context = self._resolve_reply_context(message)
        
        if reply_context and reply_context.get("context_type") == "missing_task_field":
            original_text = reply_context.get("metadata", {}).get("original_text", "")
            if original_text:
                message.text = f"{original_text} {message.text}"

        if self._should_treat_as_standup(message, reply_context):
            standup = parse_standup(message.sender_open_id, message.sender_name, message.text, message.id)
            standup.ai_result = {"type": "standup", "parser": "structured_or_natural_language"}
            standup.confidence = 1.0
            standup.trace = self._source_trace(message, standup.ai_result, standup.confidence)
            standup.source_group_id = standup.trace["source_group_id"]
            standup.source_sender_open_id = standup.trace["sender_open_id"]
            standup.source_sender_name = standup.trace["sender_name"]
            standup.source_sent_at = standup.trace["sent_at"]
            message.ai_result = standup.ai_result
            message.confidence = standup.confidence
            self.store.save_source_message(message)
            self.store.save_standup(standup)
            linked = self._link_standup_to_tasks(standup, message)
            self.feishu.send_private_text(message.sender_open_id, "已收到今日站会，谢谢。")
            self.store.append_audit_log(
                "standup_saved",
                {"open_id": standup.open_id, "standup_id": standup.id, "linked_task_ids": linked},
            )
            return {"handled": True, "action": "standup_saved", "standup_id": standup.id, "linked_task_ids": linked}
        status_result = self._maybe_handle_status_update(message, source="private", reply_context=reply_context)
        if status_result:
            return status_result
        ai_result = self._maybe_handle_ai_intent(message, "private", reply_context)
        if ai_result:
            return ai_result
        self._reply(message, "private", "抱歉，我没有识别到有效的指令。\n你可以对我说：创建任务、安排一下，或者向我发送今日站会报告。")
        return {"handled": True, "action": "unrecognized_command", "reason": "no_private_command"}

    def _maybe_reply_missing_task_field(self, message: SourceMessage, source: str, reason: str) -> Optional[Dict[str, Any]]:
        prompts = {
            "no_assignee_mentioned": "请 @ 任务负责人后再创建任务。",
            "missing_title": "请补充任务标题，例如：@AI交付助理 @张三 创建任务：完成登录接口错误码统一。",
        }
        text = prompts.get(reason)
        if not text:
            return None
        res = self._reply(message, source, text)
        if res and res.message_id:
            self.store.save_bot_message_context(
                BotMessageContext(
                    message_id=res.message_id,
                    context_type="missing_task_field",
                    created_at=utc_now_iso(),
                    chat_id=message.chat_id,
                    metadata={"original_text": message.text}
                )
            )
        self.store.append_audit_log("task_field_missing", {"message_id": message.id, "reason": reason})
        return {"handled": True, "action": "task_field_missing", "reason": reason}

    def _create_task_from_command(self, message: SourceMessage, command: ParsedTaskCommand) -> Dict[str, Any]:
        if command.missing_primary_owner:
            task = self._build_task(message, command, status=TASK_STATUS_PENDING_PRIMARY_OWNER, tapd_story_id=None, tapd_url=None)
            task.is_draft = True
            self.store.save_task(task)
            assignees = "、".join(command.assignee_names if hasattr(command, "assignee_names") else [item.name for item in command.assignees])
            res = self.feishu.send_reply_text(
                message.id,
                f"已识别到多人任务，请指定主负责人：\n\n任务：{command.title}\n参与人：{assignees}\n\n请回复：主负责人 @某某",
            )
            if res.message_id:
                self.store.save_bot_message_context(
                    BotMessageContext(
                        message_id=res.message_id,
                        context_type="pending_primary_owner",
                        created_at=utc_now_iso(),
                        chat_id=message.chat_id,
                        task_id=task.id,
                        task_title=task.title,
                    )
                )
            return {"handled": True, "action": "pending_primary_owner", "task_id": task.id}

        if command.is_independent and len(command.assignees) > 1:
            owner = command.primary_owner or command.assignees[0]
            description = self._task_description(message, command)
            tapd_result = self.tapd.create_story(
                title=f"父任务：{command.title}",
                owner=owner.name,
                priority_label=command.tapd_priority_label,
                due_date=command.due_date,
                description=description,
            )
            tapd_story_id = tapd_result.story_id if tapd_result.ok else None
            tapd_url = tapd_result.url if tapd_result.ok else None

            parent = self._build_task(message, command, status=TASK_STATUS_PENDING_CONFIRMATION, tapd_story_id=tapd_story_id, tapd_url=tapd_url)
            parent.title = f"父任务：{command.title}"
            parent.is_draft = True
            self.store.save_task(parent)

            child_ids: List[str] = []
            for assignee in command.assignees:
                child_command = ParsedTaskCommand(
                    should_create=True,
                    reason="ok",
                    title=f"{assignee.name}：{command.title}",
                    primary_owner=assignee,
                    assignees=[assignee],
                    priority=command.priority,
                    tapd_priority_label=command.tapd_priority_label,
                    due_date=command.due_date,
                    acceptance_criteria=command.acceptance_criteria,
                    description=command.description,
                )
                child = self._create_single_task(message, child_command, parent_id=tapd_story_id)
                child_ids.append(child["task_id"])
            self.feishu.send_reply_text(message.id, f"已创建父任务和 {len(child_ids)} 个子任务，等待各负责人确认。")
            return {"handled": True, "action": "independent_tasks_created", "parent_id": parent.id, "child_ids": child_ids}

        return self._create_single_task(message, command)

    def _create_single_task(self, message: SourceMessage, command: ParsedTaskCommand, parent_id: str | None = None) -> Dict[str, Any]:
        owner = command.primary_owner
        assert owner is not None
        description = self._task_description(message, command)
        tapd_result = self.tapd.create_story(
            title=command.title,
            owner=owner.name,
            priority_label=command.tapd_priority_label,
            due_date=command.due_date,
            description=description,
            parent_id=parent_id,
        )
        if not tapd_result.ok:
            self.store.append_audit_log("tapd_create_failed", {"message_id": message.id, "error": tapd_result.error})
            self.feishu.send_reply_text(message.id, f"任务创建失败：{tapd_result.error or 'TAPD API 调用失败'}")
            return {"handled": True, "action": "tapd_create_failed", "error": tapd_result.error}

        task = self._build_task(
            message,
            command,
            status=TASK_STATUS_PENDING_CONFIRMATION,
            tapd_story_id=tapd_result.story_id,
            tapd_url=tapd_result.url,
            parent_id=parent_id,
        )
        self.store.save_task(task)
        self._save_update(task, message.sender_open_id, message.sender_name, "created", "任务已创建", "group", message.id)
        private_text = self._private_confirmation_text(task)
        private_result = self.feishu.send_private_text(owner.open_id, private_text)
        if private_result.chat_id:
            self.store.update_chat_id(owner.open_id, private_result.chat_id)
        if private_result.message_id:
            self.store.save_bot_message_context(
                BotMessageContext(
                    message_id=private_result.message_id,
                    context_type="task_confirmation",
                    created_at=utc_now_iso(),
                    chat_id=private_result.chat_id or "",
                    target_open_id=owner.open_id,
                    task_id=task.id,
                    task_title=task.title,
                    metadata={"tapd_story_id": task.tapd_story_id or ""},
                )
            )
        group_result = self.feishu.send_reply_text(message.id, self._group_created_text(task))
        if group_result.message_id:
            self.store.save_bot_message_context(
                BotMessageContext(
                    message_id=group_result.message_id,
                    context_type="task_group_notice",
                    created_at=utc_now_iso(),
                    chat_id=message.chat_id,
                    task_id=task.id,
                    task_title=task.title,
                    metadata={"tapd_story_id": task.tapd_story_id or ""},
                )
            )
        self.store.append_audit_log("task_created", {"task_id": task.id, "title": task.title, "owner": owner.name, "tapd_id": task.tapd_story_id})
        return {"handled": True, "action": "task_created", "task_id": task.id, "tapd_story_id": task.tapd_story_id}

    def _maybe_handle_status_update(
        self,
        message: SourceMessage,
        source: str,
        reply_context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        text = self._strip_bot_mention(message).strip()

        if reply_context and reply_context.get("context_type") == "pending_primary_owner":
            match = re.search(r"主负责人\s*", text)
            if match:
                target_mention = next((m for m in message.mentions if m.open_id != self.config.feishu.bot_open_id), None)
                if not target_mention:
                    self._reply(message, source, "请 @ 出主负责人。")
                    return {"handled": True, "action": "missing_mention"}

                task_id = reply_context.get("task_id")
                task_data = self.store.get_task(task_id)
                if not task_data:
                    return {"handled": True, "action": "task_not_found"}

                task_data["primary_owner_open_id"] = target_mention.open_id
                task_data["primary_owner_name"] = target_mention.name
                if target_mention.open_id not in task_data.get("assignee_open_ids", []):
                    task_data.setdefault("assignee_open_ids", []).append(target_mention.open_id)
                    task_data.setdefault("assignee_names", []).append(target_mention.name)

                original_msg = message

                command = ParsedTaskCommand(
                    should_create=True,
                    reason="owner_specified",
                    title=task_data.get("title", "未命名任务"),
                    primary_owner=target_mention,
                    assignees=[Mention(open_id=oid, name=n) for oid, n in zip(task_data["assignee_open_ids"], task_data["assignee_names"])],
                    priority=task_data.get("priority", "P2"),
                    tapd_priority_label=PRIORITY_TO_TAPD_LABEL.get(task_data.get("priority", "P2"), "Middle"),
                    due_date=task_data.get("due_date"),
                    acceptance_criteria=task_data.get("acceptance_criteria", []),
                    description=task_data.get("description", ""),
                )

                description = self._task_description(original_msg, command)
                tapd_result = self.tapd.create_story(
                    title=command.title,
                    owner=target_mention.name,
                    priority_label=command.tapd_priority_label,
                    due_date=command.due_date,
                    description=description,
                    parent_id=task_data.get("parent_id"),
                )

                if not tapd_result.ok:
                    self.store.append_audit_log("tapd_create_failed", {"message_id": message.id, "error": tapd_result.error})
                    self.feishu.send_reply_text(message.id, f"任务创建失败：{tapd_result.error or 'TAPD API 调用失败'}")
                    return {"handled": True, "action": "tapd_create_failed", "error": tapd_result.error}

                task_data["tapd_story_id"] = tapd_result.story_id
                task_data["tapd_url"] = tapd_result.url
                task_data["status"] = TASK_STATUS_PENDING_CONFIRMATION
                task_data["is_draft"] = False
                task_data["updated_at"] = utc_now_iso()

                task = Task(**task_data)
                self.store.save_task(task)

                self._save_update(task, message.sender_open_id, message.sender_name, "primary_owner_set", f"指定主负责人：{target_mention.name}", source, message.id)

                private_text = self._private_confirmation_text(task)
                private_result = self.feishu.send_private_text(target_mention.open_id, private_text)
                if private_result.chat_id:
                    self.store.update_chat_id(target_mention.open_id, private_result.chat_id)
                if private_result.message_id:
                    self.store.save_bot_message_context(
                        BotMessageContext(
                            message_id=private_result.message_id,
                            context_type="task_confirmation",
                            created_at=utc_now_iso(),
                            chat_id=private_result.chat_id or "",
                            target_open_id=target_mention.open_id,
                            task_id=task.id,
                            task_title=task.title,
                            metadata={"tapd_story_id": task.tapd_story_id or ""},
                        )
                    )
                group_result = self.feishu.send_reply_text(message.id, self._group_created_text(task))
                if group_result.message_id:
                    self.store.save_bot_message_context(
                        BotMessageContext(
                            message_id=group_result.message_id,
                            context_type="task_group_notice",
                            created_at=utc_now_iso(),
                            chat_id=message.chat_id,
                            task_id=task.id,
                            task_title=task.title,
                            metadata={"tapd_story_id": task.tapd_story_id or ""},
                        )
                    )
                self.store.append_audit_log("task_created_after_owner_set", {"task_id": task.id, "title": task.title, "owner": target_mention.name})
                return {"handled": True, "action": "task_created", "task_id": task.id}

        match = re.search(r"(接受|拒绝|需要澄清|验收通过|打回)\s*([A-Za-z0-9_-]+|\d{6,})", text)
        if match:
            action, identifier = match.group(1), match.group(2)
            task_data = self.store.find_task(identifier)
            if not task_data:
                self._reply(message, source, "没有找到对应任务，请带上任务ID或TAPD Story ID。")
                return {"handled": True, "action": "task_not_found"}
            return self._apply_action(message, source, task_data, action, text)

        contextual_task = self._contextual_task(message, reply_context, normalized_text=text)
        if contextual_task and reply_context and reply_context.get("context_type") == "task_plan_request":
            return self._save_task_plan(message, source, contextual_task, text)

        due_date = self._parse_due_date_update(text, allow_colon=bool(contextual_task))
        if due_date and contextual_task:
            return self._update_task_due_date(message, source, contextual_task, due_date, text)
        if due_date and not contextual_task:
            self._reply(message, source, "请引用对应任务消息回复，或直接带上任务ID。")
            return {"handled": True, "action": "task_context_required"}

        context_action = re.match(r"^\s*(接受|拒绝|需要澄清|验收通过|打回)(?:[:：].+)?\s*$", text)
        if context_action and contextual_task:
            return self._apply_action(message, source, contextual_task, context_action.group(1), text)
        if context_action and not contextual_task:
            self._reply(message, source, "请引用对应任务消息回复，或直接带上任务ID。")
            return {"handled": True, "action": "task_context_required"}

        match = re.search(r"任务\s+(.+?)\s*(已完成|完成了|阻塞了|阻塞|进度[:：])(.+)?", text)
        if match:
            title = match.group(1).strip()
            task_data = self._find_task_by_title(title)
            if not task_data:
                self._reply(message, source, "没有找到对应任务，请带上任务ID或更完整的任务标题。")
                return {"handled": True, "action": "task_not_found"}
            status_word = match.group(2)
            content = text
            if "阻塞" in status_word:
                return self._set_task_status(message, source, task_data, TASK_STATUS_BLOCKED, "blocked", content, TAPD_STATUS_BLOCKED)
            if "完成" in status_word:
                return self._set_task_status(message, source, task_data, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", content, TAPD_STATUS_TESTING)
            return self._save_progress(message, source, task_data, content)

        direct_match = re.match(r"(.+?)\s*(已完成|完成了|阻塞了|阻塞|进度[:：])(.+)?$", text)
        if direct_match:
            title = direct_match.group(1).strip()
            if title and title not in {"任务", "这个任务", "该任务"}:
                task_data = self._find_task_by_title(title)
                if task_data:
                    status_word = direct_match.group(2)
                    content = text
                    if "阻塞" in status_word:
                        return self._set_task_status(message, source, task_data, TASK_STATUS_BLOCKED, "blocked", content, TAPD_STATUS_BLOCKED)
                    if "完成" in status_word:
                        return self._set_task_status(message, source, task_data, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", content, TAPD_STATUS_TESTING)
                    return self._save_progress(message, source, task_data, content)

        if contextual_task:
            if re.search(r"(已完成|完成了)", text) and not re.search(r"(没|不|未)完成", text):
                return self._set_task_status(message, source, contextual_task, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", text, TAPD_STATUS_TESTING)
            if re.search(r"(阻塞|阻塞了)", text) and not re.search(r"(不|没|未)阻塞", text):
                return self._set_task_status(message, source, contextual_task, TASK_STATUS_BLOCKED, "blocked", text, TAPD_STATUS_BLOCKED)
            if text.startswith("进度") or reply_context and reply_context.get("context_type") == "task_confirmation":
                return self._save_progress(message, source, contextual_task, text)
        return None

    def _apply_action(self, message: SourceMessage, source: str, task_data: Dict[str, Any], action: str, text: str) -> Dict[str, Any]:
        if action in {"接受", "拒绝", "需要澄清"} and message.sender_open_id != task_data.get("primary_owner_open_id"):
            self._reply(message, source, "只有任务负责人可以确认、拒绝或要求澄清该任务。")
            return {"handled": True, "action": "unauthorized"}
        if action in {"验收通过", "打回"} and message.sender_open_id != task_data.get("creator_open_id"):
            self._reply(message, source, "只有任务创建人可以验收或打回该任务。")
            return {"handled": True, "action": "unauthorized"}
        if action == "接受":
            return self._set_task_status(message, source, task_data, TASK_STATUS_CONFIRMED, "accepted_by_owner", text, TAPD_STATUS_IN_PROGRESS)
        if action == "拒绝":
            return self._set_task_status(message, source, task_data, TASK_STATUS_CANCELLED, "rejected_by_owner", text, TAPD_STATUS_CANCELLED)
        if action == "需要澄清":
            return self._request_clarification(message, source, task_data, text)
        if action == "验收通过":
            return self._set_task_status(message, source, task_data, TASK_STATUS_ACCEPTED, "accepted", text, TAPD_STATUS_DONE)
        if action == "打回":
            return self._set_task_status(message, source, task_data, TASK_STATUS_IN_PROGRESS, "reopened", text, TAPD_STATUS_IN_PROGRESS)
        return {"handled": False, "reason": "unknown_action"}

    def _set_task_status(
        self,
        message: SourceMessage,
        source: str,
        task_data: Dict[str, Any],
        status: str,
        update_type: str,
        content: str,
        tapd_status: str | None,
    ) -> Dict[str, Any]:
        tapd_error_msg = ""
        if tapd_status and task_data.get("tapd_story_id"):
            tapd_result = self.tapd.update_story_status(task_data["tapd_story_id"], tapd_status)
            if not tapd_result.ok:
                self.store.append_audit_log("tapd_update_failed", {"task_id": task_data["id"], "error": tapd_result.error})
                tapd_error_msg = "\n(⚠️ 注：同步至TAPD状态失败，可能任务已被删除)"
        if status == TASK_STATUS_BLOCKED:
            blocked_at = task_data.get("blocked_at") or utc_now_iso()
            task_data["blocked_at"] = blocked_at
            task_data["blocker_info"] = self._parse_blocker_info(content, message, blocked_at)
        else:
            task_data["blocked_at"] = None
            task_data["blocker_info"] = {}
        task_data["status"] = status
        task_data["updated_at"] = utc_now_iso()
        task = Task(**task_data)
        self.store.save_task(task)
        metadata = task.blocker_info if update_type == "blocked" else {}
        self._save_update(task, message.sender_open_id, message.sender_name, update_type, content, source, message.id, metadata)
        if update_type == "accepted_by_owner":
            result = self.feishu.send_private_text(
                task.primary_owner_open_id,
                f"已确认接受任务：{task.title}{tapd_error_msg}\n请补充任务计划：\n\n预计完成时间：\n拆分步骤：\n依赖对象：\n风险点：\n是否需要协助：",
            )
            if result.message_id:
                self.store.save_bot_message_context(
                    BotMessageContext(
                        message_id=result.message_id,
                        context_type="task_plan_request",
                        created_at=utc_now_iso(),
                        chat_id=result.chat_id or "",
                        target_open_id=task.primary_owner_open_id,
                        task_id=task.id,
                        task_title=task.title,
                        metadata={"tapd_story_id": task.tapd_story_id or ""},
                    )
                )
            if source == "private" and task.source_message_id:
                self._notify_source_group(task, f"负责人 {message.sender_name} 已接受任务：{task.title}{tapd_error_msg}")
        elif update_type == "owner_marked_done":
            text = f"{task.primary_owner_name} 已标记任务完成，等待创建人验收：{task.title}{tapd_error_msg}\n可直接引用本消息回复：验收通过 / 打回"
            target_chat_id = message.chat_id if source == "group" else self.config.feishu.group_chat_id
            if source == "group":
                result = self.feishu.send_reply_text(message.id, text)
            else:
                result = self.feishu.send_group_text(text, target_chat_id)
            if result.message_id:
                self.store.save_bot_message_context(
                    BotMessageContext(
                        message_id=result.message_id,
                        context_type="task_acceptance_prompt",
                        created_at=utc_now_iso(),
                        chat_id=target_chat_id,
                        task_id=task.id,
                        task_title=task.title,
                        metadata={"tapd_story_id": task.tapd_story_id or ""},
                    )
                )
        else:
            self._reply(message, source, f"任务状态已更新：{task.title} -> {status}{tapd_error_msg}")
            if source == "private" and task.source_message_id:
                action_text = content.strip() if content.strip() else status
                self._notify_source_group(task, f"负责人 {message.sender_name} 更新了任务状态：{status}{tapd_error_msg}\n回复内容：{action_text}")
        self.store.append_audit_log("task_status_updated", {"task_id": task.id, "status": status, "update_type": update_type})
        return {"handled": True, "action": update_type, "task_id": task.id, "status": status}

    def _request_clarification(self, message: SourceMessage, source: str, task_data: Dict[str, Any], content: str) -> Dict[str, Any]:
        task = Task(**task_data)
        self._save_update(task, message.sender_open_id, message.sender_name, "clarification_requested", content, source, message.id)
        self._reply(message, source, f"已记录澄清请求：{task.title}")
        notice = f"负责人 {message.sender_name} 对任务提出澄清请求：{task.title}\n回复内容：{content}"
        if source == "private" and task.source_message_id:
            self._notify_source_group(task, notice)
        elif source == "group":
            self.feishu.send_reply_text(message.id, notice)
        self.store.append_audit_log("task_clarification_requested", {"task_id": task.id, "source_message_id": message.id})
        return {"handled": True, "action": "clarification_requested", "task_id": task.id, "status": task.status}

    def _maybe_handle_ai_intent(
        self,
        message: SourceMessage,
        source: str,
        reply_context: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if not self.intent_parser or not self._should_consider_ai(message, source, reply_context):
            return None

        contextual_task = self._task_from_reply_context(reply_context)
        intent = self.intent_parser.parse(message, reply_context, contextual_task, self.config.members)
        if not intent.available:
            self.store.append_audit_log("ai_intent_failed", {"message_id": message.id, "error": intent.error})
            return None
        message.ai_result = self._intent_payload(intent)
        message.confidence = intent.confidence
        self.store.save_source_message(message)
        if intent.needs_clarification or intent.confidence < AI_CONFIDENCE_THRESHOLD:
            if intent.clarification:
                self._reply(message, source, intent.clarification)
                self._audit_ai_intent(message, intent, executed=False, reason="clarification")
                return {"handled": True, "action": "ai_clarification", "intent": intent.intent}
            self._audit_ai_intent(message, intent, executed=False, reason="low_confidence")
            return None

        task_data = self._resolve_ai_task(intent, contextual_task)
        result: Optional[Dict[str, Any]] = None
        reason = ""
        if intent.intent == "update_task":
            if not task_data:
                result = self._ai_clarification(message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required")
                reason = "missing_task"
            else:
                result = self._update_task_fields(message, source, task_data, intent.fields)
                reason = result.get("action", "") if result else "no_fields"
        elif intent.intent == "add_progress":
            if not task_data:
                result = self._ai_clarification(message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required")
                reason = "missing_task"
            else:
                progress = intent.fields.progress or self._strip_bot_mention(message).strip()
                result = self._save_progress(message, source, task_data, progress)
                reason = "progress_saved"
        elif intent.intent == "change_status":
            if not task_data:
                result = self._ai_clarification(message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required")
                reason = "missing_task"
            else:
                result = self._apply_ai_status_action(message, source, task_data, intent.fields.status_action)
                reason = result.get("action", "") if result else "unsupported_status_action"
        elif intent.intent == "create_task":
            explicit_command = parse_task_command(message.text, message.mentions, self.config.feishu.bot_open_id)
            if not explicit_command.should_create:
                reason = "explicit_create_required"
            else:
                result = self._create_task_from_ai_intent(message, intent)
                reason = result.get("action", "") if result else "missing_create_fields"
        elif intent.intent == "unknown":
            reason = "unknown"

        if result:
            self._audit_ai_intent(message, intent, executed=result.get("handled", False), reason=reason)
            return result
        self._audit_ai_intent(message, intent, executed=False, reason=reason or "not_executed")
        return None

    def _update_task_due_date(
        self,
        message: SourceMessage,
        source: str,
        task_data: Dict[str, Any],
        due_date: str,
        content: str,
    ) -> Dict[str, Any]:
        if task_data.get("tapd_story_id"):
            tapd_result = self.tapd.update_story_due_date(task_data["tapd_story_id"], due_date)
            if not tapd_result.ok:
                self.store.append_audit_log("tapd_update_failed", {"task_id": task_data["id"], "error": tapd_result.error})
        task_data["due_date"] = due_date
        task_data["updated_at"] = utc_now_iso()
        task = Task(**task_data)
        self.store.save_task(task)
        self._save_update(task, message.sender_open_id, message.sender_name, "due_date_updated", content, source, message.id)
        self._reply(message, source, f"截止时间已更新：{task.title} -> {due_date}")
        if source == "private" and task.source_message_id:
            self._notify_source_group(task, f"负责人 {message.sender_name} 更新了任务截止时间为：{due_date}")
        self.store.append_audit_log("task_due_date_updated", {"task_id": task.id, "due_date": due_date})
        return {"handled": True, "action": "due_date_updated", "task_id": task.id, "due_date": due_date}

    def _update_task_fields(
        self,
        message: SourceMessage,
        source: str,
        task_data: Dict[str, Any],
        fields: IntentFields,
    ) -> Optional[Dict[str, Any]]:
        changes = []
        if fields.due_date:
            try:
                date.fromisoformat(fields.due_date)
            except ValueError:
                self._reply(message, source, "截止时间格式不明确，请换成 YYYY-MM-DD 或明确的日期。")
                return {"handled": True, "action": "ai_clarification", "reason": "invalid_due_date"}
            if task_data.get("tapd_story_id"):
                tapd_result = self.tapd.update_story_due_date(task_data["tapd_story_id"], fields.due_date)
                if not tapd_result.ok:
                    self.store.append_audit_log("tapd_update_failed", {"task_id": task_data["id"], "error": tapd_result.error})
            task_data["due_date"] = fields.due_date
            changes.append(f"截止时间：{fields.due_date}")

        if fields.priority:
            priority_label = PRIORITY_TO_TAPD_LABEL.get(fields.priority)
            if not priority_label:
                self._reply(message, source, "优先级只支持 P0/P1/P2/P3。")
                return {"handled": True, "action": "ai_clarification", "reason": "invalid_priority"}
            if task_data.get("tapd_story_id"):
                tapd_result = self.tapd.update_story_priority(task_data["tapd_story_id"], priority_label)
                if not tapd_result.ok:
                    self.store.append_audit_log("tapd_update_failed", {"task_id": task_data["id"], "error": tapd_result.error})
            task_data["priority"] = fields.priority
            changes.append(f"优先级：{fields.priority}")

        if fields.owner_open_id:
            owner = self.config.member_by_open_id(fields.owner_open_id)
            if not owner:
                self._reply(message, source, "没有找到要变更的负责人，请重新 @ 对应成员。")
                return {"handled": True, "action": "ai_clarification", "reason": "owner_not_found"}
            if task_data.get("tapd_story_id"):
                tapd_result = self.tapd.update_story_owner(task_data["tapd_story_id"], owner.name)
                if not tapd_result.ok:
                    self.store.append_audit_log("tapd_update_failed", {"task_id": task_data["id"], "error": tapd_result.error})
            task_data["primary_owner_open_id"] = owner.open_id
            task_data["primary_owner_name"] = owner.name
            if owner.open_id not in task_data.get("assignee_open_ids", []):
                task_data.setdefault("assignee_open_ids", []).append(owner.open_id)
                task_data.setdefault("assignee_names", []).append(owner.name)
            changes.append(f"负责人：{owner.name}")

        if not changes:
            self._reply(message, source, "我理解是要修改任务，但没有识别到可更新的字段。")
            return {"handled": True, "action": "ai_clarification", "reason": "empty_update_fields"}

        task_data["updated_at"] = utc_now_iso()
        task = Task(**task_data)
        self.store.save_task(task)
        content = "；".join(changes)
        self._save_update(task, message.sender_open_id, message.sender_name, "ai_task_updated", content, source, message.id)
        self._reply(message, source, f"已更新任务：{task.title}\n{content}")
        if source == "private" and task.source_message_id:
            self._notify_source_group(task, f"{message.sender_name} 更新了任务：{task.title}\n{content}")
        self.store.append_audit_log("task_ai_updated", {"task_id": task.id, "changes": changes})
        return {"handled": True, "action": "ai_task_updated", "task_id": task.id, "changes": changes}

    def _save_progress(self, message: SourceMessage, source: str, task_data: Dict[str, Any], content: str) -> Dict[str, Any]:
        task = Task(**task_data)
        self._save_update(task, message.sender_open_id, message.sender_name, "progress", content, source, message.id)
        self._reply(message, source, f"已记录任务进度：{task.title}")
        if source == "private" and task.source_message_id:
            self._notify_source_group(task, f"负责人 {message.sender_name} 更新了任务进度：\n{content}")
        return {"handled": True, "action": "progress_saved", "task_id": task.id}

    def _save_task_plan(self, message: SourceMessage, source: str, task_data: Dict[str, Any], content: str) -> Dict[str, Any]:
        task_data["task_plan"] = self._parse_task_plan(content)
        task_data["updated_at"] = utc_now_iso()
        task = Task(**task_data)
        self.store.save_task(task)
        self._save_update(task, message.sender_open_id, message.sender_name, "task_plan", content, source, message.id)
        self._reply(message, source, f"已保存任务计划：{task.title}")
        if source == "private" and task.source_message_id:
            self._notify_source_group(task, f"负责人 {message.sender_name} 补充了任务计划：\n{content}")
        self.store.append_audit_log("task_plan_saved", {"task_id": task.id, "source_message_id": message.id})
        return {"handled": True, "action": "task_plan_saved", "task_id": task.id}

    def _parse_task_plan(self, text: str) -> Dict[str, Any]:
        return {
            "raw_text": text,
            "estimated_time": self._extract_plan_field(text, ["预计完成时间", "预计时间", "完成时间", "预计完成"]),
            "steps": self._extract_plan_items(text, ["拆分步骤", "步骤", "计划"]),
            "dependencies": self._extract_plan_items(text, ["依赖对象", "依赖"]),
            "risks": self._extract_plan_items(text, ["风险点", "风险"]),
            "need_help": self._parse_need_help(text),
        }

    def _link_standup_to_tasks(self, standup: Standup, message: SourceMessage) -> List[str]:
        linked: List[str] = []
        seen: set[str] = set()
        for item in standup.yesterday_done + standup.today_plan:
            task_data = self._match_standup_task(item, standup.open_id)
            if not task_data:
                continue
            task = Task(**task_data)
            self._save_update(task, standup.open_id, standup.user_name, "progress", f"站会进度：{item}", "standup", message.id)
            if self._looks_done(item):
                self._set_task_status(message, "private", task_data, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", f"站会标记完成：{item}", TAPD_STATUS_TESTING)
            if task.id not in seen:
                linked.append(task.id)
                seen.add(task.id)
        for item in standup.blockers:
            task_data = self._match_standup_task(item, standup.open_id)
            if not task_data:
                continue
            task = Task(**task_data)
            self._set_task_status(message, "private", task_data, TASK_STATUS_BLOCKED, "blocked", f"站会阻塞：{item}", TAPD_STATUS_BLOCKED)
            if task.id not in seen:
                linked.append(task.id)
                seen.add(task.id)
        return linked

    def _match_standup_task(self, item: str, open_id: str) -> Optional[Dict[str, Any]]:
        best_task: Optional[Dict[str, Any]] = None
        best_score = 0.0
        for task in self.store.list_tasks():
            if task.get("status") in {TASK_STATUS_ACCEPTED, TASK_STATUS_CANCELLED}:
                continue
            if open_id != task.get("primary_owner_open_id") and open_id not in task.get("assignee_open_ids", []):
                continue
            score = self._title_overlap_score(item, task.get("title", ""))
            if score > best_score:
                best_task = task
                best_score = score
        return best_task if best_score >= 0.45 else None

    def _title_overlap_score(self, text: str, title: str) -> float:
        normalized_text = self._normalize_match_text(text)
        normalized_title = self._normalize_match_text(title)
        if not normalized_text or not normalized_title:
            return 0.0
        if normalized_title in normalized_text or normalized_text in normalized_title:
            return 1.0
        title_chars = set(normalized_title)
        common = title_chars & set(normalized_text)
        if len(common) < 4:
            return 0.0
        return len(common) / len(title_chars)

    def _normalize_match_text(self, value: str) -> str:
        text = re.sub(r"[\s，,。；;：:、/\\-]+", "", value)
        for token in ["任务", "父", "子", "昨天", "今日", "今天", "计划", "继续", "准备", "已经", "已完成", "完成了", "完成"]:
            text = text.replace(token, "")
        return text

    def _looks_done(self, text: str) -> bool:
        return any(keyword in text for keyword in ["已完成", "完成了", "已经完成"])

    def _extract_plan_field(self, text: str, labels: List[str]) -> str:
        label_pattern = "|".join(re.escape(label) for label in labels)
        match = re.search(rf"(?:{label_pattern})\s*[:：]\s*([^\n；;]+)", text)
        return match.group(1).strip() if match else ""

    def _extract_plan_items(self, text: str, labels: List[str]) -> List[str]:
        label_pattern = "|".join(re.escape(label) for label in labels)
        all_headers = "预计完成时间|预计时间|完成时间|预计完成|拆分步骤|步骤|计划|依赖对象|依赖|风险点|风险|是否需要协助|需要协助"
        match = re.search(rf"(?:{label_pattern})\s*[:：]\s*(.+?)(?=(?:{all_headers})\s*[:：]|$)", text, re.S)
        if not match:
            return []
        raw = match.group(1).strip()
        if raw in {"无", "暂无", "没有"}:
            return []
        return [item.strip(" -，,。；;\n") for item in re.split(r"\n+|\d+[.、)]|[；;]", raw) if item.strip(" -，,。；;\n")]

    def _parse_need_help(self, text: str) -> bool:
        match = re.search(r"(?:是否需要协助|需要协助)\s*[:：]\s*([^\n；;]+)", text)
        if not match:
            return "需要协助" in text and "不需要协助" not in text
        value = match.group(1).strip()
        return value.startswith("是") or value.startswith("需要") or "需要" in value

    def _parse_blocker_info(self, text: str, message: SourceMessage, blocked_at: str) -> Dict[str, Any]:
        reason = self._extract_blocker_reason(text)
        helper_names = [
            mention.name
            for mention in message.mentions
            if mention.open_id != self.config.feishu.bot_open_id and mention.open_id != message.sender_open_id
        ]
        helper_text = self._extract_assistance_text(text)
        if helper_text:
            helper_names.extend([item for item in re.split(r"[、,，\s]+", helper_text) if item])
        seen_helpers = []
        for name in helper_names:
            if name and name not in seen_helpers:
                seen_helpers.append(name)
        return {
            "reason": reason or text,
            "blocked_by_open_id": message.sender_open_id,
            "blocked_by_name": message.sender_name,
            "assistance_needed": seen_helpers,
            "blocked_at": blocked_at,
            "source_message_id": message.id,
            "suggested_action": "确认协助人和下一步恢复动作",
        }

    def _extract_blocker_reason(self, text: str) -> str:
        match = re.search(r"(?:原因是|原因[:：]|因为)(.+?)(?:，?需要|。|$)", text)
        return match.group(1).strip(" ，,。；;") if match else ""

    def _extract_assistance_text(self, text: str) -> str:
        match = re.search(r"需要(.+?)协助", text)
        return match.group(1).strip(" ：:，,。；;") if match else ""

    def _apply_ai_status_action(
        self,
        message: SourceMessage,
        source: str,
        task_data: Dict[str, Any],
        action: str,
    ) -> Optional[Dict[str, Any]]:
        if action in {"接受", "拒绝", "需要澄清", "验收通过", "打回"}:
            return self._apply_action(message, source, task_data, action, action)
        if action in {"已完成", "完成了"}:
            return self._set_task_status(message, source, task_data, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", action, None)
        if action in {"阻塞", "阻塞了"}:
            return self._set_task_status(message, source, task_data, TASK_STATUS_BLOCKED, "blocked", action, None)
        self._reply(message, source, "我理解是要更新任务状态，但没有识别到支持的状态动作。")
        return {"handled": True, "action": "ai_clarification", "reason": "unsupported_status_action"}

    def _create_task_from_ai_intent(self, message: SourceMessage, intent: MessageIntent) -> Optional[Dict[str, Any]]:
        explicit_command = parse_task_command(message.text, message.mentions, self.config.feishu.bot_open_id)
        if not explicit_command.should_create:
            return None

        owner = self.config.member_by_open_id(intent.fields.owner_open_id)
        title = intent.fields.title or intent.task_ref.title
        if not owner or not title:
            self._reply(message, message.chat_type, intent.clarification or "请补充任务标题和负责人。")
            return {"handled": True, "action": "ai_clarification", "reason": "missing_create_fields"}
        priority = intent.fields.priority or "P2"
        command = ParsedTaskCommand(
            should_create=True,
            reason="ai_intent",
            title=title,
            primary_owner=Mention(open_id=owner.open_id, name=owner.name),
            assignees=[Mention(open_id=owner.open_id, name=owner.name)],
            priority=priority,
            tapd_priority_label=PRIORITY_TO_TAPD_LABEL.get(priority, "Middle"),
            due_date=intent.fields.due_date or None,
        )
        return self._create_task_from_command(message, command)

    def _build_task(
        self,
        message: SourceMessage,
        command: ParsedTaskCommand,
        status: str,
        tapd_story_id: Optional[str],
        tapd_url: Optional[str],
        parent_id: Optional[str] = None,
    ) -> Task:
        now = utc_now_iso()
        owner = command.primary_owner or Mention(open_id="", name="")
        task_id = f"task-{message.id}-{abs(hash(command.title + owner.open_id)) % 100000}"
        ai_result = message.ai_result or {
            "type": "task_command",
            "parser": command.reason or "rule",
            "title": command.title,
        }
        confidence = message.confidence if message.confidence is not None else 1.0
        return Task(
            id=task_id,
            title=command.title,
            creator_open_id=message.sender_open_id,
            creator_name=message.sender_name,
            primary_owner_open_id=owner.open_id,
            primary_owner_name=owner.name,
            assignee_open_ids=[item.open_id for item in command.assignees],
            assignee_names=[item.name for item in command.assignees],
            status=status,
            priority=command.priority,
            due_date=command.due_date,
            acceptance_criteria=command.acceptance_criteria,
            description=command.description,
            source_message_id=message.id,
            source_group_id=message.chat_id,
            source_sender_open_id=message.sender_open_id,
            source_sender_name=message.sender_name,
            source_sent_at=message.sent_at,
            raw_text=message.text,
            ai_result=ai_result,
            confidence=confidence,
            trace=self._source_trace(message, ai_result, confidence),
            tapd_story_id=tapd_story_id,
            tapd_url=tapd_url,
            parent_id=parent_id,
            created_at=now,
            updated_at=now,
        )

    def _task_description(self, message: SourceMessage, command: ParsedTaskCommand) -> str:
        lines = []
        if command.acceptance_criteria:
            lines.append("验收标准：" + "；".join(command.acceptance_criteria))

        chat_source = "群聊" if message.chat_type == "group" else "私聊"
        lines.extend(
            [
                f"提出人：{message.sender_name}",
                "---",
                f"来源：飞书{chat_source}消息",
            ]
        )
        return "\n".join(lines)

    def _private_confirmation_text(self, task: Task) -> str:
        return (
            "新任务待确认：\n\n"
            f"任务：{task.title}\n"
            f"任务ID：{task.tapd_story_id or task.id}\n"
            f"截止时间：{task.due_date or '未设置'}\n"
            f"验收标准：{'；'.join(task.acceptance_criteria) or '未设置'}\n"
            f"提出人：{task.creator_name}\n"
            f"链接：{task.tapd_url or '未生成'}\n\n"
            f"回复：接受{task.tapd_story_id or task.id} / 拒绝{task.tapd_story_id or task.id} / 需要澄清{task.tapd_story_id or task.id}，也可以引用消息回复"
        )

    def _group_created_text(self, task: Task) -> str:
        return (
            "已创建任务：\n\n"
            f"任务：{task.title}\n"
            f"负责人：{task.primary_owner_name}\n"
            f"截止时间：{task.due_date or '未设置'}\n"
            f"优先级：{task.priority}\n"
            f"状态：待负责人确认\n"
            f"任务ID：{task.tapd_story_id or task.id}\n"
            f"查看TAPD：{task.tapd_url or '未生成'}"
        )

    def _save_update(
        self,
        task: Task,
        user_open_id: str,
        user_name: str,
        update_type: str,
        content: str,
        source: str,
        source_message_id: str | None,
        metadata: Dict[str, Any] | None = None,
    ) -> None:
        source_message = self.store.get_source_message(source_message_id)
        ai_result = {"type": update_type, "parser": "structured_event", "content": content}
        confidence = 1.0
        trace = self._source_trace(source_message, ai_result, confidence) if source_message else {}
        update = TaskUpdate(
            id=f"update-{task.id}-{len(self.store.list_task_updates(task.id)) + 1}",
            task_id=task.id,
            user_open_id=user_open_id,
            user_name=user_name,
            update_type=update_type,
            content=content,
            source=source,
            source_message_id=source_message_id,
            source_group_id=trace.get("source_group_id", ""),
            source_sender_open_id=trace.get("sender_open_id", ""),
            source_sender_name=trace.get("sender_name", ""),
            source_sent_at=trace.get("sent_at", ""),
            raw_text=trace.get("raw_text", ""),
            ai_result=ai_result,
            confidence=confidence,
            trace=trace,
            metadata=metadata or {},
            created_at=utc_now_iso(),
        )
        self.store.save_task_update(update)

    def _source_trace(
        self,
        message: SourceMessage | Dict[str, Any],
        ai_result: Dict[str, Any] | None = None,
        confidence: float | None = None,
    ) -> Dict[str, Any]:
        if isinstance(message, SourceMessage):
            return {
                "source_group_id": message.chat_id,
                "source_message_id": message.id,
                "source_message_ids": [message.id],
                "sender_open_id": message.sender_open_id,
                "sender_name": message.sender_name,
                "sent_at": message.sent_at,
                "raw_text": message.text,
                "ai_result": ai_result or message.ai_result,
                "confidence": confidence if confidence is not None else message.confidence,
            }
        message_id = str(message.get("id") or message.get("source_message_id") or "")
        return {
            "source_group_id": str(message.get("chat_id") or message.get("source_group_id") or ""),
            "source_message_id": message_id,
            "source_message_ids": [message_id] if message_id else [],
            "sender_open_id": str(message.get("sender_open_id") or message.get("source_sender_open_id") or ""),
            "sender_name": str(message.get("sender_name") or message.get("source_sender_name") or ""),
            "sent_at": str(message.get("sent_at") or message.get("source_sent_at") or ""),
            "raw_text": str(message.get("text") or message.get("raw_text") or ""),
            "ai_result": ai_result or message.get("ai_result") or {},
            "confidence": confidence if confidence is not None else message.get("confidence"),
        }

    def _intent_payload(self, intent: MessageIntent) -> Dict[str, Any]:
        fields = {
            key: value
            for key, value in {
                "title": intent.fields.title,
                "due_date": intent.fields.due_date,
                "priority": intent.fields.priority,
                "owner_open_id": intent.fields.owner_open_id,
                "progress": intent.fields.progress,
                "status_action": intent.fields.status_action,
            }.items()
            if value
        }
        return {
            "type": "message_intent",
            "parser": "llm",
            "intent": intent.intent,
            "task_ref": {
                "task_id": intent.task_ref.task_id,
                "tapd_story_id": intent.task_ref.tapd_story_id,
                "title": intent.task_ref.title,
            },
            "fields": fields,
            "needs_clarification": intent.needs_clarification,
            "clarification": intent.clarification,
        }

    def _reply(self, message: SourceMessage, source: str, text: str) -> Any:
        if source == "group":
            return self.feishu.send_reply_text(message.id, text)
        else:
            return self.feishu.send_private_text(message.sender_open_id, text)

    def _notify_source_group(self, task: Task, text: str, context_type: str = "task_status_notice") -> None:
        if not task.source_message_id:
            return
        res = self.feishu.send_reply_text(task.source_message_id, text)
        if res.message_id:
            self.store.save_bot_message_context(
                BotMessageContext(
                    message_id=res.message_id,
                    context_type=context_type,
                    created_at=utc_now_iso(),
                    chat_id=task.source_group_id or "",
                    task_id=task.id,
                    task_title=task.title,
                    metadata={"tapd_story_id": task.tapd_story_id or ""},
                )
            )

    def _ai_clarification(
        self,
        message: SourceMessage,
        source: str,
        intent: MessageIntent,
        fallback: str,
        action: str,
    ) -> Dict[str, Any]:
        self._reply(message, source, intent.clarification or fallback)
        return {"handled": True, "action": action, "intent": intent.intent}

    def _should_consider_ai(self, message: SourceMessage, source: str, reply_context: Optional[Dict[str, Any]]) -> bool:
        if source == "private":
            return True
        if reply_context:
            return True
        return any(item.open_id == self.config.feishu.bot_open_id for item in message.mentions)

    def _task_from_reply_context(self, reply_context: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if reply_context and reply_context.get("task_id"):
            return self.store.get_task(reply_context["task_id"])
        return None

    def _resolve_ai_task(self, intent: MessageIntent, contextual_task: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if contextual_task:
            return contextual_task
        if intent.task_ref.task_id:
            task = self.store.get_task(intent.task_ref.task_id)
            if task:
                return task
        if intent.task_ref.tapd_story_id:
            task = self.store.find_task(intent.task_ref.tapd_story_id)
            if task:
                return task
        if intent.task_ref.title:
            return self._find_unique_task_by_title(intent.task_ref.title)
        return None

    def _find_unique_task_by_title(self, title: str) -> Optional[Dict[str, Any]]:
        candidates = []
        for task in self.store.list_tasks():
            task_title = task.get("title", "")
            if title == task_title or title in task_title or task_title in title:
                candidates.append(task)
        return candidates[0] if len(candidates) == 1 else None

    def _audit_ai_intent(self, message: SourceMessage, intent: MessageIntent, executed: bool, reason: str) -> None:
        fields = {
            key: value
            for key, value in {
                "title": intent.fields.title,
                "due_date": intent.fields.due_date,
                "priority": intent.fields.priority,
                "owner_open_id": intent.fields.owner_open_id,
                "progress": intent.fields.progress,
                "status_action": intent.fields.status_action,
            }.items()
            if value
        }
        self.store.append_audit_log(
            "ai_intent_parsed",
            {
                "message_id": message.id,
                "intent": intent.intent,
                "confidence": intent.confidence,
                "executed": executed,
                "reason": reason,
                "task_ref": {
                    "task_id": intent.task_ref.task_id,
                    "tapd_story_id": intent.task_ref.tapd_story_id,
                    "title": intent.task_ref.title,
                },
                "fields": fields,
            },
        )

    def _add_working_reaction(self, message: SourceMessage) -> tuple[str | None, float]:
        started_at = time.monotonic()
        errors = []
        for emoji_type in WORKING_REACTION_EMOJI_TYPES:
            reaction_id = self.feishu.add_reaction(message.id, emoji_type)
            if reaction_id:
                return reaction_id, started_at
            if self.feishu.last_reaction_error:
                errors.append({"emoji_type": emoji_type, "error": self.feishu.last_reaction_error})
        if errors and not self.feishu.dry_run:
            self.store.append_audit_log("working_reaction_failed", {"message_id": message.id, "errors": errors})
        return None, started_at

    def _find_task_by_title(self, title: str) -> Optional[Dict[str, Any]]:
        for task in self.store.list_tasks():
            if title in task.get("title", "") or task.get("title", "") in title:
                return task
        return None

    def _resolve_private_sender(self, message: SourceMessage):
        if message.sender_open_id:
            return self.config.member_by_open_id(message.sender_open_id)
        open_id = self.store.open_id_for_chat_id(message.chat_id)
        return self.config.member_by_open_id(open_id) if open_id else None

    def _should_treat_as_standup(self, message: SourceMessage, reply_context: Optional[Dict[str, Any]]) -> bool:
        if looks_like_standup(message.text):
            return True
        return bool(reply_context and reply_context.get("context_type") == "standup_prompt")

    def _resolve_reply_context(self, message: SourceMessage) -> Optional[Dict[str, Any]]:
        for message_id in [message.parent_id, message.root_id]:
            context = self.store.get_bot_message_context(message_id)
            if context:
                return context
        return None

    def _contextual_task(
        self,
        message: SourceMessage,
        reply_context: Optional[Dict[str, Any]],
        normalized_text: str | None = None,
    ) -> Optional[Dict[str, Any]]:
        if reply_context and reply_context.get("task_id"):
            task = self.store.get_task(reply_context["task_id"])
            if task:
                return task

        normalized = (normalized_text if normalized_text is not None else message.text).strip().splitlines()[0].strip()
        
        has_intent = (
            re.search(r"^(接受|拒绝|需要澄清|验收通过|打回)$", normalized) or
            (re.search(r"(已完成|完成了)", normalized) and not re.search(r"(没|不|未)完成", normalized)) or
            (re.search(r"(阻塞|阻塞了)", normalized) and not re.search(r"(不|没|未)阻塞", normalized)) or
            normalized.startswith("进度")
        )
        if not has_intent:
            return None

        candidates = []
        for task in self.store.list_tasks():
            if message.sender_open_id == task.get("primary_owner_open_id") and task.get("status") in {
                TASK_STATUS_PENDING_CONFIRMATION,
                TASK_STATUS_CONFIRMED,
                TASK_STATUS_IN_PROGRESS,
                TASK_STATUS_BLOCKED,
                TASK_STATUS_OWNER_MARKED_DONE,
            }:
                candidates.append(task)
        if len(candidates) == 1:
            return candidates[0]
        return None

    def _strip_bot_mention(self, message: SourceMessage) -> str:
        text = message.text
        for mention in message.mentions:
            if mention.open_id != self.config.feishu.bot_open_id:
                continue
            names = [mention.name, self.config.feishu.bot_name]
            for name in [item for item in names if item]:
                text = re.sub(rf"^\s*@?{re.escape(name)}\s*", "", text).strip()
        return text

    def _parse_due_date_update(self, text: str, allow_colon: bool = False) -> Optional[str]:
        separators = "设置为|改为|调整为|设为|改到|到"
        if allow_colon:
            separators = f"{separators}|[:：]"
        if not re.search(rf"(?:截止时间|截止|完成时间)\s*(?:{separators})", text):
            return None
        return parse_due_date_text(text)

    def _is_system_noise(self, text: str) -> bool:
        return "<system-reminder>" in text or "<cb_summary>" in text or text.startswith("This is a summary")
