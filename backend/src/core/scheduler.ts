import { AppConfig } from './config';
import { PrismaStore } from './storage';
import { MessageHandler } from '@/services/messageHandler';
import { ScheduledJobs } from '@/services/jobs';
import { DashboardService } from '@/services/dashboard';
import { utcNowIso } from '@/models/types';
import dayjs from 'dayjs';

const JOB_TO_CONFIG_KEY: Record<string, string> = {
    "standup-push": "standup_push",
    "standup-second-remind": "standup_second_remind",
    "standup-mark-missing": "standup_mark_missing",
    "standup-summary": "standup_summary",
    "overdue-scan": "overdue_scan",
    "daily-summary": "daily_summary",
    "dashboard": "dashboard",
};

export class InProcessScheduler {
    private getHandler: () => MessageHandler;
    private intervalSeconds: number;
    private timer?: ReturnType<typeof setInterval>;

    constructor(getHandler: () => MessageHandler, intervalSeconds: number = 30) {
        this.getHandler = getHandler;
        this.intervalSeconds = intervalSeconds;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            try {
                this.tick(new Date());
            } catch (err) {
                try {
                    (this.getHandler() as any).ctx.store.appendAuditLog("scheduler_error", { at: utcNowIso() });
                } catch (e) {}
            }
        }, this.intervalSeconds * 1000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    async tick(now: Date): Promise<Record<string, string>> {
        const handler = this.getHandler();
        const ctx = (handler as any).ctx;
        const results: Record<string, string> = {};
        
        for (const group of ctx.config.groups) {
            const groupId = group.chat_id;
            if (!groupId) continue;

            for (const [jobName, configKey] of Object.entries(JOB_TO_CONFIG_KEY)) {
                const scheduledTime = (group.schedule as any)[configKey];
                if (!this.isDue(scheduledTime, now)) continue;
                
                if ((group.schedule as any)[`${configKey}_enabled`] === false) continue;
                
                const dateIso = dayjs(now).format('YYYY-MM-DD');
                const key = `scheduled:${jobName}:${groupId}:${dateIso}:${scheduledTime}`;
                
                if (await ctx.store.hasIdempotencyKey(key)) continue;
                
                await ctx.store.setIdempotencyKey(key, { started_at: utcNowIso(), job_name: jobName, group_id: groupId });
                
                try {
                    const payload = await this.runJob(handler, jobName, groupId, now);
                    await ctx.store.setIdempotencyKey(key, { completed_at: utcNowIso(), job_name: jobName, group_id: groupId, result: payload });
                    await ctx.store.appendAuditLog("job_completed", { job_name: jobName, group_id: groupId, trigger: "scheduler", result: payload });
                    results[`${jobName}:${groupId}`] = "completed";
                } catch (exc: any) {
                    await ctx.store.setIdempotencyKey(key, { failed_at: utcNowIso(), job_name: jobName, group_id: groupId, error: exc.message || String(exc) });
                    await ctx.store.appendAuditLog("job_failed", { job_name: jobName, group_id: groupId, trigger: "scheduler", error: exc.message || String(exc) });
                    results[`${jobName}:${groupId}`] = "failed";
                }
            }
        }
        return results;
    }

    private async runJob(handler: MessageHandler, jobName: string, groupId: string, day: Date) {
        const ctx = (handler as any).ctx;
        const llm = ctx.intentParser?.llm;
        const dashboard = new DashboardService(
            ctx.store,
            ctx.config.data_path,
            ctx.config.project.name,
            ctx.config.runtime.public_base_url
        );
        const jobs = new ScheduledJobs(ctx.config, ctx.store, ctx.feishu, dashboard, ctx.tapd, llm);
        
        switch (jobName) {
            case "standup-push": return await jobs.standupPush(groupId, day);
            case "standup-second-remind": return await jobs.standupSecondRemind(groupId, day);
            case "standup-mark-missing": return await jobs.standupMarkMissing(groupId, day);
            case "standup-summary": return await jobs.standupSummary(groupId, day);
            case "overdue-scan": return await jobs.overdueScan(groupId, day);
            case "daily-summary": return await jobs.dailySummary(groupId, day);
            case "dashboard": return await jobs.dashboardGenerate(groupId, day);
            default: throw new Error(`Unknown job: ${jobName}`);
        }
    }

    private isDue(scheduledTime: any, now: Date): boolean {
        if (typeof scheduledTime !== 'string') return false;
        try {
            const [hourText, minuteText] = scheduledTime.split(":", 2);
            return parseInt(hourText, 10) === now.getHours() && parseInt(minuteText, 10) === now.getMinutes();
        } catch {
            return false;
        }
    }
}
