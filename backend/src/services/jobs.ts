import { AppConfig } from '@/core/config';
import { PrismaStore } from '@/core/storage';
import { FeishuAdapter } from '@/adapters/feishu';
import { LLMAdapter } from '@/adapters/llm';
import { DashboardService } from './dashboard';
import { buildDailySummary, renderDailySummary } from './summaries';
import { Task, TaskUpdate, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';

export class ScheduledJobs {
    config: AppConfig;
    store: PrismaStore;
    feishu: FeishuAdapter;
    private dashboard: DashboardService;
    private llm?: LLMAdapter;
    private tapd: any;

    constructor(config: AppConfig, store: PrismaStore, feishu: FeishuAdapter, dashboard: DashboardService, tapd: any, llm?: LLMAdapter) {
        this.config = config;
        this.store = store;
        this.feishu = feishu;
        this.dashboard = dashboard;
        this.tapd = tapd;
        this.llm = llm;
    }

    async standupPush(groupId: string, day: Date = new Date()): Promise<{ sent: number }> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        let count = 0;
        
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            for (const member of group.members) {
                if (!member.is_active) continue;
                
                const result = await this.feishu.sendPrivateText(
                    member.open_id,
                    `【${group.name || group.chat_id}】每日站会（${dateText}）\n\n${member.name}，请回复以下内容：\n\n【昨日完成】\n1.\n\n【今日计划】\n1.\n\n【阻塞/需要帮助】\n无\n\n【风险/可能延期】\n无\n\n【需要决策】\n无`
                );
                
                if (result.chat_id) await this.store.updateChatId(member.open_id, result.chat_id);
                if (result.message_id) {
                    await this.store.saveBotMessageContext({
                        message_id: result.message_id,
                        context_type: "standup_prompt",
                        created_at: utcNowIso(),
                        chat_id: result.chat_id || "",
                        chat_type: "p2p",
                        target_open_id: member.open_id,
                        metadata: { date: dateText, group_id: group.chat_id }
                    });
                }
                count++;
            }
        }
        return { sent: count };
    }

    async standupRemind(groupId: string, day: Date = new Date()): Promise<any> {
        return this._standupRemind(groupId, day, "first");
    }

    async standupSecondRemind(groupId: string, day: Date = new Date()): Promise<any> {
        return this._standupRemind(groupId, day, "second");
    }

    private async _standupRemind(groupId: string, day: Date = new Date(), stage: string = "first"): Promise<any> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const missing = await this.missingStandupMembers(groupId, day);
        let count = 0;
        
        const stageText = stage === "second" ? "今日站会仍未提交，如有阻塞也可以直接简要回复，我会帮你记录。" : "今日站会还未提交，请方便时补充一下。";
        
        for (const member of missing) {
            await this.feishu.sendPrivateText(member.open_id, `${member.name}，${stageText}`);
            count++;
        }
        
        await this.store.appendAuditLog("standup_reminder_sent", {
            date: dateText,
            stage,
            reminded: count,
            missing_open_ids: missing.map(m => m.open_id),
            missing_names: missing.map(m => m.name),
        });
        return { reminded: count, stage };
    }

    async standupMarkMissing(groupId: string, day: Date = new Date()): Promise<any> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const missing = await this.missingStandupMembers(groupId, day);
        const payload = {
            date: dateText,
            missing: missing.length,
            missing_open_ids: missing.map(m => m.open_id),
            missing_names: missing.map(m => m.name),
        };
        await this.store.saveStandupMissing(dateText, payload);
        await this.store.appendAuditLog("standup_missing_marked", payload);
        return { missing: missing.length };
    }

    async standupSummary(groupId: string, day: Date = new Date()): Promise<any> {
        const { buildStandupSummaryWithLLM, buildFallbackStandupSummary } = require('./standupLLM');
        const dateText = dayjs(day).format('YYYY-MM-DD');
        let totalSubmitted = 0;
        let totalMissing = 0;
        const allStandups = await this.store.listStandups(dateText);
        
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            const groupOpenIds = new Set(group.members.map(m => m.open_id));
            const standups = allStandups.filter((s: any) => groupOpenIds.has(s.open_id));
            const submitted = new Set(standups.map((s: any) => s.open_id));
            const missing = group.members.filter(m => m.is_active && !submitted.has(m.open_id)).map(m => m.name);
            
            if (standups.length === 0) {
                let missingText = `七、未提交情况\n- 未提交人数：${missing.length}`;
                if (this.config.runtime.public_missing_standups && missing.length) {
                    missingText += `\n- 未提交成员：${missing.join('、')}`;
                }
                await this.feishu.sendGroupText(`【今日站会汇总｜${dateText}】\n\n暂无站会提交。\n\n${missingText}`, group.chat_id);
                totalMissing += missing.length;
                continue;
            }

            let missingText = `- 未提交人数：${missing.length}`;
            if (this.config.runtime.public_missing_standups && missing.length) {
                missingText += `\n- 未提交成员：${missing.join('、')}`;
            }

            let sentAi = false;
            if (this.llm) {
                const res = await buildStandupSummaryWithLLM(this.llm, standups, dateText, missingText);
                if (res.ok && res.text) {
                    await this.feishu.sendGroupText(res.text, group.chat_id);
                    totalSubmitted += standups.length;
                    totalMissing += missing.length;
                    sentAi = true;
                } else {
                    await this.store.appendAuditLog("ai_standup_summary_failed", {
                        date: dateText,
                        reason: res.error || "empty_response",
                        submitted: standups.length,
                    });
                }
            }

            if (!sentAi) {
                const fallbackText = buildFallbackStandupSummary(standups, dateText, missingText);
                await this.feishu.sendGroupText(fallbackText, group.chat_id);
                totalSubmitted += standups.length;
                totalMissing += missing.length;
            }
        }
        return { submitted: totalSubmitted, missing: totalMissing };
    }

    async dailySummary(groupId: string, day: Date = new Date()): Promise<any> {
        const summaryIds = [];
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            const period = group.daily_summary_period || "00:00-23:59";
            await this.backfillGroupMessagesForSummary(group.chat_id, day, period);
            const summary = await buildDailySummary(this.store, group.chat_id, day, this.llm, period);
            await this.store.saveDailySummary(summary);
            const text = renderDailySummary(summary);
            await this.feishu.sendGroupText(text, group.chat_id);
            summaryIds.push(summary.id);
        }
        return { summary_ids: summaryIds.join(',') };
    }

    async dashboardGenerate(groupId: string, day: Date = new Date()): Promise<any> {
        const urls = [];
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            const artifact = await this.dashboard.generateForGroup(group, day);
            const publish = await this.feishu.publishFile(artifact.html_path);
            
            if (publish.url) {
                artifact.public_url = publish.url;
                await this.store.saveDashboardArtifact(artifact);
            }

            let text = "";
            if (publish.ok && artifact.public_url) {
                text = `今日进度看板已生成：\n${artifact.public_url}`;
                if (publish.warning) text += `\n\n${publish.warning}`;
            } else if (publish.ok && publish.warning) {
                text = `今日进度看板已生成，但飞书云盘共享未配置完成：\n${publish.warning}\n本地文件：${artifact.html_path}`;
            } else if (publish.ok) {
                text = `今日进度看板已生成：\n${artifact.html_path}`;
            } else {
                text = `今日进度看板已生成，但飞书云盘发布失败：\n${this.feishu.explainError(publish)}\n本地文件：${artifact.html_path}`;
            }

            await this.feishu.sendGroupText(text, group.chat_id);
            await this.store.appendAuditLog("dashboard_generated", { group_id: group.chat_id, artifact_path: artifact.html_path, public_url: artifact.public_url || "", trigger: "job" });
            urls.push(artifact.public_url || artifact.html_path);
        }
        return { artifacts: urls.join(',') };
    }

    async overdueScan(groupId: string, day: Date = new Date()): Promise<any> {
        const counts = { due_tomorrow: 0, due_today: 0, overdue_day1: 0, overdue_risk: 0 };
        const riskItems: Record<string, string[]> = {};
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            riskItems[group.chat_id] = [];
        }

        const now = dayjs(day);
        const tasks = await this.store.listTasks();
        
        for (const rawTask of tasks) {
            const due = rawTask.due_date;
            if (!due || ["accepted", "cancelled"].includes(rawTask.status || "")) continue;
            
            const taskGroupId = rawTask.source_group_id || "";
            if (!riskItems[taskGroupId]) continue;
            
            const dueDate = dayjs(due);
            if (!dueDate.isValid()) continue;
            
            const daysToDue = dueDate.diff(now, 'day');
            const link = rawTask.tapd_url ? ` <a href="${rawTask.tapd_url}">查看</a>` : "";
            
            if (daysToDue === 1) {
                if (await this.sendDueReminderOnce(rawTask, day, "due_tomorrow", `这个任务明天截止，请确认当前进展和风险。\n任务：${rawTask.title}${link}\n截止时间：${due}`)) {
                    counts.due_tomorrow++;
                }
            } else if (daysToDue === 0) {
                if (await this.sendDueReminderOnce(rawTask, day, "due_today", `这个任务今天截止，请同步当前进展。\n任务：${rawTask.title}${link}\n截止时间：${due}`)) {
                    counts.due_today++;
                }
            } else if (daysToDue === -1) {
                const changed = await this.markOverdueIfNeeded(rawTask, "overdue_day1");
                if (await this.sendDueReminderOnce(rawTask, day, "overdue_day1", `这个任务已超期 1 天，是否需要更新一下当前进展？\n任务：${rawTask.title}${link}\n原截止时间：${due}`)) {
                    counts.overdue_day1++;
                }
                if (changed) rawTask.status = "overdue";
            } else if (daysToDue <= -2) {
                await this.markOverdueIfNeeded(rawTask, "overdue_risk");
                if (await this.sendDueReminderOnce(rawTask, day, "overdue_risk", `这个任务已超期超过 2 天，已进入日报和看板风险，请尽快更新进展。\n任务：${rawTask.title}${link}\n原截止时间：${due}`)) {
                    counts.overdue_risk++;
                    const ownerText = this.config.runtime.public_overdue_owners ? `，负责人：${rawTask.primary_owner_name}` : "";
                    riskItems[taskGroupId].push(`${riskItems[taskGroupId].length + 1}. ${rawTask.title}${link}，原定 ${due} 完成${ownerText}，当前仍未完成。`);
                }
            }
        }
        
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            if (riskItems[group.chat_id].length) {
                await this.feishu.sendGroupText("以下任务存在延期风险：\n" + riskItems[group.chat_id].join("\n"), group.chat_id);
            }
        }
        return counts;
    }

    private async sendDueReminderOnce(task: any, day: Date, scenario: string, text: string): Promise<boolean> {
        if (task.tapd_story_id) {
            const tapdResult = await this.tapd.getStory(task.tapd_story_id);
            if (tapdResult && tapdResult.ok && tapdResult.raw && tapdResult.raw.data) {
                const stories = tapdResult.raw.data;
                if (Array.isArray(stories) && stories.length === 0) {
                    // Deleted on TAPD
                    task.status = "deleted";
                    await this.store.saveTask(task);
                    return false;
                }
                if (Array.isArray(stories) && stories.length > 0) {
                    const storyInfo = stories[0].Story || stories[0].story || stories[0];
                    if (storyInfo && ["resolved", "closed", "rejected", "done"].includes(String(storyInfo.status).toLowerCase())) {
                        task.status = "accepted";
                        await this.store.saveTask(task);
                        return false;
                    }
                }
            } else if (tapdResult && !tapdResult.ok && String(tapdResult.error).includes("404")) {
                task.status = "deleted";
                await this.store.saveTask(task);
                return false;
            }
        }

        const reminders = { ...(task.overdue_reminders || {}) };
        const lastSentStr = reminders[scenario];
        if (lastSentStr) {
            const lastSent = dayjs(lastSentStr);
            if (lastSent.isValid() && dayjs().diff(lastSent, 'hour') < this.taskReminderIntervalHours()) {
                return false;
            }
        }
        
        const owner = task.primary_owner_open_id || "";
        await this.feishu.sendPrivateText(owner, text);
        
        reminders[scenario] = utcNowIso();
        task.overdue_reminders = reminders;
        await this.store.saveTask(task as Task);
        await this.store.appendAuditLog("overdue_reminder_sent", { task_id: task.id, scenario, due_date: task.due_date });
        return true;
    }

    private async markOverdueIfNeeded(rawTask: any, reason: string): Promise<boolean> {
        if (rawTask.status === "overdue") return false;
        
        rawTask.status = "overdue";
        rawTask.updated_at = utcNowIso();
        const task = rawTask as Task;
        await this.store.saveTask(task);
        
        const updates = await this.store.listTaskUpdates(task.id);
        const count = updates.length;
        const update: TaskUpdate = {
            id: `update-${task.id}-${count + 1}`,
            task_id: task.id || "",
            user_open_id: "system",
            user_name: "系统",
            update_type: "overdue",
            content: `任务已超期：${task.due_date}`,
            source: "system",
            source_message_id: null,
            source_group_id: "",
            source_sender_open_id: "",
            source_sender_name: "",
            source_sent_at: "",
            raw_text: "",
            ai_result: {},
            confidence: 1.0,
            trace: {},
            created_at: utcNowIso(),
            metadata: { reason, due_date: task.due_date },
        };
        await this.store.saveTaskUpdate(update);
        await this.store.appendAuditLog("task_status_updated", { task_id: task.id, status: "overdue", update_type: "overdue", reason });
        return true;
    }

    private taskReminderIntervalHours(): number {
        const raw = this.config.schedule.task_reminder_frequency_hours;
        const hours = typeof raw === 'number' ? raw : 24;
        return Math.max(hours, 1);
    }

    private async missingStandupMembers(groupId: string, day: Date): Promise<any[]> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const standups = await this.store.listStandups(dateText);
        const submitted = new Set(standups.map((s: any) => s.open_id));
        const missing: any[] = [];
        
        for (const group of this.config.groups.filter(g => g.chat_id === groupId)) {
            for (const member of group.members) {
                if (member.is_active && !submitted.has(member.open_id)) {
                    missing.push(member);
                }
            }
        }
        return missing;
    }

    async backfillGroupMessagesForSummary(chatId: string, day: Date, period: string): Promise<void> {
        if (!this.config.runtime.daily_summary_fetch_history || !chatId) return;

        const { startTime, endTime } = this.summaryPeriodRange(day, period);
        let history: any[];
        
        try {
            history = []; // this.feishu.fetchChatHistory is not fully implemented in adapter
        } catch (exc: any) {
            await this.store.appendAuditLog("daily_summary_history_sync_failed", {
                date: dayjs(day).format('YYYY-MM-DD'),
                chat_id: chatId,
                reason: String(exc.message || exc),
            });
            return;
        }

        let synced = 0;
        let inserted = 0;
        
        for (const message of history) {
            const existed = !!(await this.store.getSourceMessage(message.id));
            await this.store.saveSourceMessage(message);
            synced++;
            if (!existed) inserted++;
        }

        await this.store.appendAuditLog("daily_summary_history_synced", {
            date: dayjs(day).format('YYYY-MM-DD'),
            chat_id: chatId,
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString(),
            synced,
            inserted,
        });
    }

    private summaryPeriodRange(day: Date, period: string): { startTime: Date, endTime: Date } {
        const parts = period.includes("-") ? period.split("-") : ["00:00", "23:59"];
        const [hStart, mStart] = parts[0].split(":").map(Number);
        const [hEnd, mEnd] = parts[1].split(":").map(Number);
        
        const now = dayjs(day);
        let startDay = now;
        if (hStart > hEnd || (hStart === hEnd && mStart >= mEnd)) {
            startDay = now.subtract(1, 'day');
        }
        
        const startTime = new Date(startDay.year(), startDay.month(), startDay.date(), hStart, mStart, 0);
        const endTime = new Date(now.year(), now.month(), now.date(), hEnd, mEnd, 59, 999);
        return { startTime, endTime };
    }
}
