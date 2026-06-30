import { HandlerContext } from '../types';
import { SourceMessage, utcNowIso } from '@/models/types';
import { ContextResolver } from '../ContextResolver';
import { stripBotMention, findTaskByTitle } from '../utils';
import { parseDueDateText } from '@/services/taskParser';
import { applyAction, saveTaskPlan, updateTaskDue, setTaskStatus, saveProgress, reply } from '../statusUpdates';
import { saveUpdate } from '../taskCommands';

export class StatusUpdateHandler {
    static async maybeHandle(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        const text = stripBotMention(message, ctx).trim();

        if (replyContext && replyContext.context_type === "pending_primary_owner") {
            const match = /主负责人\s*/.exec(text);
            if (match) {
                return await this.handlePendingOwner(ctx, message, source, replyContext, text);
            }
        }

        const match = /(接受|拒绝|需要澄清|验收通过|打回|删除|取消)\s*([A-Za-z0-9_-]+|\d{6,})/.exec(text);
        if (match) {
            const action = match[1];
            const identifier = match[2];
            let taskData = await ctx.store.findTask(identifier);
            if (!taskData) {
                await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
                return { handled: true, action: "task_not_found" };
            }
            if (taskData.status === "deleted") {
                const link = taskData.tapd_url ? ` <a href="${taskData.tapd_url}">查看</a>` : "";
                await reply(ctx, message, source, `任务「${taskData.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await applyAction(ctx, message, source, taskData, action, text);
        }

        const contextualTask = await resolver.contextualTask(message, replyContext, text);
        if (contextualTask && replyContext && replyContext.context_type === "task_plan_request") {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? ` <a href="${contextualTask.tapd_url}">查看</a>` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await saveTaskPlan(ctx, message, source, contextualTask, text);
        }

        const dueRegex = /(?:截止时间|截止|完成时间)\s*(?:设置为|改为|调整为|设为|改到|到|[:：])/;
        const dueDate = (dueRegex.test(text) || (contextualTask && /(?:截止时间|截止|完成时间)\s*(?:设置为|改为|调整为|设为|改到|到|[:：])/.test(text))) ? parseDueDateText(text) : null;
        if (dueDate && contextualTask) {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? ` <a href="${contextualTask.tapd_url}">查看</a>` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await updateTaskDue(ctx, message, source, contextualTask, dueDate, text);
        }
        if (dueDate && !contextualTask) {
            await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_context_required" };
        }

        const contextAction = /^\s*(接受|拒绝|需要澄清|验收通过|打回|删除|取消)(?:[:：].+)?\s*$/.exec(text);
        if (contextAction && contextualTask) {
            if (contextualTask.status === "deleted") {
                const link = contextualTask.tapd_url ? ` <a href="${contextualTask.tapd_url}">查看</a>` : "";
                await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                return { handled: true, action: "task_deleted" };
            }
            return await applyAction(ctx, message, source, contextualTask, contextAction[1], text);
        }
        if (contextAction && !contextualTask) {
            await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_context_required" };
        }

        const progressMatch = /任务\s+(.+?)\s*(已完成|完成了|阻塞了|阻塞|进度[:：])(.+)?/.exec(text);
        if (progressMatch) {
            return await this.handleMatchedProgress(ctx, message, source, progressMatch[1].trim(), progressMatch[2], text);
        }

        const directMatch = /(.+?)\s*(已完成|完成了|阻塞了|阻塞|进度[:：])(.+)?$/.exec(text);
        if (directMatch) {
            const title = directMatch[1].trim();
            if (title && !["任务", "这个任务", "该任务"].includes(title)) {
                return await this.handleMatchedProgress(ctx, message, source, title, directMatch[2], text, true);
            }
        }

        if (contextualTask) {
            let handledAction = false;
            if (/(已完成|完成了)/.test(text) && !/(没|不|未)完成/.test(text)) handledAction = true;
            if (/(阻塞|阻塞了)/.test(text) && !/(不|没|未)阻塞/.test(text)) handledAction = true;
            if (text.startsWith("进度") || (replyContext && replyContext.context_type === "task_confirmation")) handledAction = true;
            
            if (handledAction) {
                if (contextualTask.status === "deleted") {
                    const link = contextualTask.tapd_url ? ` <a href="${contextualTask.tapd_url}">查看</a>` : "";
                    await reply(ctx, message, source, `任务「${contextualTask.title}」${link} 已经被删除。`);
                    return { handled: true, action: "task_deleted" };
                }
                if (/(已完成|完成了)/.test(text) && !/(没|不|未)完成/.test(text)) {
                    return await setTaskStatus(ctx, message, source, contextualTask, "owner_marked_done", "owner_marked_done", text, "status_3");
                }
                if (/(阻塞|阻塞了)/.test(text) && !/(不|没|未)阻塞/.test(text)) {
                    return await setTaskStatus(ctx, message, source, contextualTask, "blocked", "blocked", text, "workflow_suspended");
                }
                return await saveProgress(ctx, message, source, contextualTask, text);
            }
        }

        return null;
    }

    private static async handlePendingOwner(ctx: HandlerContext, message: SourceMessage, source: string, replyContext: any, text: string): Promise<any> {
        const targetMention = (message.mentions || []).find(m => m.open_id !== ctx.config.feishu.bot_open_id);
        if (!targetMention) {
            await reply(ctx, message, source, "请 @ 出主负责人。");
            return { handled: true, action: "missing_mention" };
        }

        const taskId = replyContext.task_id;
        const taskData = await ctx.store.getTask(taskId);
        if (!taskData) return { handled: true, action: "task_not_found" };

        taskData.primary_owner_open_id = targetMention.open_id;
        taskData.primary_owner_name = targetMention.name;
        if (!(taskData.assignee_open_ids || []).includes(targetMention.open_id)) {
            taskData.assignee_open_ids = [...(taskData.assignee_open_ids || []), targetMention.open_id];
            taskData.assignee_names = [...(taskData.assignee_names || []), targetMention.name];
        }

        const PRIORITY_TO_TAPD_LABEL_MOCK: Record<string, string> = { "P0": "High", "P1": "Middle", "P2": "Low", "P3": "Low" };
        const command = {
            should_create: true,
            reason: "owner_specified",
            title: taskData.title || "未命名任务",
            primary_owner: targetMention,
            assignees: (taskData.assignee_open_ids || []).map((oid: string, idx: number) => ({ open_id: oid, name: taskData.assignee_names[idx] })),
            priority: taskData.priority || "P2",
            tapd_priority_label: PRIORITY_TO_TAPD_LABEL_MOCK[taskData.priority || "P2"] || "Low",
            due_date: taskData.due_date,
            acceptance_criteria: taskData.acceptance_criteria || [],
            description: taskData.description || "",
            is_independent: false,
            missing_primary_owner: false,
            is_subtask: false
        };

        const { taskDescription, privateConfirmationText, groupCreatedText } = require('../taskCommands');
        const description = taskDescription(message, command);
        const tapdResult = await ctx.tapd.createStory(
            command.title,
            targetMention.name,
            command.tapd_priority_label,
            command.due_date,
            description,
            taskData.parent_id
        );

        if (!tapdResult.ok) {
            await ctx.store.appendAuditLog("tapd_create_failed", { message_id: message.id, error: tapdResult.error });
            await ctx.feishu.sendReplyText(message.id, `任务创建失败：${tapdResult.error || 'TAPD API 调用失败'}`);
            return { handled: true, action: "tapd_create_failed", error: tapdResult.error };
        }

        taskData.tapd_story_id = tapdResult.story_id;
        taskData.tapd_url = tapdResult.url;
        taskData.status = "pending_confirmation";
        taskData.is_draft = false;
        taskData.updated_at = utcNowIso();

        await ctx.store.saveTask(taskData);
        await saveUpdate(ctx, taskData, message.sender_open_id || "", message.sender_name || "", "primary_owner_set", `指定主负责人：${targetMention.name}`, source, message.id);

        const privateText = privateConfirmationText(taskData);
        const privateResult = await ctx.feishu.sendPrivateText(targetMention.open_id, privateText);
        if (privateResult.chat_id) await ctx.store.updateChatId(targetMention.open_id, privateResult.chat_id);
        if (privateResult.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: privateResult.message_id,
                context_type: "task_confirmation",
                created_at: utcNowIso(),
                chat_id: privateResult.chat_id || "",
                chat_type: "p2p",
                target_open_id: targetMention.open_id,
                task_id: taskData.id,
                task_title: taskData.title,
                metadata: { tapd_story_id: taskData.tapd_story_id || "" }
            });
        }
        const groupResult = await ctx.feishu.sendReplyText(message.id, groupCreatedText(taskData));
        if (groupResult.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: groupResult.message_id,
                context_type: "task_group_notice",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                chat_type: "group",
                task_id: taskData.id,
                task_title: taskData.title,
                metadata: { tapd_story_id: taskData.tapd_story_id || "" }
            });
        }
        await ctx.store.appendAuditLog("task_created_after_owner_set", { task_id: taskData.id, title: taskData.title, owner: targetMention.name });
        return { handled: true, action: "task_created", task_id: taskData.id };
    }

    private static async handleMatchedProgress(ctx: HandlerContext, message: SourceMessage, source: string, title: string, statusWord: string, text: string, optional: boolean = false): Promise<any> {
        const taskData = await findTaskByTitle(title, ctx);
        if (!taskData) {
            if (optional) return null;
            await reply(ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_not_found" };
        }
        if (taskData.status === "deleted") {
            const link = taskData.tapd_url ? ` <a href="${taskData.tapd_url}">查看</a>` : "";
            await reply(ctx, message, source, `任务「${taskData.title}」${link} 已经被删除。`);
            return { handled: true, action: "task_deleted" };
        }
        if (statusWord.includes("阻塞")) return await setTaskStatus(ctx, message, source, taskData, "blocked", "blocked", text, "workflow_suspended");
        if (statusWord.includes("完成")) return await setTaskStatus(ctx, message, source, taskData, "owner_marked_done", "owner_marked_done", text, "status_3");
        return await saveProgress(ctx, message, source, taskData, text);
    }
}
