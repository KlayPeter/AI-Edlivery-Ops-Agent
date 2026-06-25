import type { SourceMessage, Task, BotMessageContext } from '@/models/types';
import { utcNowIso } from '@/models/types';
import type { HandlerContext } from './types';
import dayjs from 'dayjs';

export function stripBotMention(message: SourceMessage, ctx: HandlerContext): string {
    let text = message.text || "";
    for (const mention of (message.mentions || [])) {
        if (mention.open_id !== ctx.config.feishu.bot_open_id) continue;
        const names = [mention.name, ctx.config.feishu.bot_name].filter(Boolean);
        for (const name of names) {
            if (!name) continue;
            const regex = new RegExp(`^\\s*@?${escapeRegExp(name)}\\s*`);
            text = text.replace(regex, "").trim();
        }
    }
    return text;
}

export function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sourceTrace(message: SourceMessage | any, aiResult?: any, confidence?: number): any {
    if ((message as SourceMessage).chat_type !== undefined) {
        const msg = message as SourceMessage;
        return {
            source_group_id: msg.chat_id || "",
            source_message_id: msg.id || "",
            source_message_ids: [msg.id || ""],
            sender_open_id: msg.sender_open_id || "",
            sender_name: msg.sender_name || "",
            sent_at: msg.sent_at || "",
            raw_text: msg.text || "",
            ai_result: aiResult || msg.ai_result || {},
            confidence: confidence !== undefined ? confidence : (msg.confidence || 0),
        };
    }
    const msgId = String(message.id || message.source_message_id || "");
    return {
        source_group_id: String(message.chat_id || message.source_group_id || ""),
        source_message_id: msgId,
        source_message_ids: msgId ? [msgId] : [],
        sender_open_id: String(message.sender_open_id || message.source_sender_open_id || ""),
        sender_name: String(message.sender_name || message.source_sender_name || ""),
        sent_at: String(message.sent_at || message.source_sent_at || ""),
        raw_text: String(message.text || message.raw_text || ""),
        ai_result: aiResult || message.ai_result || {},
        confidence: confidence !== undefined ? confidence : (message.confidence || 0),
    };
}

export function isSystemNoise(text: string): boolean {
    return text.includes("<system-reminder>") || text.includes("<cb_summary>") || text.startsWith("This is a summary");
}

export function resolvePrivateSender(message: SourceMessage, ctx: HandlerContext) {
    if (message.sender_open_id) return (ctx.config.groups.flatMap(g => g.members).find(m => m.open_id === message.sender_open_id));
    const openId = ctx.store.openIdForChatId(message.chat_id);
    return openId ? (ctx.config.groups.flatMap(g => g.members).find(m => m.open_id === openId)) : undefined;
}

export function findTaskByTitle(title: string, ctx: HandlerContext): any {
    for (const task of ctx.store.listTasks()) {
        const taskTitle = task.title || "";
        if (taskTitle.includes(title) || title.includes(taskTitle)) return task;
    }
    return undefined;
}

export function findUniqueTaskByTitle(title: string, ctx: HandlerContext): any {
    const candidates = [];
    for (const task of ctx.store.listTasks()) {
        const taskTitle = task.title || "";
        if (title === taskTitle || title.includes(taskTitle) || taskTitle.includes(title)) {
            candidates.push(task);
        }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
}

export function parseIsoDatetime(value: string): dayjs.Dayjs | null {
    if (!value) return null;
    const dt = dayjs(value.replace("Z", ""));
    return dt.isValid() ? dt : null;
}
