import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { AIConfig } from '../core/config';

export interface LLMResult {
    ok: boolean;
    content: string;
    raw?: any;
    error?: string;
}

export class LLMAdapter {
    private config: AIConfig;
    private dryRun: boolean;

    constructor(config: AIConfig, dryRun: boolean = false) {
        this.config = config;
        this.dryRun = dryRun;
    }

    async chat(systemPrompt: string, userMessage: string): Promise<LLMResult> {
        if (this.dryRun || !this.config.api_key) {
            return { ok: true, content: "", raw: { dry_run: true } };
        }

        const openai = createOpenAI({
            baseURL: this.config.api_base,
            apiKey: this.config.api_key,
        });

        const messages: any[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

        let lastError = "";
        const attempts = Math.max(1, (this.config.retry_count || 1) + 1);

        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const { text, usage } = await generateText({
                    model: openai(this.config.model),
                    messages,
                    // maxTokens: this.config.max_tokens,
                    temperature: this.config.temperature,
                });

                return {
                    ok: true,
                    content: text,
                    raw: { usage }
                };
            } catch (error: any) {
                lastError = error.message || String(error);
                if (attempt === attempts - 1) {
                    return { ok: false, content: "", error: lastError };
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(Math.pow(2, attempt) * 1000, 5000)));
            }
        }
        return { ok: false, content: "", error: lastError || "llm_error" };
    }

    async summarize(items: any[], task: string): Promise<LLMResult> {
        const system = "你是研发交付中台的摘要助手。只输出可直接发送到飞书群的中文纯文本。";
        const user = JSON.stringify({ task, items }, null, 2);
        return this.chat(system, user);
    }
}
