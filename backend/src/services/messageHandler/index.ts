import { HandlerContext, WORKING_REACTION_MIN_SECONDS } from './types';
import { SourceMessage, utcNowIso } from '../../models/types';
import { ContextResolver } from './ContextResolver';
import { stripBotMention, resolvePrivateSender, isSystemNoise, findTaskByTitle, parseIsoDatetime } from './utils';
import { parseTaskCommand, parseDueDateText, hasTaskIntent } from '../taskParser';
import { createTaskFromCommand, saveUpdate } from './taskCommands';
import { applyAction, saveTaskPlan, updateTaskDue, setTaskStatus, saveProgress, reply } from './statusUpdates';
import { maybeHandleAiIntent } from './aiActions';
import { buildDailySummary, renderDailySummary } from '../summaries';
import { ScheduledJobs } from '../jobs';
import { looksLikeStandup, parseStandup } from '../standup';
import dayjs from 'dayjs';

const PRIORITY_TO_TAPD_LABEL_MOCK: Record<string, string> = {
    "P0": "High",
    "P1": "Middle",
    "P2": "Low",
    "P3": "Low"
};

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

        let replyContext = this.resolver.resolveReplyContext(message);
        
        const startedAt = Date.now();
        const reactionId = await this.addWorkingReaction(message);
        
        try {
            this.ctx.store.saveSourceMessage(message);
            this.ctx.store.appendAuditLog("source_message_received", {
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
            this.ctx.store.saveSourceMessage(message);
            return { handled: false, reason: "not_directed_at_bot" };
        }

        if (replyContext && replyContext.context_type === "missing_task_field") {
            const originalText = replyContext.metadata?.original_text || "";
            if (originalText) message.text = `${originalText} ${message.text}`;
        }

        const summaryResult = await this.maybeHandleDailySummaryCommand(message);
        if (summaryResult) return summaryResult;

        const text = message.text || "";
        if (text.includes("生成今日进度看板") || text.includes("生成看板") || text.includes("进度看板")) {
            const targetGroup = this.ctx.config.groups.find(g => g.chat_id === message.chat_id);
            if (!targetGroup) return { handled: true, reason: "unknown_group_for_dashboard" };
            
            const artifact = this.ctx.dashboard.generateForGroup(targetGroup);
            const publish = await this.ctx.feishu.publishFile(artifact.html_path);
            
            if (publish.url) {
                artifact.public_url = publish.url;
                this.ctx.store.saveDashboardArtifact(artifact);
            }
            
            let replyText = "";
            if (publish.ok && artifact.public_url) {
                replyText = `今日进度看板已生成：\n${artifact.public_url}`;
                if (publish.warning) replyText += `\n\n${publish.warning}`;
            } else if (publish.ok && publish.warning) {
                replyText = `今日进度看板已生成，但飞书云盘共享未配置完成：\n${publish.warning}\n本地文件：${artifact.html_path}`;
            } else if (publish.ok) {
                replyText = `今日进度看板已生成：\n${artifact.html_path}`;
            } else {
                replyText = `今日进度看板已生成，但飞书云盘发布失败：\n${this.ctx.feishu.explainError(publish)}\n本地文件：${artifact.html_path}`;
            }
            
            await this.ctx.feishu.sendReplyText(message.id, replyText);
            this.ctx.store.appendAuditLog("dashboard_generated", { artifact_path: artifact.html_path, public_url: artifact.public_url });
            return { handled: true, action: "dashboard", artifact: artifact.html_path };
        }

        const statusResult = await this.maybeHandleStatusUpdate(message, "group", replyContext);
        if (statusResult) return statusResult;

        const command = parseTaskCommand(message.text || "", message.mentions || [], this.ctx.config.feishu.bot_open_id, undefined, false);
        if (!command.should_create) {
            if (hasTaskIntent(message.text || "")) {
                const fieldResult = await this.maybeReplyMissingTaskField(message, "group", command.reason);
                if (fieldResult) return fieldResult;
            }
            const aiResult = await maybeHandleAiIntent(this.ctx, this.resolver, message, "group", replyContext);
            if (aiResult) return aiResult;
            
            const isExplicit = (message.mentions || []).some(m => m.open_id === this.ctx.config.feishu.bot_open_id) || !!replyContext;
            if (isExplicit) {
                await reply(this.ctx, message, "group", "抱歉，我没有识别到有效的指令。\n目前支持的操作有：\n- 创建/安排任务\n- 对我回复接受、打回、完成某任务\n- 回复具体进度");
                return { handled: true, action: "unrecognized_command", reason: command.reason };
            }
            message.ai_result = { type: "ignored_group_chat" };
            message.confidence = 0.0;
            this.ctx.store.saveSourceMessage(message);
            return { handled: false, reason: "not_directed_at_bot" };
        }

        const key = `${message.id}:create_task`;
        if (this.ctx.store.hasIdempotencyKey(key)) return { handled: true, action: "idempotent_skip" };
        
        message.ai_result = {
            type: "task_command",
            parser: "rule",
            reason: command.reason,
            title: command.title,
            priority: command.priority,
            due_date: command.due_date
        };
        message.confidence = 1.0;
        this.ctx.store.saveSourceMessage(message);
        
        const contextualTask = this.resolver.contextualTask(message, replyContext, message.text);
        const parentId = contextualTask ? contextualTask.tapd_story_id : undefined;
        const result = await createTaskFromCommand(this.ctx, message, command, parentId);
        this.ctx.store.setIdempotencyKey(key, result);
        return result;
    }

    private async handlePrivateMessage(message: SourceMessage, replyContext: any): Promise<any> {
        const sender = resolvePrivateSender(message, this.ctx);
        if (sender) {
            message.sender_open_id = sender.open_id;
            message.sender_name = sender.name;
            this.ctx.store.saveSourceMessage(message);
        } else if (message.sender_open_id) {
            const defaultGroup = this.ctx.config.groups[0]?.chat_id || "";
            await this.ctx.feishu.sendGroupText(`无法识别私聊用户：${message.sender_open_id}。请管理员在配置 members 中绑定该用户后再处理。`, defaultGroup);
            await this.ctx.feishu.sendPrivateText(message.sender_open_id, "暂未识别你的身份，请联系管理员完成成员绑定。");
            this.ctx.store.appendAuditLog("unknown_user", { open_id: message.sender_open_id, chat_id: message.chat_id });
            return { handled: true, action: "unknown_user" };
        }

        if (replyContext && replyContext.context_type === "missing_task_field") {
            const originalText = replyContext.metadata?.original_text || "";
            if (originalText) message.text = `${originalText} ${message.text}`;
        }

        if (looksLikeStandup(message.text || "") || (replyContext && replyContext.context_type === "standup_prompt")) {
            const standup = parseStandup(message.sender_open_id || "", message.sender_name || "", message.text || "", message.id || "");
            standup.ai_result = { type: "standup", parser: "structured_or_natural_language" };
            
            this.ctx.store.saveStandup(standup);
            const linked = await this.linkStandupToTasks(standup, message);
            await this.ctx.feishu.sendPrivateText(message.sender_open_id || "", "已收到今日站会，谢谢。");
            this.ctx.store.appendAuditLog("standup_saved", { open_id: standup.open_id, standup_id: standup.id, linked_task_ids: linked });
            return { handled: true, action: "standup_saved", standup_id: standup.id, linked_task_ids: linked };
        }
        
        const command = parseTaskCommand(message.text || "", message.mentions || [], this.ctx.config.feishu.bot_open_id, undefined, true);
        if (command.should_create) {
            const key = `${message.id}:create_task`;
            if (this.ctx.store.hasIdempotencyKey(key)) return { handled: true, action: "idempotent_skip" };
            
            message.ai_result = {
                type: "task_command",
                parser: "rule",
                reason: command.reason,
                title: command.title,
                priority: command.priority,
                due_date: command.due_date
            };
            message.confidence = 1.0;
            this.ctx.store.saveSourceMessage(message);
            
            const contextualTask = this.resolver.contextualTask(message, replyContext, message.text);
            const parentId = contextualTask ? contextualTask.tapd_story_id : undefined;
            const result = await createTaskFromCommand(this.ctx, message, command, parentId);
            this.ctx.store.setIdempotencyKey(key, result);
            return result;
        } else if (hasTaskIntent(message.text || "")) {
            const fieldResult = await this.maybeReplyMissingTaskField(message, "private", command.reason);
            if (fieldResult) return fieldResult;
        }

        const statusResult = await this.maybeHandleStatusUpdate(message, "private", replyContext);
        if (statusResult) return statusResult;
        
        const aiResult = await maybeHandleAiIntent(this.ctx, this.resolver, message, "private", replyContext);
        if (aiResult) return aiResult;
        
        await reply(this.ctx, message, "private", "抱歉，我没有识别到有效的指令。\n你可以对我说：创建任务、安排一下，或者向我发送今日站会报告。");
        return { handled: true, action: "unrecognized_command", reason: "no_private_command" };
    }

    private async maybeHandleDailySummaryCommand(message: SourceMessage): Promise<any> {
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

        const targetGroup = this.ctx.config.groups.find(g => g.chat_id === message.chat_id);
        if (!targetGroup) {
            await reply(this.ctx, message, "private", "晚报生成只能在群聊中触发，或者我无法识别您所在的群聊。");
            return { handled: true, action: "daily_summary_failed" };
        }

        const period = targetGroup.daily_summary_period || "00:00-23:59";
        const jobs = new ScheduledJobs(this.ctx.config, this.ctx.store, this.ctx.feishu, this.ctx.dashboard);
        await jobs.backfillGroupMessagesForSummary(targetGroup.chat_id, targetDay.toDate(), period);
        
        const summary = await buildDailySummary(this.ctx.store, targetGroup.chat_id, targetDay.toDate(), this.ctx.intentParser?.llm, period);
        this.ctx.store.saveDailySummary(summary);
        
        const rendered = renderDailySummary(summary);
        await this.ctx.feishu.sendReplyText(message.id, rendered);
        this.ctx.store.appendAuditLog("daily_summary_generated", {
            date: targetDay.format('YYYY-MM-DD'),
            trigger: "group_command",
            source_message_id: message.id,
            group_id: targetGroup.chat_id
        });
        
        return { handled: true, action: "daily_summary", summary_id: summary.id, date: targetDay.format('YYYY-MM-DD') };
    }

    private messageDay(message: SourceMessage): Date {
        const val = String(message.sent_at || "");
        if (/^\d+$/.test(val)) return new Date(parseInt(val));
        const dt = parseIsoDatetime(val);
        return dt ? dt.toDate() : new Date();
    }

    private async maybeReplyMissingTaskField(message: SourceMessage, source: string, reason: string): Promise<any> {
        const prompts: Record<string, string> = {
            "no_assignee_mentioned": "请 @ 任务负责人后再创建任务。",
            "missing_title": "任务创建没有标题，请引用本条消息并补充任务标题，例如：标题是 xxx"
        };
        const text = prompts[reason];
        if (!text) return null;
        
        const res = await reply(this.ctx, message, source, text);
        if (res && res.message_id) {
            this.ctx.store.saveBotMessageContext({
                message_id: res.message_id,
                context_type: "missing_task_field",
                created_at: utcNowIso(),
                chat_id: message.chat_id,
                chat_type: message.chat_type,
                metadata: { original_text: message.text }
            });
        }
        this.ctx.store.appendAuditLog("task_field_missing", { message_id: message.id, reason });
        return { handled: true, action: "task_field_missing", reason };
    }

    private async maybeHandleStatusUpdate(message: SourceMessage, source: string, replyContext: any): Promise<any> {
        const text = stripBotMention(message, this.ctx).trim();

        if (replyContext && replyContext.context_type === "pending_primary_owner") {
            const match = /主负责人\s*/.exec(text);
            if (match) {
                const targetMention = (message.mentions || []).find(m => m.open_id !== this.ctx.config.feishu.bot_open_id);
                if (!targetMention) {
                    await reply(this.ctx, message, source, "请 @ 出主负责人。");
                    return { handled: true, action: "missing_mention" };
                }

                const taskId = replyContext.task_id;
                const taskData = this.ctx.store.getTask(taskId);
                if (!taskData) return { handled: true, action: "task_not_found" };

                taskData.primary_owner_open_id = targetMention.open_id;
                taskData.primary_owner_name = targetMention.name;
                if (!(taskData.assignee_open_ids || []).includes(targetMention.open_id)) {
                    taskData.assignee_open_ids = [...(taskData.assignee_open_ids || []), targetMention.open_id];
                    taskData.assignee_names = [...(taskData.assignee_names || []), targetMention.name];
                }

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

                const description = require('./taskCommands').taskDescription(message, command);
                const tapdResult = await this.ctx.tapd.createStory(
                    command.title,
                    targetMention.name,
                    command.tapd_priority_label,
                    command.due_date,
                    description,
                    taskData.parent_id
                );

                if (!tapdResult.ok) {
                    this.ctx.store.appendAuditLog("tapd_create_failed", { message_id: message.id, error: tapdResult.error });
                    await this.ctx.feishu.sendReplyText(message.id, `任务创建失败：${tapdResult.error || 'TAPD API 调用失败'}`);
                    return { handled: true, action: "tapd_create_failed", error: tapdResult.error };
                }

                taskData.tapd_story_id = tapdResult.story_id;
                taskData.tapd_url = tapdResult.url;
                taskData.status = "pending_confirmation";
                taskData.is_draft = false;
                taskData.updated_at = utcNowIso();

                this.ctx.store.saveTask(taskData);
                saveUpdate(this.ctx, taskData, message.sender_open_id || "", message.sender_name || "", "primary_owner_set", `指定主负责人：${targetMention.name}`, source, message.id);

                const privateText = require('./taskCommands').privateConfirmationText(taskData);
                const privateResult = await this.ctx.feishu.sendPrivateText(targetMention.open_id, privateText);
                if (privateResult.chat_id) this.ctx.store.updateChatId(targetMention.open_id, privateResult.chat_id);
                if (privateResult.message_id) {
                    this.ctx.store.saveBotMessageContext({
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
                const groupResult = await this.ctx.feishu.sendReplyText(message.id, require('./taskCommands').groupCreatedText(taskData));
                if (groupResult.message_id) {
                    this.ctx.store.saveBotMessageContext({
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
                this.ctx.store.appendAuditLog("task_created_after_owner_set", { task_id: taskData.id, title: taskData.title, owner: targetMention.name });
                return { handled: true, action: "task_created", task_id: taskData.id };
            }
        }

        const match = /(接受|拒绝|需要澄清|验收通过|打回)\s*([A-Za-z0-9_-]+|\d{6,})/.exec(text);
        if (match) {
            const action = match[1];
            const identifier = match[2];
            let taskData = this.ctx.store.findTask(identifier);
            if (!taskData) {
                await reply(this.ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
                return { handled: true, action: "task_not_found" };
            }
            return await applyAction(this.ctx, message, source, taskData, action, text);
        }

        const contextualTask = this.resolver.contextualTask(message, replyContext, text);
        if (contextualTask && replyContext && replyContext.context_type === "task_plan_request") {
            return await saveTaskPlan(this.ctx, message, source, contextualTask, text);
        }

        const dueRegex = /(?:截止时间|截止|完成时间)\s*(?:设置为|改为|调整为|设为|改到|到|[:：])/;
        const dueDate = (dueRegex.test(text) || (contextualTask && /(?:截止时间|截止|完成时间)\s*(?:设置为|改为|调整为|设为|改到|到|[:：])/.test(text))) ? parseDueDateText(text) : null;
        if (dueDate && contextualTask) return await updateTaskDue(this.ctx, message, source, contextualTask, dueDate, text);
        if (dueDate && !contextualTask) {
            await reply(this.ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_context_required" };
        }

        const contextAction = /^\s*(接受|拒绝|需要澄清|验收通过|打回)(?:[:：].+)?\s*$/.exec(text);
        if (contextAction && contextualTask) return await applyAction(this.ctx, message, source, contextualTask, contextAction[1], text);
        if (contextAction && !contextualTask) {
            await reply(this.ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
            return { handled: true, action: "task_context_required" };
        }

        const progressMatch = /任务\s+(.+?)\s*(已完成|完成了|阻塞了|阻塞|进度[:：])(.+)?/.exec(text);
        if (progressMatch) {
            const title = progressMatch[1].trim();
            const taskData = findTaskByTitle(title, this.ctx);
            if (!taskData) {
                await reply(this.ctx, message, source, "请引用对应任务消息回复，或直接带上任务ID。");
                return { handled: true, action: "task_not_found" };
            }
            const statusWord = progressMatch[2];
            if (statusWord.includes("阻塞")) return await setTaskStatus(this.ctx, message, source, taskData, "blocked", "blocked", text, "workflow_suspended");
            if (statusWord.includes("完成")) return await setTaskStatus(this.ctx, message, source, taskData, "owner_marked_done", "owner_marked_done", text, "status_3");
            return await saveProgress(this.ctx, message, source, taskData, text);
        }

        const directMatch = /(.+?)\s*(已完成|完成了|阻塞了|阻塞|进度[:：])(.+)?$/.exec(text);
        if (directMatch) {
            const title = directMatch[1].trim();
            if (title && !["任务", "这个任务", "该任务"].includes(title)) {
                const taskData = findTaskByTitle(title, this.ctx);
                if (taskData) {
                    const statusWord = directMatch[2];
                    if (statusWord.includes("阻塞")) return await setTaskStatus(this.ctx, message, source, taskData, "blocked", "blocked", text, "workflow_suspended");
                    if (statusWord.includes("完成")) return await setTaskStatus(this.ctx, message, source, taskData, "owner_marked_done", "owner_marked_done", text, "status_3");
                    return await saveProgress(this.ctx, message, source, taskData, text);
                }
            }
        }

        if (contextualTask) {
            if (/(已完成|完成了)/.test(text) && !/(没|不|未)完成/.test(text)) {
                return await setTaskStatus(this.ctx, message, source, contextualTask, "owner_marked_done", "owner_marked_done", text, "status_3");
            }
            if (/(阻塞|阻塞了)/.test(text) && !/(不|没|未)阻塞/.test(text)) {
                return await setTaskStatus(this.ctx, message, source, contextualTask, "blocked", "blocked", text, "workflow_suspended");
            }
            if (text.startsWith("进度") || (replyContext && replyContext.context_type === "task_confirmation")) {
                return await saveProgress(this.ctx, message, source, contextualTask, text);
            }
        }

        return null;
    }

    private async addWorkingReaction(message: SourceMessage): Promise<string | undefined> {
        const types = ["DONE", "OK", "THUMBSUP"];
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

    private async linkStandupToTasks(standup: any, message: SourceMessage): Promise<string[]> {
        const linked: string[] = [];
        const seen = new Set<string>();
        
        for (const item of [...(standup.yesterday_done || []), ...(standup.today_plan || [])]) {
            const taskData = this.matchStandupTask(item, standup.open_id);
            if (!taskData) continue;
            
            saveUpdate(this.ctx, taskData, standup.open_id, standup.user_name, "progress", `站会进度：${item}`, "standup", message.id);
            if (/(已完成|完成了|已经完成)/.test(item)) {
                await setTaskStatus(this.ctx, message, "private", taskData, "owner_marked_done", "owner_marked_done", `站会标记完成：${item}`, "status_3");
            }
            if (!seen.has(taskData.id)) {
                linked.push(taskData.id);
                seen.add(taskData.id);
            }
        }
        
        for (const item of (standup.blockers || [])) {
            const taskData = this.matchStandupTask(item, standup.open_id);
            if (!taskData) continue;
            
            await setTaskStatus(this.ctx, message, "private", taskData, "blocked", "blocked", `站会阻塞：${item}`, "workflow_suspended");
            if (!seen.has(taskData.id)) {
                linked.push(taskData.id);
                seen.add(taskData.id);
            }
        }
        
        return linked;
    }

    private matchStandupTask(item: string, openId: string): any {
        let bestTask = null;
        let bestScore = 0.0;
        
        for (const task of this.ctx.store.listTasks()) {
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

    private titleOverlapScore(text: string, title: string): number {
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

    private normalizeMatchText(value: string): string {
        let text = value.replace(/[\s，,。；;：:、/\\-]+/g, "");
        const tokens = ["任务", "父", "子", "昨天", "今日", "今天", "计划", "继续", "准备", "已经", "已完成", "完成了", "完成"];
        for (const token of tokens) text = text.split(token).join("");
        return text;
    }
}
