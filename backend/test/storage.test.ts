import { test, expect, describe } from "bun:test";
import { JsonStore } from '@/core/storage';
import * as path from "path";
import * as fs from "fs";
import type { SourceMessage } from '@/models/types';

describe("JsonStore", () => {
    const testDir = path.join(process.cwd(), "test_data");
    const store = new JsonStore(testDir);

    test("should initialize directories", () => {
        expect(fs.existsSync(path.join(testDir, "messages"))).toBe(true);
        expect(fs.existsSync(path.join(testDir, "idempotency.json"))).toBe(true);
    });

    test("should save and read source message", () => {
        const msg: SourceMessage = {
            id: "msg_123",
            chat_id: "chat_456",
            chat_type: "group",
            sender_open_id: "ou_789",
            sender_name: "Test User",
            text: "Hello World",
            message_type: "text",
            sent_at: new Date().toISOString(),
            raw_payload: {}
        };

        store.saveSourceMessage(msg);
        const readMsg = store.getSourceMessage("msg_123");
        expect(readMsg).not.toBeNull();
        expect(readMsg.id).toBe("msg_123");
        expect(readMsg.text).toBe("Hello World");
    });
});
