import { PrismaStore } from '@/core/storage';
import { LLMAdapter } from '@/adapters/llm';
import { DailySummary, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';

export const TASK_HINTS = ["任务", "负责", "跟进", "处理", "完成", "联调", "提测", "修复"];
export const PROGRESS_HINTS = ["进度", "完成了", "已完成", "推进", "联调", "提测", "上线"];
export const BLOCKER_HINTS = ["阻塞", "卡住", "无法", "等待", "需要帮助", "需要协助", "失败"];
export const DECISION_HINTS = ["决定", "决策", "结论", "确认", "拍板", "定为"];
export const RISK_HINTS = ["风险", "延期", "来不及", "不稳定", "影响", "超期"];
export const SHARE_HINTS = ["分享", "文档", "链接", "资料", "http://", "https://"];

export const STATUS_MAP: Record<string, string> = {
    "pending_primary_owner": "待主负责人处理",
    "pending_confirmation": "待确认",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "blocked": "已阻塞",
    "owner_marked_done": "负责人已标记完成",
    "accepted": "已验收",
    "cancelled": "已取消",
    "overdue": "已超期",
};

export async function buildDailySummary(
    store: PrismaStore,
    groupId: string,
    day: Date = new Date(),
    llm?: LLMAdapter,
    period: string = "00:00-23:59"
): Promise<DailySummary> {
    const dDay = dayjs(day);
    const dateText = dDay.format('YYYY-MM-DD');
    
    let [startStr, endStr] = period.includes("-") ? period.split("-") : ["00:00", "23:59"];
    let [hStart, mStart] = startStr.split(":").map(Number);
    let [hEnd, mEnd] = endStr.split(":").map(Number);
    
    let startTime: dayjs.Dayjs;
    if (hStart > hEnd || (hStart === hEnd && mStart >= mEnd)) {
        startTime = dDay.subtract(1, 'day').hour(hStart).minute(mStart).second(0).millisecond(0);
    } else {
        startTime = dDay.hour(hStart).minute(mStart).second(0).millisecond(0);
    }
    const endTime = dDay.hour(hEnd).minute(mEnd).second(59).millisecond(999);

    function inPeriod(dtStr: string): boolean {
        if (!dtStr) return false;
        let dt: dayjs.Dayjs;
        if (/^\d+$/.test(dtStr)) {
            dt = dayjs(parseInt(dtStr));
        } else {
            dt = dayjs(dtStr);
        }
        if (!dt.isValid()) return false;
        return dt.isAfter(startTime) && dt.isBefore(endTime);
    }

    const sourceMessages = await store.listSourceMessages();
    const sourceMessagesById: Record<string, any> = {};
    for (const item of sourceMessages) {
        if (item.id) sourceMessagesById[item.id] = item;
    }
    const allTasks = (await store.listTasks()).filter((t: any) => t.status !== "deleted");
    const tasksById: Record<string, any> = {};
    const groupTaskIds = new Set<string>();
    for (const item of allTasks) {
        if (item.id) tasksById[item.id] = item;
        if (itemGroupId(item, sourceMessagesById) === groupId && item.id) {
            groupTaskIds.add(item.id);
        }
    }

    const messages = sourceMessages.filter(item => inPeriod(item.sent_at || "") && item.chat_id === groupId);
    
    const uniqueTasks = new Map<string, any>();
    allTasks
        .filter(item => inPeriod(item.created_at || "") && itemGroupId(item, sourceMessagesById) === groupId)
        .map(item => taskSummaryItem(item, sourceMessagesById))
        .forEach(item => uniqueTasks.set(item.title, item));
    const tasks = Array.from(uniqueTasks.values());

    const updates = (await store.listTaskUpdates())
        .filter(item => inPeriod(item.created_at || "") && (itemGroupId(item, sourceMessagesById) === groupId || groupTaskIds.has(item.task_id || "")))
        .map(item => updateSummaryItem(item, sourceMessagesById));
        
    const classified = await classifyMessages(messages, llm, store);
    
    const progressUpdates = [...updates, ...classified.progress_updates];
    const taskBlockers = allTasks
        .filter(item => item.status === "blocked" && blockedLongEnough(item) && itemGroupId(item, sourceMessagesById) === groupId)
        .map(item => riskSummaryItem(item, sourceMessagesById, "blocker"));
        
    const uniqueBlockers = new Map<string, any>();
    [
        ...updates.filter(item => item.type === "blocker" && blockedLongEnough(tasksById[item.task_id || ""])),
        ...taskBlockers,
        ...classified.blockers
    ].forEach(item => {
        const key = item.title || item.content || item.id;
        if (!uniqueBlockers.has(key)) uniqueBlockers.set(key, item);
    });
    const blockers = Array.from(uniqueBlockers.values());
    
    const uniqueRisks = new Map<string, any>();
    allTasks
        .filter(item => (item.status === "overdue" || (item.status === "blocked" && blockedLongEnough(item))) && itemGroupId(item, sourceMessagesById) === groupId)
        .map(item => riskSummaryItem(item, sourceMessagesById))
        .forEach(item => uniqueRisks.set(item.title, item));
        
    classified.risks.forEach(item => {
        if (!uniqueRisks.has(item.title)) {
            uniqueRisks.set(item.title, item);
        }
    });
    const risks = Array.from(uniqueRisks.values());
    
    const highlights = getHighlights(tasks, progressUpdates, blockers, classified.decisions, risks, classified.helps, classified.shares, classified.meetings);

    let aiAbstract = undefined;
    if (llm) {
        const prompt = `你是研发团队的助理，请根据以下今日统计数据，写一段 50 字左右的精炼总结，指出今日主要推进了什么，有多少风险/阻塞，语气要专业简练。\n任务数：${tasks.length}，进度数：${progressUpdates.length}，阻塞数：${blockers.length}，决策数：${classified.decisions.length}，风险数：${risks.length}`;
        try {
            const res = await llm.chat(prompt, "");
            if (res.ok && res.content.trim()) {
                aiAbstract = res.content.trim();
            } else if (!res.ok) {
                await store.appendAuditLog("ai_daily_summary_failed", { date: dateText, stage: "abstract", reason: res.error || "empty_response" });
            }
        } catch (exc: any) {
            await store.appendAuditLog("ai_daily_summary_failed", { date: dateText, stage: "abstract", reason: String(exc) });
        }
    }

    return {
        id: `summary-${dateText}`,
        group_id: groupId,
        date: dateText,
        highlights,
        tasks,
        progress_updates: progressUpdates,
        blockers,
        decisions: classified.decisions,
        risks,
        helps: classified.helps,
        shares: classified.shares,
        meetings: classified.meetings,
        created_at: utcNowIso(),
        ai_abstract: aiAbstract
    };
}

export function renderDailySummary(summary: DailySummary): string {
    const hasData = summary.highlights?.length || summary.tasks?.length || summary.progress_updates?.length || 
                    summary.blockers?.length || summary.decisions?.length || summary.risks?.length || 
                    summary.helps?.length || summary.shares?.length;
    if (!hasData) return "今日群内无可总结的有效工作信息。";
    
    const lines: string[] = [`【今日研发群聊总结｜${summary.date}】`, ""];
    if (summary.ai_abstract) {
        lines.push("🤖 AI 总结：", summary.ai_abstract, "");
    }
    
    lines.push("一、今日重点");
    const hls = summary.highlights?.length ? summary.highlights : ["暂无重点"];
    hls.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
    
    lines.push("", "二、任务与进度");
    if (summary.tasks?.length) {
        summary.tasks.forEach((task, idx) => {
            lines.push(`${idx + 1}. ${task.title || ''}`);
            lines.push(`   - 负责人：${task.primary_owner_name || ''}`);
            lines.push(`   - 当前状态：${STATUS_MAP[task.status] || task.status}`);
        });
    } else if (summary.progress_updates?.length) {
        summary.progress_updates.forEach((item, idx) => {
            const sender = senderName(item);
            lines.push(`${idx + 1}. ${sender}：${item.title || ''}`);
        });
    } else {
        lines.push("暂无新增任务。");
    }
    
    lines.push("", "三、阻塞事项");
    if (summary.blockers?.length) {
        summary.blockers.forEach((item, idx) => {
            const sender = senderName(item);
            lines.push(`${idx + 1}. ${sender}：${item.title || item.content || ''}`);
            const ai = item.ai_result || {};
            const related = (ai.related_users || []).join("、") || "待定";
            lines.push(`   - 需要协助人：${related}`);
            lines.push(`   - 建议动作：跟进解决阻塞`);
        });
    } else {
        lines.push("暂无明确阻塞。");
    }
    
    lines.push("", "四、决策结论");
    if (summary.decisions?.length) {
        summary.decisions.forEach((item, idx) => {
            const sender = senderName(item);
            lines.push(`${idx + 1}. ${sender}：${item.title || ''}`);
            const ai = item.ai_result || {};
            const related = (ai.related_users || []).join("、") || item.sender_name || '未知';
            lines.push(`   - 决策人：${related}`);
            lines.push(`   - 影响范围：团队全员或相关人`);
        });
    } else {
        lines.push("暂无明确决策。");
    }
    
    lines.push("", "五、风险提示");
    if (summary.risks?.length) {
        summary.risks.forEach((item, idx) => {
            const sender = senderName(item);
            const statusStr = item.status ? `，当前状态：${STATUS_MAP[item.status] || item.status}` : "";
            lines.push(`${idx + 1}. ${sender}：${item.title || ''}${statusStr}`);
            const ai = item.ai_result || {};
            const riskLevel = ai.risk_level || "中";
            lines.push(`   - 风险等级：${riskLevel}`);
            lines.push(`   - 建议动作：跟进风险情况`);
        });
    } else {
        lines.push("暂无明显风险。");
    }
    
    lines.push("", "六、资料分享");
    if (summary.shares?.length) {
        summary.shares.forEach((item, idx) => {
            const sender = senderName(item);
            lines.push(`${idx + 1}. ${sender}：${item.title || ''}`);
            const ai = item.ai_result || {};
            if (ai.url) lines.push(`   - 链接：${ai.url}`);
        });
    } else {
        lines.push("暂无资料分享。");
    }
    
    lines.push("", "七、求助问题");
    if (summary.helps?.length) {
        summary.helps.forEach((item, idx) => {
            const sender = senderName(item);
            lines.push(`${idx + 1}. ${sender}：${item.title || ''}`);
        });
    } else {
        lines.push("暂无求助问题。");
    }
    
    lines.push("", "八、会议/通知");
    if (summary.meetings?.length) {
        summary.meetings.forEach((item, idx) => {
            const sender = senderName(item);
            lines.push(`${idx + 1}. ${sender}：${item.title || ''}`);
        });
    } else {
        lines.push("暂无会议/通知。");
    }
    
    lines.push("", "九、需要管理者关注");
    const attention = [...(summary.blockers || []), ...(summary.risks || []), ...(summary.helps || [])];
    if (attention.length > 0) {
        const uniqueAttention = Array.from(new Map(attention.map(item => [item.title || item.content || item.id, item])).values());
        uniqueAttention.slice(0, 5).forEach((item: any, idx) => {
            lines.push(`${idx + 1}. ${item.title || item.content || ''}`);
        });
    } else {
        lines.push("暂无需要管理者特别关注的事项。");
    }
    
    return lines.join("\n");
}

function getHighlights(
    tasks: any[], progressUpdates: any[], blockers: any[], decisions: any[], risks: any[], helps: any[], shares: any[], meetings: any[]
): string[] {
    const values: string[] = [];
    if (tasks.length) values.push(`今日新增 ${tasks.length} 个显式任务。`);
    if (progressUpdates.length) values.push(`今日记录 ${progressUpdates.length} 条任务或进度信息。`);
    if (blockers.length) values.push(`今日记录 ${blockers.length} 条阻塞，需要关注协助动作。`);
    if (decisions.length) values.push(`今日沉淀 ${decisions.length} 条决策结论。`);
    if (risks.length) values.push(`${risks.length} 个任务存在阻塞或超期风险。`);
    if (helps.length) values.push(`今日收到 ${helps.length} 个求助问题。`);
    if (shares.length) values.push(`今日沉淀 ${shares.length} 条资料分享。`);
    if (meetings.length) values.push(`今日发布 ${meetings.length} 条会议或重要通知。`);
    return values.slice(0, 5);
}

async function classifyMessages(messages: any[], llm?: LLMAdapter, store?: PrismaStore): Promise<Record<string, any[]>> {
    if (llm) {
        const classified = await classifyMessagesWithAi(messages, llm, store);
        if (classified) return classified;
    }
    return classifyMessagesWithRules(messages);
}

function classifyMessagesWithRules(messages: any[]): Record<string, any[]> {
    const result = emptyClassification();
    for (const message of messages) {
        const text = String(message.text || "").trim();
        if (!text) continue;
        
        if (hasAny(text, BLOCKER_HINTS)) result.blockers.push(messageSummaryItem(message, "blocker", 0.72, "rule_daily_summary"));
        if (hasAny(text, RISK_HINTS)) result.risks.push(messageSummaryItem(message, "risk", 0.68, "rule_daily_summary"));
        if (hasAny(text, DECISION_HINTS)) result.decisions.push(messageSummaryItem(message, "decision", 0.7, "rule_daily_summary"));
        if (hasAny(text, SHARE_HINTS)) result.shares.push(messageSummaryItem(message, "share", 0.72, "rule_daily_summary"));
        if (hasAny(text, TASK_HINTS) || hasAny(text, PROGRESS_HINTS)) {
            result.progress_updates.push(messageSummaryItem(message, "progress", 0.62, "rule_daily_summary"));
        }
    }
    return result;
}

async function classifyMessagesWithAi(messages: any[], llm: LLMAdapter, store?: PrismaStore): Promise<Record<string, any[]> | null> {
    if (!messages.length) return emptyClassification();
    
    const payload = {
        messages: messages.map(item => ({
            id: item.id || "",
            sender_name: item.sender_name || "",
            sent_at: item.sent_at || "",
            text: item.text || "",
        }))
    };
    
    const system = "你是研发交付群聊日报分类器。只输出 JSON，不要 Markdown。从每条消息中识别 progress(进度更新)、blocker(阻塞事项)、decision(决策结论)、risk(风险提示)、help(求助问题)、share(资料分享)、meeting(会议/通知)，可一条消息产生多个 items。输出格式：{\"items\":[{\"message_id\":\"\",\"type\":\"progress|blocker|decision|risk|help|share|meeting\",\"title\":\"简短中文标题(如原文包含具体时间、截止日期等关键时间信息，必须在标题中完整保留)\",\"related_users\":[\"姓名\"],\"risk_level\":\"low|medium|high|\",\"url\":\"原文中的链接(如果有)\",\"confidence\":0.0}]}。重要：必须在 related_users 提取原文中出现的真实姓名，绝对不能输出 _user_1 这种占位符！如果没有特定协助人则留空。不要编造消息 ID；没有价值的闲聊/噪音不要输出 item。";
    
    const result = await llm.chat(system, JSON.stringify(payload));
    if (!result.ok || !result.content.trim()) {
        if (store) await store.appendAuditLog("ai_daily_summary_failed", { stage: "classification", reason: result.error || "empty_response", message_count: messages.length });
        return null;
    }
    
    let raw: any;
    try {
        raw = JSON.parse(extractJson(result.content));
    } catch (exc: any) {
        if (store) await store.appendAuditLog("ai_daily_summary_failed", { stage: "classification", reason: `invalid_json: ${exc.message}`, message_count: messages.length });
        return null;
    }
    
    const rawItems = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : []);
    if (!Array.isArray(rawItems)) {
        if (store) await store.appendAuditLog("ai_daily_summary_failed", { stage: "classification", reason: "items_not_list", message_count: messages.length });
        return null;
    }
    
    const messagesById: Record<string, any> = {};
    for (const msg of messages) if (msg.id) messagesById[msg.id] = msg;
    
    const classified = emptyClassification();
    for (const rawItem of rawItems) {
        if (typeof rawItem !== 'object' || !rawItem) continue;
        const itemType = normalizeSummaryType(rawItem.type);
        const messageId = firstMessageId(rawItem);
        const message = messagesById[messageId];
        
        if (!itemType || !message) continue;
        
        const confidence = parseConfidence(rawItem.confidence);
        if (confidence < 0.6) continue;
        
        let title = String(rawItem.title || "").trim() || compactTitle(message.text || "");
        if (confidence < 0.85 && confidence !== 1.0) title = `可能：${title}`;
        
        const aiResult: any = {
            type: itemType,
            parser: "llm_daily_summary",
            title,
            related_users: stringList(rawItem.related_users),
            risk_level: String(rawItem.risk_level || "").trim(),
            url: String(rawItem.url || "").trim()
        };
        const item = messageSummaryItem(message, itemType, confidence, "llm_daily_summary", title, aiResult);
        classified[summaryBucket(itemType)].push(item);
    }
    return classified;
}

function messageSummaryItem(message: any, itemType: string, confidence: number, parser: string = "llm_daily_summary", title?: string, aiResult?: any): any {
    const text = String(message.text || "").trim();
    const t = title || compactTitle(text);
    const ai = aiResult || { type: itemType, parser, title: t };
    const trace = messageTrace(message, ai, confidence);
    
    const item: any = {
        type: itemType,
        title: t,
        source_message_ids: trace.source_message_ids,
        source_group_id: trace.source_group_id,
        sender_open_id: trace.sender_open_id,
        sender_name: trace.sender_name,
        sent_at: trace.sent_at,
        raw_text: trace.raw_text,
        ai_result: ai,
        confidence,
        trace
    };
    if (ai.related_users) item.related_users = ai.related_users;
    if (ai.risk_level) item.risk_level = ai.risk_level;
    return item;
}

function taskSummaryItem(task: any, messagesById: Record<string, any>): any {
    const item = { ...task };
    const sourceMessageId = item.source_message_id;
    const aiResult = item.ai_result || { type: "task", parser: "structured_record", title: item.title || "" };
    const confidence = item.confidence !== undefined ? item.confidence : 1.0;
    const trace = item.trace || traceFromSource(item, messagesById, aiResult, confidence);
    
    item.type = "task";
    item.source_message_ids = sourceMessageId ? [sourceMessageId] : [];
    item.ai_result = aiResult;
    item.confidence = confidence;
    item.trace = trace;
    copyTraceToTopLevel(item, trace);
    return item;
}

function updateSummaryItem(update: any, messagesById: Record<string, any>): any {
    const item = { ...update };
    const sourceMessageId = item.source_message_id;
    const aiResult = item.ai_result || { type: item.update_type || "progress", parser: "structured_record" };
    const confidence = item.confidence !== undefined ? item.confidence : 1.0;
    const trace = item.trace || traceFromSource(item, messagesById, aiResult, confidence);
    
    item.type = item.update_type === "blocked" ? "blocker" : "progress";
    item.title = item.content || "";
    item.source_message_ids = sourceMessageId ? [sourceMessageId] : [];
    item.ai_result = aiResult;
    item.confidence = confidence;
    item.trace = trace;
    copyTraceToTopLevel(item, trace);
    return item;
}

function riskSummaryItem(task: any, messagesById: Record<string, any>, itemType: string = "risk"): any {
    const item = taskSummaryItem(task, messagesById);
    item.type = itemType;
    item.ai_result = { type: itemType, parser: "structured_record", title: item.title || "" };
    if (item.trace) item.trace.ai_result = item.ai_result;
    return item;
}

function senderName(item: any): string {
    return item.source_sender_name || item.sender_name || item.creator_name || "未知";
}

function blockedLongEnough(task: any): boolean {
    if (!task || task.status !== "blocked") return false;
    if (!task.blocked_at) return false;
    const blockedAt = dayjs(task.blocked_at);
    if (!blockedAt.isValid()) return false;
    return dayjs().diff(blockedAt, 'hour') >= 24;
}

function hasAny(text: string, keywords: string[]): boolean {
    return keywords.some(k => text.includes(k));
}

function compactTitle(text: string): string {
    const cleaned = text.replace(/\s+/g, ' ').replace(/^[ ，,。]+/, "").replace(/[ ，,。]+$/, "");
    return cleaned.length > 80 ? cleaned.substring(0, 80) + "..." : cleaned;
}

function emptyClassification(): Record<string, any[]> {
    return { progress_updates: [], blockers: [], decisions: [], risks: [], helps: [], shares: [], meetings: [] };
}

function messageTrace(message: any, aiResult: any, confidence: number): any {
    const messageId = String(message.id || "");
    return {
        source_group_id: String(message.chat_id || ""),
        source_message_id: messageId,
        source_message_ids: messageId ? [messageId] : [],
        sender_open_id: String(message.sender_open_id || ""),
        sender_name: String(message.sender_name || ""),
        sent_at: String(message.sent_at || ""),
        raw_text: String(message.text || ""),
        ai_result: aiResult,
        confidence
    };
}

function traceFromSource(item: any, messagesById: Record<string, any>, aiResult: any, confidence: number): any {
    const sourceMessageId = item.source_message_id;
    const message = messagesById[sourceMessageId || ""];
    if (message) return messageTrace(message, aiResult, confidence);
    
    return {
        source_group_id: String(item.source_group_id || ""),
        source_message_id: sourceMessageId || "",
        source_message_ids: sourceMessageId ? [sourceMessageId] : [],
        sender_open_id: String(item.source_sender_open_id || ""),
        sender_name: String(item.source_sender_name || ""),
        sent_at: String(item.source_sent_at || ""),
        raw_text: String(item.raw_text || ""),
        ai_result: aiResult,
        confidence
    };
}

function copyTraceToTopLevel(item: any, trace: any): void {
    if (trace.source_group_id) item.source_group_id = trace.source_group_id;
    if (trace.source_message_ids) item.source_message_ids = trace.source_message_ids;
    if (trace.sender_open_id) item.sender_open_id = trace.sender_open_id;
    if (trace.sender_name) item.sender_name = trace.sender_name;
    if (trace.sent_at) item.sent_at = trace.sent_at;
    if (trace.raw_text) item.raw_text = trace.raw_text;
}

function itemGroupId(item: any, messagesById: Record<string, any>): string {
    if (item.source_group_id) return String(item.source_group_id);
    const sourceMessageId = String(item.source_message_id || "");
    const msg = messagesById[sourceMessageId];
    return msg ? String(msg.chat_id || "") : "";
}

function normalizeSummaryType(value: any): string {
    const type = String(value || "").trim();
    return ["progress", "blocker", "decision", "risk", "help", "share", "meeting"].includes(type) ? type : "";
}

function summaryBucket(itemType: string): string {
    const map: Record<string, string> = {
        "progress": "progress_updates",
        "blocker": "blockers",
        "decision": "decisions",
        "risk": "risks",
        "help": "helps",
        "share": "shares",
        "meeting": "meetings",
    };
    return map[itemType];
}

function firstMessageId(item: any): string {
    if (item.message_id) return String(item.message_id).trim();
    if (item.source_message_id) return String(item.source_message_id).trim();
    if (Array.isArray(item.source_message_ids) && item.source_message_ids.length > 0) {
        return String(item.source_message_ids[0]).trim();
    }
    return "";
}

function parseConfidence(value: any): number {
    if (typeof value !== 'number') return 1.0;
    return Math.max(0.0, Math.min(value, 1.0));
}

function stringList(value: any): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(i => String(i || "").trim()).filter(i => i);
}

function extractJson(content: string): string {
    const text = content.trim();
    const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
    if (fenced) return fenced[1];
    
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end >= start) return text.substring(start, end + 1);
    return text;
}
