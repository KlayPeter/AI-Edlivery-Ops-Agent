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
from .task_parser import ParsedTaskCommand, parse_due_date_text, parse_task_command


TAPD_STATUS_IN_PROGRESS = "status_14"
TAPD_STATUS_DONE = "status_5"
TAPD_STATUS_CANCELLED = "status_20"
WORKING_REACTION_MIN_SECONDS = 1.2
AI_CONFIDENCE_THRESHOLD = 0.8
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

        reaction_id, reaction_started_at = self._add_working_reaction(message)
        try:
            self.store.save_source_message(message)
            self.store.append_audit_log("source_message_received", {
                "message_id": message.id, 
                "chat_type": message.chat_type,
                "sender": message.sender_name,
                "text": message.text[:200]
            })

            if self._is_system_noise(message.text):
                return {"handled": False, "reason": "system_noise"}
            if message.chat_type == "group":
                return self._handle_group_message(message)
            return self._handle_private_message(message)
        finally:
            if reaction_id:
                if not self.feishu.dry_run:
                    elapsed = time.monotonic() - reaction_started_at
                    if elapsed < WORKING_REACTION_MIN_SECONDS:
                        time.sleep(WORKING_REACTION_MIN_SECONDS - elapsed)
                self.feishu.remove_reaction(message.id, reaction_id)

    def _handle_group_message(self, message: SourceMessage) -> Dict[str, Any]:
        reply_context = self._resolve_reply_context(message)
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
            ai_result = self._maybe_handle_ai_intent(message, "group", reply_context)
            if ai_result:
                return ai_result
            return {"handled": False, "reason": command.reason}
        key = f"{message.id}:create_task"
        if self.store.has_idempotency_key(key):
            return {"handled": True, "action": "idempotent_skip"}
        result = self._create_task_from_command(message, command)
        self.store.set_idempotency_key(key, result)
        return result

    def _handle_private_message(self, message: SourceMessage) -> Dict[str, Any]:
        sender = self._resolve_private_sender(message)
        if sender:
            message.sender_open_id = sender.open_id
            message.sender_name = sender.name
        reply_context = self._resolve_reply_context(message)
        if self._should_treat_as_standup(message, reply_context):
            standup = parse_standup(message.sender_open_id, message.sender_name, message.text, message.id)
            self.store.save_standup(standup)
            self.feishu.send_private_text(message.sender_open_id, "已收到今日站会，谢谢。")
            self.store.append_audit_log("standup_saved", {"open_id": standup.open_id, "standup_id": standup.id})
            return {"handled": True, "action": "standup_saved", "standup_id": standup.id}
        status_result = self._maybe_handle_status_update(message, source="private", reply_context=reply_context)
        if status_result:
            return status_result
        ai_result = self._maybe_handle_ai_intent(message, "private", reply_context)
        if ai_result:
            return ai_result
        return {"handled": False, "reason": "no_private_command"}

    def _create_task_from_command(self, message: SourceMessage, command: ParsedTaskCommand) -> Dict[str, Any]:
        if command.missing_primary_owner:
            task = self._build_task(message, command, status=TASK_STATUS_PENDING_PRIMARY_OWNER, tapd_story_id=None, tapd_url=None)
            task.is_draft = True
            self.store.save_task(task)
            assignees = "、".join(command.assignee_names if hasattr(command, "assignee_names") else [item.name for item in command.assignees])
            self.feishu.send_reply_text(
                message.id,
                f"已识别到多人任务，请指定主负责人：\n\n任务：{command.title}\n参与人：{assignees}\n\n请回复：主负责人 @某某",
            )
            return {"handled": True, "action": "pending_primary_owner", "task_id": task.id}

        if command.is_independent and len(command.assignees) > 1:
            parent = self._build_task(message, command, status=TASK_STATUS_PENDING_CONFIRMATION, tapd_story_id=None, tapd_url=None)
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
                child = self._create_single_task(message, child_command, parent_id=parent.id)
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
        match = re.search(r"(接受|拒绝|验收通过|打回)\s*([A-Za-z0-9_-]+|\d{6,})", text)
        if match:
            action, identifier = match.group(1), match.group(2)
            task_data = self.store.find_task(identifier)
            if not task_data:
                self._reply(message, source, "没有找到对应任务，请带上任务ID或TAPD Story ID。")
                return {"handled": True, "action": "task_not_found"}
            return self._apply_action(message, source, task_data, action, text)

        contextual_task = self._contextual_task(message, reply_context, normalized_text=text)
        due_date = self._parse_due_date_update(text, allow_colon=bool(contextual_task))
        if due_date and contextual_task:
            return self._update_task_due_date(message, source, contextual_task, due_date, text)
        if due_date and not contextual_task:
            self._reply(message, source, "请引用对应任务消息回复，或直接带上任务ID。")
            return {"handled": True, "action": "task_context_required"}

        context_action = re.match(r"^\s*(接受|拒绝|验收通过|打回)\s*$", text)
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
                return self._set_task_status(message, source, task_data, TASK_STATUS_BLOCKED, "blocked", content, None)
            if "完成" in status_word:
                return self._set_task_status(message, source, task_data, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", content, None)
            return self._save_progress(message, source, task_data, content)

        if contextual_task:
            if re.match(r"^\s*(已完成|完成了)\s*$", text):
                return self._set_task_status(message, source, contextual_task, TASK_STATUS_OWNER_MARKED_DONE, "owner_marked_done", text, None)
            if re.match(r"^\s*(阻塞|阻塞了)(?:[:：].+)?$", text):
                return self._set_task_status(message, source, contextual_task, TASK_STATUS_BLOCKED, "blocked", text, None)
            if text.startswith("进度") or reply_context and reply_context.get("context_type") in {"task_plan_request", "task_confirmation"}:
                return self._save_progress(message, source, contextual_task, text)
        return None

    def _apply_action(self, message: SourceMessage, source: str, task_data: Dict[str, Any], action: str, text: str) -> Dict[str, Any]:
        if action in {"接受", "拒绝"} and message.sender_open_id != task_data.get("primary_owner_open_id"):
            self._reply(message, source, "只有任务负责人可以确认或拒绝该任务。")
            return {"handled": True, "action": "unauthorized"}
        if action == "接受":
            return self._set_task_status(message, source, task_data, TASK_STATUS_CONFIRMED, "accepted_by_owner", text, TAPD_STATUS_IN_PROGRESS)
        if action == "拒绝":
            return self._set_task_status(message, source, task_data, TASK_STATUS_CANCELLED, "rejected_by_owner", text, TAPD_STATUS_CANCELLED)
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
        if tapd_status and task_data.get("tapd_story_id"):
            tapd_result = self.tapd.update_story_status(task_data["tapd_story_id"], tapd_status)
            if not tapd_result.ok:
                self.store.append_audit_log("tapd_update_failed", {"task_id": task_data["id"], "error": tapd_result.error})
        task_data["status"] = status
        task_data["updated_at"] = utc_now_iso()
        task = Task(**task_data)
        self.store.save_task(task)
        self._save_update(task, message.sender_open_id, message.sender_name, update_type, content, source, message.id)
        if update_type == "accepted_by_owner":
            result = self.feishu.send_private_text(
                task.primary_owner_open_id,
                f"已确认接受任务：{task.title}\n请补充任务计划：预计完成时间、拆分步骤、依赖对象、风险点、是否需要协助。",
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
                self.feishu.send_reply_text(task.source_message_id, f"负责人 {message.sender_name} 已接受任务：{task.title}")
        elif update_type == "owner_marked_done":
            text = f"{task.primary_owner_name} 已标记任务完成，等待创建人验收：{task.title}\n可直接引用本消息回复：验收通过 / 打回"
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
            self._reply(message, source, f"任务状态已更新：{task.title} -> {status}")
            if source == "private" and task.source_message_id:
                action_text = content.strip() if content.strip() else status
                self.feishu.send_reply_text(task.source_message_id, f"负责人 {message.sender_name} 更新了任务状态：{status}\n回复内容：{action_text}")
        self.store.append_audit_log("task_status_updated", {"task_id": task.id, "status": status, "update_type": update_type})
        return {"handled": True, "action": update_type, "task_id": task.id, "status": status}

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
            return None
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
            self.feishu.send_reply_text(task.source_message_id, f"负责人 {message.sender_name} 更新了任务截止时间为：{due_date}")
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
            self.feishu.send_reply_text(task.source_message_id, f"{message.sender_name} 更新了任务：{task.title}\n{content}")
        self.store.append_audit_log("task_ai_updated", {"task_id": task.id, "changes": changes})
        return {"handled": True, "action": "ai_task_updated", "task_id": task.id, "changes": changes}

    def _save_progress(self, message: SourceMessage, source: str, task_data: Dict[str, Any], content: str) -> Dict[str, Any]:
        task = Task(**task_data)
        self._save_update(task, message.sender_open_id, message.sender_name, "progress", content, source, message.id)
        self._reply(message, source, f"已记录任务进度：{task.title}")
        if source == "private" and task.source_message_id:
            self.feishu.send_reply_text(task.source_message_id, f"负责人 {message.sender_name} 更新了任务进度：\n{content}")
        return {"handled": True, "action": "progress_saved", "task_id": task.id}

    def _apply_ai_status_action(
        self,
        message: SourceMessage,
        source: str,
        task_data: Dict[str, Any],
        action: str,
    ) -> Optional[Dict[str, Any]]:
        if action in {"接受", "拒绝", "验收通过", "打回"}:
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
        lines.extend(
            [
                f"提出人：{message.sender_name}",
                "---",
                "来源：飞书消息",
                f"来源消息ID：{message.id}",
                f"原始文本：{message.text}",
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
            f"回复：接受{task.tapd_story_id or task.id} / 拒绝{task.tapd_story_id or task.id}"
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
    ) -> None:
        update = TaskUpdate(
            id=f"update-{task.id}-{len(self.store.list_task_updates(task.id)) + 1}",
            task_id=task.id,
            user_open_id=user_open_id,
            user_name=user_name,
            update_type=update_type,
            content=content,
            source=source,
            source_message_id=source_message_id,
            created_at=utc_now_iso(),
        )
        self.store.save_task_update(update)

    def _reply(self, message: SourceMessage, source: str, text: str) -> None:
        if source == "group":
            self.feishu.send_reply_text(message.id, text)
        else:
            self.feishu.send_private_text(message.sender_open_id, text)

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

        exact_actions = {"接受", "拒绝", "验收通过", "打回", "已完成", "完成了", "阻塞", "阻塞了"}
        normalized = (normalized_text if normalized_text is not None else message.text).strip().splitlines()[0].strip()
        if normalized not in exact_actions and not normalized.startswith("进度"):
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
