import { HandlerContext } from '../types';
import { SourceMessage } from '@/models/types';
import { buildDailySummary, renderDailySummary } from '@/services/summaries';
import { ScheduledJobs } from '@/services/jobs';
import dayjs from 'dayjs';
import { parseIsoDatetime } from '../utils';

export class SummaryHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private"): Promise<any> {
        if (source !== "group") return null;

        const text = message.text || "";
        const hasSummaryKeyword = ["日报", "日总结", "群聊总结", "研发总结", "每日总结"].some(k => text.includes(k));
        const hasAction = ["生成", "发", "查看", "看看", "给我", "来一份", "补", "拉", "汇总"].some(k => text.includes(k));
        
        if (!hasSummaryKeyword || !hasAction) return null;

        const explicit = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
        let targetDay = dayjs(this.messageDay(message));
        if (explicit) {
            targetDay = dayjs(`${explicit[1]}-${explicit[2]}-${explicit[3]}`);
        } else if (text.includes("前天")) {
            targetDay = targetDay.subtract(2, 'day');
        } else if (["昨日", "昨天"].some(k => text.includes(k))) {
            targetDay = targetDay.subtract(1, 'day');
        }

        const targetGroup = ctx.config.groups.find(g => g.chat_id === message.chat_id);
        if (!targetGroup) {
            await ctx.feishu.sendPrivateText(message.sender_open_id || "", "晚报生成只能在群聊中触发，或者我无法识别您所在的群聊。");
            return { handled: true, action: "daily_summary_failed" };
        }

        const period = targetGroup.daily_summary_period || "00:00-23:59";
        const jobs = new ScheduledJobs(ctx.config, ctx.store, ctx.feishu, ctx.dashboard, ctx.tapd);
        await jobs.backfillGroupMessagesForSummary(targetGroup.chat_id, targetDay.toDate(), period);
        
        const summary = await buildDailySummary(ctx.store, targetGroup.chat_id, targetDay.toDate(), ctx.intentParser?.llm, period);
        await ctx.store.saveDailySummary(summary);
        
        const rendered = renderDailySummary(summary);
        await ctx.feishu.sendReplyText(message.id, rendered);
        await ctx.store.appendAuditLog("daily_summary_generated", {
            date: targetDay.format('YYYY-MM-DD'),
            trigger: "group_command",
            source_message_id: message.id,
            group_id: targetGroup.chat_id
        });
        
        return { handled: true, action: "daily_summary", summary_id: summary.id, date: targetDay.format('YYYY-MM-DD') };
    }

    private static messageDay(message: SourceMessage): Date {
        const val = String(message.sent_at || "");
        if (/^\d+$/.test(val)) return new Date(parseInt(val));
        const dt = parseIsoDatetime(val);
        return dt ? dt.toDate() : new Date();
    }
}
