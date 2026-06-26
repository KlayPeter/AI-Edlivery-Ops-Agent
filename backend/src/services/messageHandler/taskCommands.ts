import { HandlerContext, PRIORITY_TO_TAPD_LABEL } from './types';
import { SourceMessage, Task, utcNowIso, BotMessageContext, Mention, TaskUpdate } from '@/models/types';
import { sourceTrace } from './utils';
import { ParsedTaskCommand } from '@/services/taskParser';

export async function createTaskFromCommand(
    ctx: HandlerContext,
    message: SourceMessage,
    command: ParsedTaskCommand,
    parentId?: string
): Promise<any> {
    if (command.missing_primary_owner) {
        const task = buildTask(ctx, message, command, "pending_primary_owner", undefined, undefined, parentId);
        task.is_draft = true;
        ctx.store.saveTask(task);
        
        const assignees = (command as any).assignee_names ? (command as any).assignee_names.join("、") : command.assignees.map(i => i.name).join("、");
        const res = await ctx.feishu.sendReplyText(message.id, `已识别到多人任务，请指定主负责人：\n\n任务：${command.title}\n参与人：${assignees}\n\n请引用本消息并回复：主负责人 @某某`);
        
        if (res.message_id) {
            ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "pending_primary_owner",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                task_id: task.id,
                task_title: task.title,
            });
        }
        return { handled: true, action: "pending_primary_owner", task_id: task.id };
    }

    if (command.is_independent && command.assignees.length > 1) {
        const owner = command.primary_owner || command.assignees[0];
        const description = taskDescription(message, command);
        
        const tapdResult = await ctx.tapd.createStory(
            `父任务：${command.title}`,
            owner.name,
            command.tapd_priority_label,
            command.due_date || undefined,
            description,
            parentId
        );
        
        const tapdStoryId = tapdResult.ok ? tapdResult.story_id : undefined;
        const tapdUrl = tapdResult.ok ? tapdResult.url : undefined;
        
        const parentTask = buildTask(ctx, message, command, "pending_confirmation", tapdStoryId, tapdUrl, parentId);
        parentTask.title = `父任务：${command.title}`;
        parentTask.is_draft = true;
        ctx.store.saveTask(parentTask);
        
        const childIds: string[] = [];
        for (const assignee of command.assignees) {
            const childCommand: ParsedTaskCommand = {
                should_create: true,
                reason: "ok",
                title: `${assignee.name}：${command.title}`,
                primary_owner: assignee,
                assignees: [assignee],
                priority: command.priority,
                tapd_priority_label: command.tapd_priority_label,
                due_date: command.due_date,
                acceptance_criteria: command.acceptance_criteria,
                description: command.description,
                is_independent: false,
                missing_primary_owner: false,
                is_subtask: false
            };
            const childResult = await createSingleTask(ctx, message, childCommand, tapdStoryId);
            if (childResult.task_id) childIds.push(childResult.task_id);
        }
        
        await ctx.feishu.sendReplyText(message.id, `已创建父任务和 ${childIds.length} 个子任务，等待各负责人确认。`);
        return { handled: true, action: "independent_tasks_created", parent_id: parentTask.id, child_ids: childIds };
    }

    return createSingleTask(ctx, message, command, parentId);
}

export async function createSingleTask(
    ctx: HandlerContext,
    message: SourceMessage,
    command: ParsedTaskCommand,
    parentId?: string
): Promise<any> {
    const owner = command.primary_owner;
    if (!owner) throw new Error("Missing owner");

    const description = taskDescription(message, command);
    const tapdResult = await ctx.tapd.createStory(
        command.title,
        owner.name,
        command.tapd_priority_label,
        command.due_date || undefined,
        description,
        parentId
    );

    if (!tapdResult.ok) {
        ctx.store.appendAuditLog("tapd_create_failed", { message_id: message.id, error: tapdResult.error });
        await ctx.feishu.sendReplyText(message.id, `任务创建失败：${tapdResult.error || 'TAPD API 调用失败'}`);
        return { handled: true, action: "tapd_create_failed", error: tapdResult.error };
    }

    const task = buildTask(ctx, message, command, "pending_confirmation", tapdResult.story_id, tapdResult.url, parentId);
    ctx.store.saveTask(task);
    
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "created", "任务已创建", "group", message.id);
    
    const privateText = privateConfirmationText(task);
    const privateResult = await ctx.feishu.sendPrivateText(owner.open_id, privateText);
    if (privateResult.chat_id) {
        ctx.store.updateChatId(owner.open_id, privateResult.chat_id);
    }
    if (privateResult.message_id) {
        ctx.store.saveBotMessageContext({
            message_id: privateResult.message_id,
            context_type: "task_confirmation",
            created_at: utcNowIso(),
            chat_id: privateResult.chat_id || "",
            chat_type: "p2p",
            target_open_id: owner.open_id,
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" },
        });
    }

    const groupResult = await ctx.feishu.sendReplyText(message.id, groupCreatedText(task));
    if (groupResult.message_id) {
        ctx.store.saveBotMessageContext({
            message_id: groupResult.message_id,
            context_type: "task_group_notice",
            created_at: utcNowIso(),
            chat_id: message.chat_id,
            chat_type: "group",
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" },
        });
    }

    ctx.store.appendAuditLog("task_created", { task_id: task.id, title: task.title, owner: owner.name, tapd_id: task.tapd_story_id });
    return { handled: true, action: "task_created", task_id: task.id, tapd_story_id: task.tapd_story_id };
}

export function buildTask(
    ctx: HandlerContext,
    message: SourceMessage,
    command: ParsedTaskCommand,
    status: string,
    tapdStoryId?: string,
    tapdUrl?: string,
    parentId?: string
): Task {
    const now = utcNowIso();
    const owner = command.primary_owner || { open_id: "", name: "" };
    
    let hashStr = command.title + owner.open_id;
    let hash = 0;
    for (let i = 0; i < hashStr.length; i++) hash = ((hash << 5) - hash) + hashStr.charCodeAt(i);
    const taskId = `task-${message.id}-${Math.abs(hash) % 100000}`;
    
    const aiResult = message.ai_result || {
        type: "task_command",
        parser: command.reason || "rule",
        title: command.title,
    };
    const confidence = (message.confidence !== undefined && message.confidence !== null) ? message.confidence : 1.0;
    
    return {
        id: taskId,
        title: command.title,
        creator_open_id: message.sender_open_id || "",
        creator_name: message.sender_name || "",
        primary_owner_open_id: owner.open_id,
        primary_owner_name: owner.name,
        assignee_open_ids: command.assignees.map(a => a.open_id),
        assignee_names: command.assignees.map(a => a.name),
        status,
        priority: command.priority,
        due_date: command.due_date || null,
        acceptance_criteria: command.acceptance_criteria || [],
        description: command.description || "",
        source_message_id: message.id,
        source_group_id: message.chat_id,
        source_sender_open_id: message.sender_open_id,
        source_sender_name: message.sender_name,
        source_sent_at: message.sent_at,
        raw_text: message.text,
        ai_result: aiResult,
        confidence,
        trace: sourceTrace(message, aiResult, confidence),
        tapd_story_id: tapdStoryId || null,
        tapd_url: tapdUrl || null,
        parent_id: parentId || null,
        created_at: now,
        updated_at: now,
    };
}

export function taskDescription(message: SourceMessage, command: ParsedTaskCommand): string {
    const lines: string[] = [];
    if (command.acceptance_criteria && command.acceptance_criteria.length) {
        lines.push("验收标准：" + command.acceptance_criteria.join("；"));
    }
    const chatSource = message.chat_type === "group" ? "群聊" : "私聊";
    lines.push(`提出人：${message.sender_name}`);
    lines.push("---");
    lines.push(`来源：飞书${chatSource}消息`);
    return lines.join("\n");
}

export function privateConfirmationText(task: Task): string {
    return (
        "新任务待确认：\n\n" +
        `任务：${task.title}\n` +
        `任务ID：${task.tapd_story_id || task.id}\n` +
        `截止时间：${task.due_date || '未设置'}\n` +
        `验收标准：${(task.acceptance_criteria || []).join("；") || '未设置'}\n` +
        `提出人：${task.creator_name}\n` +
        `链接：${task.tapd_url || '未生成'}\n\n` +
        `回复：接受${task.tapd_story_id || task.id} / 拒绝${task.tapd_story_id || task.id} / 需要澄清${task.tapd_story_id || task.id}，也可以引用消息回复`
    );
}

export function groupCreatedText(task: Task): string {
    return (
        "已创建任务：\n\n" +
        `任务：${task.title}\n` +
        `负责人：${task.primary_owner_name}\n` +
        `截止时间：${task.due_date || '未设置'}\n` +
        `优先级：${task.priority}\n` +
        `状态：待负责人确认\n` +
        `任务ID：${task.tapd_story_id || task.id}\n` +
        `查看TAPD：${task.tapd_url || '未生成'}`
    );
}

export function saveUpdate(
    ctx: HandlerContext,
    task: Task,
    userOpenId: string,
    userName: string,
    updateType: string,
    content: string,
    source: string,
    sourceMessageId?: string,
    metadata?: Record<string, any>
): void {
    const sourceMessage = sourceMessageId ? ctx.store.getSourceMessage(sourceMessageId) : undefined;
    const aiResult = { type: updateType, parser: "structured_event", content };
    const trace = sourceMessage ? sourceTrace(sourceMessage, aiResult, 1.0) : {};
    
    const count = ctx.store.listTaskUpdates(task.id).length;
    const update: TaskUpdate = {
        id: `update-${task.id}-${count + 1}`,
        task_id: task.id || "",
        user_open_id: userOpenId,
        user_name: userName,
        update_type: updateType,
        content,
        source,
        source_message_id: sourceMessageId || null,
        source_group_id: trace.source_group_id || "",
        source_sender_open_id: trace.sender_open_id || "",
        source_sender_name: trace.sender_name || "",
        source_sent_at: trace.sent_at || "",
        raw_text: trace.raw_text || "",
        ai_result: aiResult,
        confidence: 1.0,
        trace,
        metadata: metadata || {},
        created_at: utcNowIso(),
    };
    ctx.store.saveTaskUpdate(update);
}

export async function notifySourceGroup(ctx: HandlerContext, task: Task, text: string, contextType: string = "task_status_notice"): Promise<void> {
    if (!task.source_message_id) return;
    const res = await ctx.feishu.sendReplyText(task.source_message_id, text);
    if (res.message_id) {
        ctx.store.saveBotMessageContext({
            message_id: res.message_id,
            context_type: contextType,
            created_at: utcNowIso(),
            chat_id: task.source_group_id || "",
            task_id: task.id,
            task_title: task.title,
            metadata: { tapd_story_id: task.tapd_story_id || "" }
        });
    }
}
