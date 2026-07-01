import { HandlerContext, TAPD_STATUS_IN_PROGRESS, TAPD_STATUS_CANCELLED, TAPD_STATUS_DONE, TAPD_STATUS_TESTING, TAPD_STATUS_BLOCKED } from './types';
import { SourceMessage, Task, utcNowIso } from '@/models/types';
import { saveUpdate, notifySourceGroup } from './taskCommands';

export async function applyAction(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    action: string,
    text: string
): Promise<any> {
    if (["接受", "拒绝", "需要澄清"].includes(action) && message.sender_open_id !== taskData.primary_owner_open_id) {
        await reply(ctx, message, source, "只有任务负责人可以确认、拒绝或要求澄清该任务。");
        return { handled: true, action: "unauthorized" };
    }
    if (["验收通过", "打回", "删除", "取消"].includes(action) && message.sender_open_id !== taskData.creator_open_id && message.sender_open_id !== taskData.primary_owner_open_id) {
        await reply(ctx, message, source, "只有任务创建人或负责人可以执行该操作。");
        return { handled: true, action: "unauthorized" };
    }
    if (action === "接受") return setTaskStatus(ctx, message, source, taskData, "confirmed", "accepted_by_owner", text, TAPD_STATUS_IN_PROGRESS);
    if (action === "拒绝") return setTaskStatus(ctx, message, source, taskData, "cancelled", "rejected_by_owner", text, TAPD_STATUS_CANCELLED);
    if (action === "需要澄清") return requestClarification(ctx, message, source, taskData, text);
    if (action === "验收通过") return setTaskStatus(ctx, message, source, taskData, "accepted", "accepted", text, TAPD_STATUS_DONE);
    if (action === "打回") return setTaskStatus(ctx, message, source, taskData, "in_progress", "reopened", text, TAPD_STATUS_IN_PROGRESS);
    if (action === "删除") return setTaskStatus(ctx, message, source, taskData, "deleted", "deleted", text, undefined);
    if (action === "取消") return setTaskStatus(ctx, message, source, taskData, "cancelled", "cancelled", text, TAPD_STATUS_CANCELLED);
    return { handled: false, reason: "unknown_action" };
}

export async function setTaskStatus(
    ctx: HandlerContext,
    message: SourceMessage,
    source: string,
    taskData: any,
    status: string,
    updateType: string,
    content: string,
    tapdStatus?: string
): Promise<any> {
    let tapdErrorMsg = "";
    if (tapdStatus && taskData.tapd_story_id) {
        const tapdResult = await ctx.tapd.updateStoryStatus(taskData.tapd_story_id, tapdStatus);
        if (!tapdResult.ok) {
            ctx.store.appendAuditLog("tapd_update_failed", { task_id: taskData.id, error: tapdResult.error });
            tapdErrorMsg = "\n(⚠️ 注：同步至TAPD状态失败，可能任务已被删除)";
            if (String(tapdResult.error).includes("404") || String(tapdResult.error).includes("Not Found")) {
                status = "deleted";
            }
        }
    }
    
    if (status === "blocked") {
        const blockedAt = taskData.blocked_at || utcNowIso();
        taskData.blocked_at = blockedAt;
        taskData.blocker_info = parseBlockerInfo(ctx, content, message, blockedAt);
    } else {
        taskData.blocked_at = null;
        taskData.blocker_info = {};
    }
    
    taskData.status = status;
    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);
    
    const metadata = updateType === "blocked" ? task.blocker_info : undefined;
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", updateType, content, source, message.id, metadata);
    
    if (updateType === "accepted_by_owner") {
        const res = await ctx.feishu.sendPrivateText(
            task.primary_owner_open_id,
            `已确认接受任务：${task.title}${tapdErrorMsg}\n请补充任务计划：\n\n预计完成时间：\n拆分步骤：\n依赖对象：\n风险点：\n是否需要协助：`
        );
        if (res.message_id) {
            ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "task_plan_request",
                created_at: utcNowIso(),
                chat_id: res.chat_id || "",
                chat_type: "p2p",
                target_open_id: task.primary_owner_open_id,
                task_id: task.id,
                task_title: task.title,
                metadata: { tapd_story_id: task.tapd_story_id || "" }
            });
        }
        if (source === "private" && task.source_message_id) {
            await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 已接受任务：${task.title}${tapdErrorMsg}`);
        }
    } else if (updateType === "owner_marked_done") {
        const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
        const text = `${task.primary_owner_name} 已标记任务完成，等待创建人验收：${task.title}${link}${tapdErrorMsg}\n可直接引用本消息回复：验收通过 / 打回`;
        const targetChatId = source === "group" ? message.chat_id : task.source_group_id;
        
        let res: any;
        if (source === "group") res = await ctx.feishu.sendReplyText(message.id, text);
        else res = await ctx.feishu.sendGroupText(text, targetChatId || "");
        
        if (res.message_id) {
            ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "task_acceptance_prompt",
                created_at: utcNowIso(),
                chat_id: targetChatId || "",
                chat_type: "group",
                target_open_id: task.creator_open_id,
                task_id: task.id,
                task_title: task.title,
                metadata: { tapd_story_id: task.tapd_story_id || "" }
            });
        }
    } else {
        const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
        await reply(ctx, message, source, `任务状态已更新：${task.title}${link} -> ${status}${tapdErrorMsg}`);
        if (source === "private" && task.source_message_id) {
            const actionText = content.trim() || status;
            await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 更新了任务状态：${status}${tapdErrorMsg}\n回复内容：${actionText}`);
        }
    }
    
    ctx.store.appendAuditLog("task_status_updated", { task_id: task.id, status, update_type: updateType });
    return { handled: true, action: updateType, task_id: task.id, status };
}

export async function requestClarification(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const task = taskData as Task;
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "clarification_requested", content, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `已记录澄清请求：${task.title}${link}`);
    
    const notice = `负责人 ${message.sender_name} 对任务提出澄清请求：${task.title}${link}\n回复内容：${content}`;
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, notice);
    } else if (source === "group") {
        await ctx.feishu.sendReplyText(message.id, notice);
    }
    
    ctx.store.appendAuditLog("task_clarification_requested", { task_id: task.id, source_message_id: message.id });
    return { handled: true, action: "clarification_requested", task_id: task.id, status: task.status };
}

export async function saveProgress(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    const task = taskData as Task;
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "progress", content, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `已记录任务进度：${task.title}${link}`);
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 更新了任务进度：\n${content}`);
    }
    return { handled: true, action: "progress_saved", task_id: task.id };
}

export async function saveTaskPlan(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, content: string): Promise<any> {
    taskData.task_plan = parseTaskPlan(content);
    taskData.updated_at = utcNowIso();
    const task = taskData as Task;
    ctx.store.saveTask(task);
    
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "task_plan", content, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `已保存任务计划：${task.title}${link}`);
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 补充了任务计划：\n${content}`);
    }
    ctx.store.appendAuditLog("task_plan_saved", { task_id: task.id, source_message_id: message.id });
    return { handled: true, action: "task_plan_saved", task_id: task.id };
}

function parseBlockerInfo(ctx: HandlerContext, text: string, message: SourceMessage, blockedAt: string): any {
    const reasonMatch = text.match(/(?:原因是|原因[:：]|因为)(.+?)(?:，?需要|。|$)/);
    const reason = reasonMatch ? reasonMatch[1].replace(/^[ ，,。；;]+/, "").replace(/[ ，,。；;]+$/, "") : "";
    
    const helperNames = (message.mentions || [])
        .filter(m => m.open_id !== ctx.config.feishu.bot_open_id && m.open_id !== message.sender_open_id)
        .map(m => m.name);
        
    const helperMatch = text.match(/需要(.+?)协助/);
    const helperText = helperMatch ? helperMatch[1].replace(/^[ ：:，,。；;]+/, "").replace(/[ ：:，,。；;]+$/, "") : "";
    if (helperText) {
        helperText.split(/[、,，\s]+/).filter(Boolean).forEach(n => helperNames.push(n));
    }
    
    const seenHelpers = Array.from(new Set(helperNames.filter(Boolean)));
    return {
        reason: reason || text,
        blocked_by_open_id: message.sender_open_id,
        blocked_by_name: message.sender_name,
        assistance_needed: seenHelpers,
        blocked_at: blockedAt,
        source_message_id: message.id,
        suggested_action: "确认协助人和下一步恢复动作",
    };
}

function parseTaskPlan(text: string): any {
    return {
        raw_text: text,
        estimated_time: extractPlanField(text, ["预计完成时间", "预计时间", "完成时间", "预计完成"]),
        steps: extractPlanItems(text, ["拆分步骤", "步骤", "计划"]),
        dependencies: extractPlanItems(text, ["依赖对象", "依赖"]),
        risks: extractPlanItems(text, ["风险点", "风险"]),
        need_help: parseNeedHelp(text)
    };
}

function extractPlanField(text: string, labels: string[]): string {
    const pattern = labels.join("|");
    const regex = new RegExp(`(?:${pattern})\\s*[:：]\\s*([^\\n；;]+)`);
    const match = regex.exec(text);
    return match ? match[1].trim() : "";
}

function extractPlanItems(text: string, labels: string[]): string[] {
    const pattern = labels.join("|");
    const allHeaders = "预计完成时间|预计时间|完成时间|预计完成|拆分步骤|步骤|计划|依赖对象|依赖|风险点|风险|是否需要协助|需要协助";
    const regex = new RegExp(`(?:${pattern})\\s*[:：]\\s*(.+?)(?=(?:${allHeaders})\\s*[:：]|$)`, "s");
    const match = regex.exec(text);
    if (!match) return [];
    
    const raw = match[1].trim();
    if (["无", "暂无", "没有"].includes(raw)) return [];
    
    return raw.split(/(?:\n+|\d+[.、)]|[；;])/).map(i => i.replace(/^[ -，,。；;\n]+/, "").replace(/[ -，,。；;\n]+$/, "")).filter(Boolean);
}

function parseNeedHelp(text: string): boolean {
    const match = text.match(/(?:是否需要协助|需要协助)\s*[:：]\s*([^\n；;]+)/);
    if (!match) return text.includes("需要协助") && !text.includes("不需要协助");
    const val = match[1].trim();
    return val.startsWith("是") || val.startsWith("需要") || val.includes("需要");
}

export async function updateTaskDue(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string, text: string): Promise<any> {
    const task = taskData as Task;
    task.due_date = dueDate;
    task.updated_at = utcNowIso();
    
    if (task.tapd_story_id) {
        // Need to update tapd due date
        // Just mock it here since tapd adapter doesn't have an explicit update_due method yet
    }
    
    ctx.store.saveTask(task);
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "due_date_updated", `更新截止时间为：${dueDate}`, source, message.id);
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `任务截止时间已更新：${task.title}${link} -> ${dueDate}`);
    
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 调整了任务截止时间：${dueDate}\n补充说明：${text}`);
    }
    ctx.store.appendAuditLog("task_due_updated", { task_id: task.id, due_date: dueDate });
    return { handled: true, action: "due_date_updated", task_id: task.id, due_date: dueDate };
}

export async function reply(ctx: HandlerContext, message: SourceMessage, source: string, text: string): Promise<any> {
    if (source === "group") return ctx.feishu.sendReplyText(message.id, text);
    return ctx.feishu.sendPrivateText(message.sender_open_id || "", text);
}

export async function updateTaskSupplement(ctx: HandlerContext, message: SourceMessage, source: string, taskData: any, dueDate: string | null, criteria: string[], text: string): Promise<any> {
    const task = taskData as Task;
    let updated = false;
    let supplementMsg = [];
    
    if (dueDate && task.due_date !== dueDate) {
        task.due_date = dueDate;
        supplementMsg.push(`截止时间更新为：${dueDate}`);
        updated = true;
    }
    
    if (criteria && criteria.length > 0) {
        task.acceptance_criteria = Array.from(new Set([...(task.acceptance_criteria || []), ...criteria]));
        supplementMsg.push(`验收标准补充为：${task.acceptance_criteria.join("；")}`);
        updated = true;
    }
    
    if (!updated) {
        await reply(ctx, message, source, "没有识别到需要补充的有效时间或验收标准。");
        return { handled: true, action: "supplement_ignored" };
    }
    
    task.updated_at = utcNowIso();
    
    ctx.store.saveTask(task);
    const content = supplementMsg.join("\n");
    saveUpdate(ctx, task, message.sender_open_id || "", message.sender_name || "", "task_supplemented", content, source, message.id);
    
    const link = task.tapd_url ? `\n🔗 详情：${task.tapd_url}` : "";
    await reply(ctx, message, source, `任务信息已补充：${task.title}${link}\n${content}`);
    
    if (source === "private" && task.source_message_id) {
        await notifySourceGroup(ctx, task, `负责人 ${message.sender_name} 补充了任务信息：\n${content}`);
    }
    ctx.store.appendAuditLog("task_supplemented", { task_id: task.id, due_date: task.due_date, acceptance_criteria: task.acceptance_criteria });
    return { handled: true, action: "task_supplemented", task_id: task.id };
}
