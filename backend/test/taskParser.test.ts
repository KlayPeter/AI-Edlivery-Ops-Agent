import { test, expect, describe } from "bun:test";
import { parseTaskCommand, parseDueDateText } from '@/services/taskParser';
import { Mention } from '@/models/types';

describe("TaskParser", () => {
    test("should extract due date correctly", () => {
        const today = new Date("2026-06-25T12:00:00Z"); // Thursday
        expect(parseDueDateText("明天完成", today)).toBe("2026-06-26");
        expect(parseDueDateText("下周一完成", today)).toBe("2026-06-29");
        expect(parseDueDateText("2026-07-01完成", today)).toBe("2026-07-01");
    });

    test("should parse task command correctly", () => {
        const mentions: Mention[] = [
            { open_id: "bot_123", name: "Bot" },
            { open_id: "user_456", name: "张三" }
        ];
        
        const result = parseTaskCommand(
            "@Bot 创建任务：修复登录页面的Bug\n主负责人 @张三\n截止时间：下周三\n优先级：高\n验收标准：1. 登录正常；2. 报错清晰",
            mentions,
            "bot_123",
            new Date("2026-06-25T12:00:00Z"),
            false
        );

        expect(result.should_create).toBe(true);
        expect(result.title).toBe("修复登录页面的Bug");
        expect(result.primary_owner?.name).toBe("张三");
        expect(result.priority).toBe("P0");
        expect(result.due_date).toBe("2026-07-01");
        expect(result.acceptance_criteria.length).toBe(2);
    });
});
