import { HandlerContext } from '../types';
import { SourceMessage, utcNowIso } from '@/models/types';
import { ContextResolver } from '../ContextResolver';
import { parseTaskCommand, hasTaskIntent } from '@/services/taskParser';
import { createTaskFromCommand } from '../taskCommands';
import { maybeHandleAiIntent } from '../aiActions';
import { reply } from '../statusUpdates';

export class TaskCommandHandler {
    static async maybeHandle(ctx: HandlerContext, resolver: ContextResolver, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        const isPrivate = source === "private";
        const botOpenId = ctx.config.feishu.bot_open_id;
        
        const command = parseTaskCommand(message.text || "", message.mentions || [], botOpenId, undefined, isPrivate);
        
        if (command.should_create) {
            const key = `${message.id}:create_task`;
            if (await ctx.store.hasIdempotencyKey(key)) return { handled: true, action: "idempotent_skip" };
            
            message.ai_result = {
                type: "task_command",
                parser: "rule",
                reason: command.reason,
                title: command.title,
                priority: command.priority,
                due_date: command.due_date
            };
            message.confidence = 1.0;
            await ctx.store.saveSourceMessage(message);
            
            const contextualTask = await resolver.contextualTask(message, replyContext, message.text);
            const parentId = contextualTask ? contextualTask.tapd_story_id : undefined;
            const result = await createTaskFromCommand(ctx, message, command, parentId);
            await ctx.store.setIdempotencyKey(key, result);
            return result;
        }

        const aiResult = await maybeHandleAiIntent(ctx, resolver, message, source, replyContext);
        if (aiResult) return aiResult;
        
        if (hasTaskIntent(message.text || "")) {
            const fieldResult = await this.maybeReplyMissingTaskField(ctx, message, source, command.reason);
            if (fieldResult) return fieldResult;
        }

        return null; // Not a task command
    }

    private static async maybeReplyMissingTaskField(ctx: HandlerContext, message: SourceMessage, source: string, reason: string): Promise<any> {
        const prompts: Record<string, string> = {
            "no_assignee_mentioned": "请 @ 任务负责人后再创建任务。",
            "missing_title": "任务创建没有标题，请引用本条消息并补充任务标题，例如：标题是 xxx"
        };
        const text = prompts[reason];
        if (!text) return null;
        
        const res = await reply(ctx, message, source, text);
        if (res && res.message_id) {
            await ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "missing_task_field",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                chat_type: message.chat_type,
                metadata: { original_text: message.text }
            });
        }
        await ctx.store.appendAuditLog("task_field_missing", { message_id: message.id, reason });
        return { handled: true, action: "task_field_missing", reason };
    }
}
