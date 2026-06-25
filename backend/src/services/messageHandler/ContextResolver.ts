import { HandlerContext } from './types';
import { SourceMessage } from '@/models/types';
import { findTaskByTitle } from './utils';

export class ContextResolver {
    constructor(private ctx: HandlerContext) {}

    resolveReplyContext(message: SourceMessage): any {
        for (const msgId of [message.parent_id, message.root_id]) {
            if (!msgId) continue;
            const context = this.ctx.store.getBotMessageContext(msgId);
            if (context) return context;
            
            for (const task of this.ctx.store.listTasks()) {
                if (task.source_message_id === msgId) {
                    return {
                        context_type: "task_thread",
                        task_id: task.id,
                        task_title: task.title,
                        metadata: { tapd_story_id: task.tapd_story_id }
                    };
                }
            }
        }
        return null;
    }

    contextualTask(message: SourceMessage, replyContext: any, normalizedText?: string): any {
        if (replyContext && replyContext.task_id) {
            const task = this.ctx.store.getTask(replyContext.task_id);
            if (task) return task;
        }

        const text = normalizedText !== undefined ? normalizedText : (message.text || "");
        const normalized = (text.split("\n")[0] || "").trim();

        const hasIntent = /^(接受|拒绝|需要澄清|验收通过|打回)$/.test(normalized) ||
                          (/(已完成|完成了)/.test(normalized) && !/(没|不|未)完成/.test(normalized)) ||
                          (/(阻塞|阻塞了)/.test(normalized) && !/(不|没|未)阻塞/.test(normalized)) ||
                          normalized.startsWith("进度");

        if (!hasIntent) return null;

        const candidates = [];
        for (const task of this.ctx.store.listTasks()) {
            if (message.sender_open_id === task.primary_owner_open_id &&
                ["pending_confirmation", "confirmed", "in_progress", "blocked", "owner_marked_done"].includes(task.status || "")) {
                candidates.push(task);
            }
        }
        return candidates.length === 1 ? candidates[0] : null;
    }

    taskFromReplyContext(replyContext: any): any {
        if (replyContext && replyContext.task_id) {
            return this.ctx.store.getTask(replyContext.task_id);
        }
        return null;
    }

    shouldConsiderAi(message: SourceMessage, source: string, replyContext: any): boolean {
        if (source === "private") return true;
        if (replyContext) return true;
        return (message.mentions || []).some(m => m.open_id === this.ctx.config.feishu.bot_open_id);
    }
}
