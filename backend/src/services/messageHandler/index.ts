import { HandlerContext, WORKING_REACTION_MIN_SECONDS } from './types';
import { SourceMessage } from '@/models/types';
import { ContextResolver } from './ContextResolver';
import { isSystemNoise } from './utils';

// Handlers
import { DashboardHandler } from './handlers/DashboardHandler';
import { SummaryHandler } from './handlers/SummaryHandler';
import { StandupHandler } from './handlers/StandupHandler';
import { TaskCommandHandler } from './handlers/TaskCommandHandler';
import { StatusUpdateHandler } from './handlers/StatusUpdateHandler';
import { reply } from './statusUpdates';

export class MessageHandler {
    private ctx: HandlerContext;
    private resolver: ContextResolver;

    constructor(ctx: HandlerContext) {
        this.ctx = ctx;
        this.resolver = new ContextResolver(ctx);
    }

    async handleEvent(payload: any): Promise<any> {
        const message = this.ctx.feishu.parseEvent(payload);
        if (!message) return { handled: false, reason: "not_message_event" };

        let replyContext = await this.resolver.resolveReplyContext(message);
        
        const startedAt = Date.now();
        const reactionId = await this.addWorkingReaction(message);
        
        try {
            await this.ctx.store.saveSourceMessage(message);
            await this.ctx.store.appendAuditLog("source_message_received", {
                message_id: message.id,
                chat_id: message.chat_id,
                chat_type: message.chat_type,
                sent_at: message.sent_at,
                sender: message.sender_name,
                text: (message.text || "").substring(0, 200)
            });

            if (isSystemNoise(message.text || "")) {
                return { handled: false, reason: "system_noise" };
            }

            if (message.chat_type === "group") {
                return await this.handleGroupMessage(message, replyContext);
            }
            return await this.handlePrivateMessage(message, replyContext);
        } finally {
            if (reactionId) {
                if (!this.ctx.feishu.dryRun) {
                    const elapsed = (Date.now() - startedAt) / 1000.0;
                    if (elapsed < WORKING_REACTION_MIN_SECONDS) {
                        await new Promise(resolve => setTimeout(resolve, (WORKING_REACTION_MIN_SECONDS - elapsed) * 1000));
                    }
                }
                await this.ctx.feishu.removeReaction(message.id, reactionId);
            }
        }
    }

    private async handleGroupMessage(message: SourceMessage, replyContext: any): Promise<any> {
        const botMentioned = (message.mentions || []).some(m => m.open_id === this.ctx.config.feishu.bot_open_id);
        if (!botMentioned && !replyContext) {
            message.ai_result = { type: "ignored_group_chat" };
            message.confidence = 0.0;
            await this.ctx.store.saveSourceMessage(message);
            return { handled: false, reason: "not_directed_at_bot" };
        }

        if (replyContext && replyContext.context_type === "missing_task_field") {
            const originalText = replyContext.metadata?.original_text || "";
            if (originalText) message.text = `${originalText} ${message.text}`;
        }

        // Strategy / Chain of Responsibility Dispatch
        const handlers = [
            () => SummaryHandler.maybeHandle(this.ctx, message, "group"),
            () => DashboardHandler.maybeHandle(this.ctx, message, "group"),
            () => StatusUpdateHandler.maybeHandle(this.ctx, this.resolver, message, "group", replyContext),
            () => TaskCommandHandler.maybeHandle(this.ctx, this.resolver, message, "group", replyContext)
        ];

        for (const handler of handlers) {
            const result = await handler();
            if (result) return result;
        }

        // Fallback unrecognized command
        const isExplicit = (message.mentions || []).some(m => m.open_id === this.ctx.config.feishu.bot_open_id) || !!replyContext;
        if (isExplicit) {
            await reply(this.ctx, message, "group", "抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n- 创建/安排/子任务\n- 对我回复接受、打回、完成某任务\n- 回复具体进度\n- 生成/发送今日群聊日报");
            return { handled: true, action: "unrecognized_command", reason: "no_valid_intent_found" };
        }
        
        message.ai_result = { type: "ignored_group_chat" };
        message.confidence = 0.0;
        await this.ctx.store.saveSourceMessage(message);
        return { handled: false, reason: "not_directed_at_bot" };
    }

    private async handlePrivateMessage(message: SourceMessage, replyContext: any): Promise<any> {
        const { resolvePrivateSender } = require('./utils');
        const sender = await resolvePrivateSender(message, this.ctx);
        if (sender) {
            message.sender_open_id = sender.open_id;
            message.sender_name = sender.name;
            await this.ctx.store.saveSourceMessage(message);
        } else if (message.sender_open_id) {
            const defaultGroup = this.ctx.config.groups[0]?.chat_id || "";
            await this.ctx.feishu.sendGroupText(`无法识别私聊用户：${message.sender_open_id}。请管理员在配置 members 中绑定该用户后再处理。`, defaultGroup);
            await this.ctx.feishu.sendPrivateText(message.sender_open_id, "暂未识别你的身份，请联系管理员完成成员绑定。");
            await this.ctx.store.appendAuditLog("unknown_user", { open_id: message.sender_open_id, chat_id: message.chat_id });
            return { handled: true, action: "unknown_user" };
        }

        if (replyContext && replyContext.context_type === "missing_task_field") {
            const originalText = replyContext.metadata?.original_text || "";
            if (originalText) message.text = `${originalText} ${message.text}`;
        }

        // Strategy / Chain of Responsibility Dispatch
        const handlers = [
            () => StandupHandler.maybeHandle(this.ctx, message, "private", replyContext),
            () => TaskCommandHandler.maybeHandle(this.ctx, this.resolver, message, "private", replyContext),
            () => StatusUpdateHandler.maybeHandle(this.ctx, this.resolver, message, "private", replyContext)
        ];

        for (const handler of handlers) {
            const result = await handler();
            if (result) return result;
        }
        
        await reply(this.ctx, message, "private", "抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n- 创建任务、安排一下\n- 向我发送今日站会报告\n- 对我回复接受、打回、完成某任务\n- 更新任务具体进度\n- 生成/发送今日群聊日报");
        return { handled: true, action: "unrecognized_command", reason: "no_private_command" };
    }

    private async addWorkingReaction(message: SourceMessage): Promise<string | undefined> {
        const types = ["Typing", "TYPING", "Keyboard", "KEYBOARD", "Hacker", "ON_IT", "TODO", "DONE", "OK", "THUMBSUP"];
        const errors = [];
        for (const type of types) {
            const reactionId = await this.ctx.feishu.addReaction(message.id, type);
            if (reactionId) return reactionId;
            if (this.ctx.feishu.lastReactionError) errors.push({ emoji_type: type, error: this.ctx.feishu.lastReactionError });
        }
        if (errors.length && !this.ctx.feishu.dryRun) {
            this.ctx.store.appendAuditLog("working_reaction_failed", { message_id: message.id, errors });
        }
        return undefined;
    }
}
