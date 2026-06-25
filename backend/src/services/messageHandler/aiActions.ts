import { HandlerContext, AI_CONFIDENCE_THRESHOLD, PRIORITY_TO_TAPD_LABEL, TAPD_STATUS_TESTING, TAPD_STATUS_BLOCKED } from './types';
import { SourceMessage, Task, utcNowIso, Mention } from '../../models/types';
import { ContextResolver } from './ContextResolver';
import { MessageIntent, IntentFields } from '../messageIntent';
import { findUniqueTaskByTitle, stripBotMention } from './utils';
import { reply, applyAction, setTaskStatus, saveProgress } from './statusUpdates';
import { saveUpdate, notifySourceGroup, createTaskFromCommand } from './taskCommands';
import { parseTaskCommand, ParsedTaskCommand } from '../taskParser';
import dayjs from 'dayjs';

export async function maybeHandleAiIntent(
    ctx: HandlerContext,
    resolver: ContextResolver,
    message: SourceMessage,
    source: string,
    replyContext: any
): Promise<any> {
    if (!ctx.intentParser || !resolver.shouldConsiderAi(message, source, replyContext)) return null;

    const contextualTask = resolver.taskFromReplyContext(replyContext);
    const allMembers = ctx.config.groups.flatMap(g => g.members);
    
    const intent = await ctx.intentParser.parse(message, replyContext, contextualTask, allMembers);
    if (!intent.available) {
        ctx.store.appendAuditLog("ai_intent_failed", { message_id: message.id, error: intent.error });
        return null;
    }
    
    message.ai_result = intentPayload(intent);
    message.confidence = intent.confidence;
    ctx.store.saveSourceMessage(message);
    
    if (intent.needs_clarification || intent.confidence < AI_CONFIDENCE_THRESHOLD) {
        if (intent.clarification) {
            await reply(ctx, message, source, intent.clarification);
            auditAiIntent(ctx, message, intent, false, "clarification");
            return { handled: true, action: "ai_clarification", intent: intent.intent };
        }
        auditAiIntent(ctx, message, intent, false, "low_confidence");
        return null;
    }

    const taskData = resolveAiTask(ctx, intent, contextualTask);
    let result: any = null;
    let reason = "";

    if (intent.intent === "update_task") {
        if (!taskData) {
            result = await aiClarification(ctx, message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required");
            reason = "missing_task";
        } else {
            result = await updateTaskFields(ctx, message, source, taskData, intent.fields);
            reason = result ? result.action : "no_fields";
        }
    } else if (intent.intent === "add_progress") {
        if (!taskData) {
            result = await aiClarification(ctx, message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required");
            reason = "missing_task";
        } else {
            const progress = intent.fields.progress || stripBotMention(message, ctx).trim();
            result = await saveProgress(ctx, message, source, taskData, progress);
            reason = "progress_saved";
        }
    } else if (intent.intent === "change_status") {
        if (!taskData) {
            result = await aiClarification(ctx, message, source, intent, "请引用对应任务消息回复，或直接带上任务ID。", "task_context_required");
            reason = "missing_task";
        } else {
            result = await applyAiStatusAction(ctx, message, source, taskData, intent.fields.status_action);
            reason = result ? result.action : "unsupported_status_action";
        }
    } else if (intent.intent === "create_task") {
        const explicitCommand = parseTaskCommand(message.text || "", message.mentions || [], ctx.config.feishu.bot_open_id);
        if (!explicitCommand.should_create) {
            reason = "explicit_create_required";
        } else {
            result = await createTaskFromAiIntent(ctx, message, intent);
            reason = result ? result.action : "missing_create_fields";
        }
    } else if (intent.intent === "unknown") {
        reason = "unknown";
    }

    if (result) {
        auditAiIntent(ctx, message, intent, result.handled || false, reason);
        return result;
    }
    auditAiIntent(ctx, message, intent, false, reason || "not_executed");
    return null;
}

async function updateTaskFields(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, fields: IntentFields): Promise<any> {
    const changes: string[] = [];
    
    if (fields.due_date) {
        if (!dayjs(fields.due_date).isValid()) {
            await reply(ctx, message, source, "截止时间格式不明确，支持的格式如：YYYY-MM-DD，本周三，下周三，本月6号，明天等。");
            return { handled: true, action: "ai_clarification", reason: "invalid_due_date" };
        }
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryDueDate(taskData.tapd_story_id, fields.due_date);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.due_date = fields.due_date;
        changes.push(`截止时间：${fields.due_date}`);
    }

    if (fields.priority) {
        const priorityLabel = PRIORITY_TO_TAPD_LABEL[fields.priority];
        if (!priorityLabel) {
            await reply(ctx, message, source, "优先级只支持 P0/P1/P2（或高/中/低）。");
            return { handled: true, action: "ai_clarification", reason: "invalid_priority" };
        }
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryPriority(taskData.tapd_story_id, priorityLabel);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.priority = fields.priority;
        changes.push(`优先级：${fields.priority}`);
    }

    if (fields.owner_open_id) {
        const owner = (openId => ctx.config.groups.flatMap(g => g.members).find(m => m.open_id === openId))(fields.owner_open_id);
        if (!owner) {
            await reply(ctx, message, source, "没有找到要变更的负责人，请重新 @ 对应成员。");
            return { handled: true, action: "ai_clarification", reason: "owner_not_found" };
        }
        if (taskData.tapd_story_id) {
            const tapdResult = await ctx.tapd.updateStoryOwner(taskData.tapd_story_id, owner.name);
            if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
        }
        taskData.primary_owner_open_id = owner.open_id;
        taskData.primary_owner_name = owner.name;
        if (!(taskData.assignee_open_ids || []).includes(owner.open_id)) {
            taskData.assignee_open_ids = [...(taskData.assignee_open_ids || []), owner.open_id];
            taskData.assignee_names = [...(taskData.assignee_names || []), owner.name];
        }
        changes.push(`负责人：${owner.name}`);
    }

    if (!changes.length) {
        await reply(ctx, message, source, "我理解是要修改任务，但没有识别到可更新的字段。");
        return { handled: true, action: "ai_clarification", reason: "empty_update_fields" };
    }

    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);
    
    const content = changes.join("；");
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "ai_task_updated", content, source, message.id);
    await reply(ctx, message, source, `已更新任务：${task.title}\n${content}`);
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, `${message.sender_name} 更新了任务：${task.title}\n${content}`);
    }
    
    ctx.store.appendAuditLog("task_ai_updated", { task_id: task.id, changes });
    return { handled: true, action: "ai_task_updated", task_id: task.id, changes };
}

async function applyAiStatusAction(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, action: string): Promise<any> {
    if (["接受", "拒绝", "需要澄清", "验收通过", "打回"].includes(action)) {
        return applyAction(ctx, message, source, taskData, action, action);
    }
    if (["已完成", "完成了"].includes(action)) {
        return setTaskStatus(ctx, message, source, taskData, "owner_marked_done", "owner_marked_done", action, TAPD_STATUS_TESTING);
    }
    if (["阻塞", "阻塞了"].includes(action)) {
        return setTaskStatus(ctx, message, source, taskData, "blocked", "blocked", action, TAPD_STATUS_BLOCKED);
    }
    await reply(ctx, message, source, "我理解是要更新任务状态，但没有识别到支持的状态动作。");
    return { handled: true, action: "ai_clarification", reason: "unsupported_status_action" };
}

async function createTaskFromAiIntent(ctx: HandlerContext, message: SourceMessage, intent: MessageIntent): Promise<any> {
    const explicitCommand = parseTaskCommand(message.text || "", message.mentions || [], ctx.config.feishu.bot_open_id);
    if (!explicitCommand.should_create) return null;

    const owner = (openId => ctx.config.groups.flatMap(g => g.members).find(m => m.open_id === openId))(intent.fields.owner_open_id);
    const title = intent.fields.title || intent.task_ref.title;
    if (!owner || !title) {
        await reply(ctx, message, message.chat_type || "private", intent.clarification || "请补充任务标题和负责人。");
        return { handled: true, action: "ai_clarification", reason: "missing_create_fields" };
    }
    
    const priority = intent.fields.priority || "P1";
    const command: ParsedTaskCommand = {
        should_create: true,
        reason: "ai_intent",
        title,
        primary_owner: { open_id: owner.open_id, name: owner.name } as Mention,
        assignees: [{ open_id: owner.open_id, name: owner.name } as Mention],
        priority,
        tapd_priority_label: PRIORITY_TO_TAPD_LABEL[priority] || "Middle",
        due_date: intent.fields.due_date || null,
        acceptance_criteria: [],
        description: "",
        is_independent: false,
        missing_primary_owner: false,
        is_subtask: false
    };
    return createTaskFromCommand(ctx, message, command);
}

export async function updateTaskDueDate(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string, content: string): Promise<any> {
    if (taskData.tapd_story_id) {
        const tapdResult = await ctx.tapd.updateStoryDueDate(taskData.tapd_story_id, dueDate);
        if (!tapdResult.ok) ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
    }
    taskData.due_date = dueDate;
    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);
    
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "due_date_updated", content, source, message.id);
    await reply(ctx, message, source, `截止时间已更新：${task.title} -> ${dueDate}`);
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 更新了任务截止时间为：${dueDate}`);
    }
    ctx.store.appendAuditLog("task_due_date_updated", { task_id: task.id, due_date: dueDate });
    return { handled: true, action: "due_date_updated", task_id: task.id, due_date: dueDate };
}

function resolveAiTask(ctx: HandlerContext, intent: MessageIntent, contextualTask: any): any {
    if (contextualTask) return contextualTask;
    if (intent.task_ref.task_id) {
        const task = ctx.store.getTask(intent.task_ref.task_id);
        if (task) return task;
    }
    if (intent.task_ref.tapd_story_id) {
        const task = ctx.store.findTask(intent.task_ref.tapd_story_id);
        if (task) return task;
    }
    if (intent.task_ref.title) {
        return findUniqueTaskByTitle(intent.task_ref.title, ctx);
    }
    return null;
}

function intentPayload(intent: MessageIntent): any {
    const fields: Record<string, string> = {};
    if (intent.fields.title) fields.title = intent.fields.title;
    if (intent.fields.due_date) fields.due_date = intent.fields.due_date;
    if (intent.fields.priority) fields.priority = intent.fields.priority;
    if (intent.fields.owner_open_id) fields.owner_open_id = intent.fields.owner_open_id;
    if (intent.fields.progress) fields.progress = intent.fields.progress;
    if (intent.fields.status_action) fields.status_action = intent.fields.status_action;
    
    return {
        type: "message_intent",
        parser: "llm",
        intent: intent.intent,
        task_ref: {
            task_id: intent.task_ref.task_id,
            tapd_story_id: intent.task_ref.tapd_story_id,
            title: intent.task_ref.title,
        },
        fields,
        needs_clarification: intent.needs_clarification,
        clarification: intent.clarification,
    };
}

async function aiClarification(ctx: HandlerContext, message: SourceMessage, source: string, intent: MessageIntent, fallback: string, action: string): Promise<any> {
    await reply(ctx, message, source, intent.clarification || fallback);
    return { handled: true, action, intent: intent.intent };
}

function auditAiIntent(ctx: HandlerContext, message: SourceMessage, intent: MessageIntent, executed: boolean, reason: string): void {
    const fields: Record<string, string> = {};
    if (intent.fields.title) fields.title = intent.fields.title;
    if (intent.fields.due_date) fields.due_date = intent.fields.due_date;
    if (intent.fields.priority) fields.priority = intent.fields.priority;
    if (intent.fields.owner_open_id) fields.owner_open_id = intent.fields.owner_open_id;
    if (intent.fields.progress) fields.progress = intent.fields.progress;
    if (intent.fields.status_action) fields.status_action = intent.fields.status_action;

    ctx.store.appendAuditLog("ai_intent_parsed", {
        message_id: message.id,
        intent: intent.intent,
        confidence: intent.confidence,
        executed,
        reason,
        task_ref: {
            task_id: intent.task_ref.task_id,
            tapd_story_id: intent.task_ref.tapd_story_id,
            title: intent.task_ref.title,
        },
        fields
    });
}
