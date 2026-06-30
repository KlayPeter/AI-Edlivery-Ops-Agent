import { LLMAdapter } from '@/adapters/llm';

export async function buildStandupSummaryWithLLM(
    llm: LLMAdapter,
    standups: any[],
    dateText: string,
    missingText: string
): Promise<{ ok: boolean, text?: string, error?: string }> {
    const payload = JSON.stringify(standups.map((s: any) => ({
        name: s.user_name,
        yesterday_done: s.yesterday_done || [],
        today_plan: s.today_plan || [],
        blockers: s.blockers || [],
        risks: s.risks || [],
        decisions_needed: s.decisions_needed || []
    })));

    const prompt = (
        `你是研发团队助理，请根据以下 JSON 格式的成员站会提交记录，生成今日站会汇总报告。\n` +
        `请严格按照以下格式输出，如果没有相关内容，请在该模块下写“暂无”：\n\n` +
        `【今日站会汇总｜${dateText}】\n\n` +
        `一、团队今日重点\n` +
        `1. xxx\n\n` +
        `二、昨日完成\n` +
        `- 张三：xxx\n\n` +
        `三、今日计划\n` +
        `- 张三：xxx\n\n` +
        `四、阻塞/需要帮助\n` +
        `1. [发起人姓名]：xxx\n` +
        `   - 相关人：xxx\n` +
        `   - 建议动作：xxx\n\n` +
        `五、风险/可能延期\n` +
        `1. [发起人姓名]：xxx\n` +
        `   - 风险等级：高 / 中 / 低\n` +
        `   - 建议动作：xxx\n\n` +
        `六、需要决策\n` +
        `1. [发起人姓名]：xxx\n` +
        `   - 建议决策人：xxx\n\n` +
        `请保持格式完全一致，不要输出多余的Markdown代码块符号（如\`\`\`）。`
    );

    const res = await llm.chat(prompt, payload);
    if (res.ok && res.content.trim()) {
        let text = res.content.trim();
        if (text.startsWith("```")) {
            const lines = text.split("\n");
            if (lines.length > 2) text = lines.slice(1, -1).join("\n").trim();
        }
        text += `\n\n七、未提交情况\n${missingText}`;
        return { ok: true, text };
    }
    return { ok: false, error: res.error || "empty_response" };
}

export function buildFallbackStandupSummary(standups: any[], dateText: string, missingText: string): string {
    const lines = [`【今日站会汇总｜${dateText}】`, "", "一、团队今日重点", "1. 暂无", "", "二、昨日完成"];
    for (const item of standups) {
        lines.push(`- ${item.user_name}：${(item.yesterday_done || []).join('；') || '暂无'}`);
    }
    lines.push("", "三、今日计划");
    for (const item of standups) {
        lines.push(`- ${item.user_name}：${(item.today_plan || []).join('；') || '暂无'}`);
    }
    lines.push("", "四、阻塞/需要帮助");
    const blockers = standups.flatMap((item: any) => (item.blockers || []).map((b: any) => ({ name: item.user_name, item: b })));
    if (blockers.length) {
        blockers.forEach((b: any, idx: number) => {
            lines.push(`${idx + 1}. ${b.name}：${b.item}`, "   - 相关人：待确认", "   - 建议动作：待确认");
        });
    } else {
        lines.push("暂无。");
    }
    lines.push("", "五、风险/可能延期", "暂无。", "", "六、需要决策", "暂无。", "", "七、未提交情况", missingText);
    return lines.join("\n");
}
