import { AIConfig } from '@/core/config';

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

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

        let lastError = "";
        const attempts = Math.max(1, (this.config.retry_count || 1) + 1);
        
        let apiBase = this.config.api_base.replace(/\/+$/, '');
        if (!apiBase.endsWith('/v1') && apiBase.includes('openai')) {
            apiBase += '/v1';
        }
        const url = `${apiBase}/chat/completions`;

        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.config.api_key}`
                    },
                    body: JSON.stringify({
                        model: this.config.model,
                        messages,
                        temperature: this.config.temperature,
                        max_tokens: this.config.max_tokens,
                    })
                });

                const data: any = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error?.message || JSON.stringify(data));
                }

                return {
                    ok: true,
                    content: data.choices?.[0]?.message?.content || "",
                    raw: data
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
