import { Standup, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';

export const STANDUP_KEYWORDS = ["昨日完成", "昨天完成", "今日计划", "今天计划", "阻塞", "风险", "需要决策"];

export function looksLikeStandup(text: string): boolean {
    let count = 0;
    for (const keyword of STANDUP_KEYWORDS) {
        if (text.includes(keyword)) {
            count++;
        }
    }
    return count >= 2;
}

export function parseStandup(openId: string, userName: string, text: string, messageId: string, today: Date = new Date()): Standup {
    const dateStr = dayjs(today).format('YYYY-MM-DD');
    let sections = {
        yesterday_done: extractSection(text, ["昨日完成", "昨天完成"]),
        today_plan: extractSection(text, ["今日计划", "今天计划"]),
        blockers: extractSection(text, ["阻塞/需要帮助", "阻塞", "需要帮助"]),
        risks: extractSection(text, ["风险/可能延期", "风险", "可能延期"]),
        decisions_needed: extractSection(text, ["需要决策", "决策"]),
    };
    
    if (!sections.yesterday_done.length && !sections.today_plan.length && !sections.blockers.length && !sections.risks.length && !sections.decisions_needed.length) {
        sections = parseNaturalLanguage(text);
    }
    
    return {
        id: `standup-${dateStr}-${openId}`,
        open_id: openId,
        user_name: userName,
        date: dateStr,
        yesterday_done: sections.yesterday_done,
        today_plan: sections.today_plan,
        blockers: sections.blockers,
        risks: sections.risks,
        decisions_needed: sections.decisions_needed,
        submitted_at: utcNowIso(),
        source_message_id: messageId,
        raw_text: text,
    };
}

function extractSection(text: string, names: string[]): string[] {
    const namePattern = names.map(escapeRegExp).join("|");
    const allHeaders = "昨日完成|昨天完成|今日计划|今天计划|阻塞/需要帮助|阻塞|需要帮助|风险/可能延期|风险|可能延期|需要决策|决策";
    const regex = new RegExp(`(?:【(?:${namePattern})】|(?:${namePattern})\\s*[:：])(.+?)(?=(?:【(?:${allHeaders})】|(?:${allHeaders})\\s*[:：])|$)`, "s");
    const match = regex.exec(text);
    if (!match) return [];
    return splitItems(match[1]);
}

function splitItems(value: string): string[] {
    const cleaned = value.trim();
    if (!cleaned || ["无", "暂无", "没有"].includes(cleaned)) return [];
    
    const parts = cleaned.split(/(?:\n+|\d+[.、)])/);
    return parts.map(part => part.replace(/^[ -，,。；;]+/, "").replace(/[ -，,。；;]+$/, "").trim())
                .filter(part => part && !["无", "暂无", "没有"].includes(part));
}

function parseNaturalLanguage(text: string): { yesterday_done: string[]; today_plan: string[]; blockers: string[]; risks: string[]; decisions_needed: string[]; } {
    const result: { yesterday_done: string[]; today_plan: string[]; blockers: string[]; risks: string[]; decisions_needed: string[]; } = {
        yesterday_done: [],
        today_plan: [],
        blockers: [],
        risks: [],
        decisions_needed: [],
    };
    
    const yesterday = text.match(/昨天(.+?)(?:今天|现在|目前|$)/);
    if (yesterday) result.yesterday_done = [yesterday[1].replace(/^[ ，,。]+/, "").replace(/[ ，,。]+$/, "").trim()];
    
    const today = text.match(/今天(.+?)(?:现在|目前|阻塞|风险|$)/);
    if (today) result.today_plan = [today[1].replace(/^[ ，,。]+/, "").replace(/[ ，,。]+$/, "").trim()];
    
    if (["卡住", "阻塞", "需要帮", "无法", "等待"].some(k => text.includes(k))) {
        result.blockers = [text.trim()];
    }
    
    if (["风险", "延期", "来不及"].some(k => text.includes(k))) {
        result.risks = [text.trim()];
    }
    
    return result;
}

function escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
