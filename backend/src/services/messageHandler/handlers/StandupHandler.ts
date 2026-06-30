import { HandlerContext } from '../types';
import { SourceMessage } from '@/models/types';
import { looksLikeStandup, parseStandup } from '@/services/standup';
import { saveUpdate } from '../taskCommands';
import { setTaskStatus } from '../statusUpdates';

export class StandupHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private", replyContext: any): Promise<any> {
        if (source !== "private") return null;

        if (looksLikeStandup(message.text || "") || (replyContext && replyContext.context_type === "standup_prompt")) {
            const standup = parseStandup(message.sender_open_id || "", message.sender_name || "", message.text || "", message.id || "");
            standup.ai_result = { type: "standup", parser: "structured_or_natural_language" };
            
            await ctx.store.saveStandup(standup);
            const linked = await this.linkStandupToTasks(ctx, standup, message);
            await ctx.feishu.sendPrivateText(message.sender_open_id || "", "已收到今日站会，谢谢。");
            await ctx.store.appendAuditLog("standup_saved", { open_id: standup.open_id, standup_id: standup.id, linked_task_ids: linked });
            return { handled: true, action: "standup_saved", standup_id: standup.id, linked_task_ids: linked };
        }
        return null;
    }

    private static async linkStandupToTasks(ctx: HandlerContext, standup: any, message: SourceMessage): Promise<string[]> {
        const linked: string[] = [];
        const seen = new Set<string>();
        
        for (const item of [...(standup.yesterday_done || []), ...(standup.today_plan || [])]) {
            const taskData = await this.matchStandupTask(ctx, item, standup.open_id);
            if (!taskData) continue;
            
            await saveUpdate(ctx, taskData, standup.open_id, standup.user_name, "progress", `站会进度：${item}`, "standup", message.id);
            if (/(已完成|完成了|已经完成)/.test(item)) {
                await setTaskStatus(ctx, message, "private", taskData, "owner_marked_done", "owner_marked_done", `站会标记完成：${item}`, "status_3");
            }
            if (!seen.has(taskData.id)) {
                linked.push(taskData.id);
                seen.add(taskData.id);
            }
        }
        
        for (const item of (standup.blockers || [])) {
            const taskData = await this.matchStandupTask(ctx, item, standup.open_id);
            if (!taskData) continue;
            
            await setTaskStatus(ctx, message, "private", taskData, "blocked", "blocked", `站会阻塞：${item}`, "workflow_suspended");
            if (!seen.has(taskData.id)) {
                linked.push(taskData.id);
                seen.add(taskData.id);
            }
        }
        
        return linked;
    }

    private static async matchStandupTask(ctx: HandlerContext, item: string, openId: string): Promise<any> {
        let bestTask = null;
        let bestScore = 0.0;
        
        for (const task of await ctx.store.listTasks()) {
            if (["accepted", "cancelled"].includes(task.status || "")) continue;
            if (openId !== task.primary_owner_open_id && !(task.assignee_open_ids || []).includes(openId)) continue;
            
            const score = this.titleOverlapScore(item, task.title || "");
            if (score > bestScore) {
                bestTask = task;
                bestScore = score;
            }
        }
        return bestScore >= 0.45 ? bestTask : null;
    }

    private static titleOverlapScore(text: string, title: string): number {
        const normalizedText = this.normalizeMatchText(text);
        const normalizedTitle = this.normalizeMatchText(title);
        
        if (!normalizedText || !normalizedTitle) return 0.0;
        if (normalizedTitle.includes(normalizedText) || normalizedText.includes(normalizedTitle)) return 1.0;
        
        const titleChars = new Set(normalizedTitle.split(''));
        const textChars = new Set(normalizedText.split(''));
        let common = 0;
        for (const char of titleChars) if (textChars.has(char)) common++;
        
        if (common < 4) return 0.0;
        return common / titleChars.size;
    }

    private static normalizeMatchText(value: string): string {
        let text = value.replace(/[\s，,。；;：:、/\\-]+/g, "");
        const tokens = ["任务", "父", "子", "昨天", "今日", "今天", "计划", "继续", "准备", "已经", "已完成", "完成了", "完成"];
        for (const token of tokens) text = text.split(token).join("");
        return text;
    }
}
