import { test, expect, describe } from "bun:test";
import { PrismaStore } from '@/core/storage';
import type { SourceMessage } from '@/models/types';

describe("PrismaStore", () => {
    const store = new PrismaStore();

    test("should save and read source message", async () => {
        const msg: SourceMessage = {
            id: "msg_123_test",
            chat_id: "chat_456",
            chat_type: "group",
            sender_open_id: "ou_789",
            sender_name: "Test User",
            text: "Hello World",
            message_type: "text",
            sent_at: new Date().toISOString(),
            raw_payload: {}
        };

        await store.saveSourceMessage(msg);
        const readMsg = await store.getSourceMessage("msg_123_test");
        expect(readMsg).not.toBeNull();
        expect(readMsg?.id).toBe("msg_123_test");
        expect(readMsg?.text).toBe("Hello World");
    });
});
