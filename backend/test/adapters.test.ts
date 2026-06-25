import { test, expect, describe } from "bun:test";
import { LLMAdapter } from '@/adapters/llm';
import { TapdAdapter } from '@/adapters/tapd';
import { FeishuAdapter, FeishuEventParser } from '@/adapters/feishu';
import { AIConfig, TapdConfig, FeishuConfig } from '@/core/config';

describe("Adapters Loading", () => {
    test("should instantiate adapters successfully", () => {
        const aiConfig: AIConfig = { provider: "openai", api_base: "", api_key: "", model: "", max_tokens: 100, temperature: 0.1, retry_count: 1 };
        const llm = new LLMAdapter(aiConfig, true);
        expect(llm).toBeDefined();

        const tapdConfig: TapdConfig = { workspace_id: 1, api_token: "", api_base: "", workitem_type_id: "" };
        const tapd = new TapdAdapter(tapdConfig, true);
        expect(tapd).toBeDefined();

        const feishuConfig: FeishuConfig = { app_id: "", app_secret: "", bot_open_id: "", bot_name: "", lark_cli_path: "", verify_token: "", send_retry_count: 1 };
        const feishu = new FeishuAdapter(feishuConfig, true);
        expect(feishu).toBeDefined();

        const parser = new FeishuEventParser("bot123");
        expect(parser).toBeDefined();
    });
});
