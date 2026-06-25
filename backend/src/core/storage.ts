import * as fs from 'fs';
import * as path from 'path';
import { BotMessageContext, DailySummary, DashboardArtifact, SourceMessage, Standup, Task, TaskUpdate } from '../models/types';

export class JsonStore {
    private dataDir: string;
    private idempotencyPath: string;
    private chatIdsPath: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        const subdirs = [
            "messages",
            "tasks",
            "updates",
            "standups",
            "standup_missing",
            "summaries",
            "dashboards",
            "logs",
            "contexts",
        ];
        for (const subdir of subdirs) {
            fs.mkdirSync(path.join(this.dataDir, subdir), { recursive: true });
        }
        this.idempotencyPath = path.join(this.dataDir, "idempotency.json");
        this.chatIdsPath = path.join(this.dataDir, "chat_ids.json");
        this._ensureJson(this.idempotencyPath, {});
        this._ensureJson(this.chatIdsPath, {});
    }

    private _ensureJson(filePath: string, defaultValue: any): void {
        if (!fs.existsSync(filePath)) {
            this._writeJson(filePath, defaultValue);
        }
    }

    private _writeJson(filePath: string, value: any): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
        fs.renameSync(tmp, filePath);
    }

    private _readJson(filePath: string, defaultValue: any): any {
        if (!fs.existsSync(filePath)) {
            return defaultValue;
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return defaultValue;
        }
    }

    private _listJson(subdir: string): any[] {
        const root = path.join(this.dataDir, subdir);
        if (!fs.existsSync(root)) return [];
        
        const files = fs.readdirSync(root).filter(f => f.endsWith('.json')).sort();
        return files.map(file => this._readJson(path.join(root, file), {}));
    }

    hasIdempotencyKey(key: string): boolean {
        const data = this._readJson(this.idempotencyPath, {});
        return key in data;
    }

    setIdempotencyKey(key: string, value: any): void {
        const data = this._readJson(this.idempotencyPath, {});
        data[key] = value;
        this._writeJson(this.idempotencyPath, data);
    }

    saveSourceMessage(message: SourceMessage): void {
        this._writeJson(path.join(this.dataDir, "messages", `${message.id}.json`), message);
    }

    getSourceMessage(messageId?: string | null): any {
        if (!messageId) return null;
        const filePath = path.join(this.dataDir, "messages", `${messageId}.json`);
        return fs.existsSync(filePath) ? this._readJson(filePath, null) : null;
    }

    listSourceMessages(): any[] {
        return this._listJson("messages");
    }

    saveTask(task: Task): void {
        this._writeJson(path.join(this.dataDir, "tasks", `${task.id}.json`), task);
    }

    getTask(taskId: string): any {
        const filePath = path.join(this.dataDir, "tasks", `${taskId}.json`);
        return fs.existsSync(filePath) ? this._readJson(filePath, null) : null;
    }

    findTask(identifier: string): any {
        const cleaned = identifier.trim();
        for (const task of this.listTasks()) {
            if (task.id === cleaned || task.tapd_story_id === cleaned) {
                return task;
            }
        }
        return null;
    }

    listTasks(): any[] {
        return this._listJson("tasks");
    }

    saveTaskUpdate(update: TaskUpdate): void {
        this._writeJson(path.join(this.dataDir, "updates", `${update.id}.json`), update);
    }

    listTaskUpdates(taskId?: string | null): any[] {
        let updates = this._listJson("updates");
        if (taskId) {
            updates = updates.filter(item => item.task_id === taskId);
        }
        return updates;
    }

    saveStandup(standup: Standup): void {
        const groupPath = standup.source_group_id || "global";
        const filePath = path.join(this.dataDir, "standups", standup.date, groupPath, `${standup.open_id}.json`);
        this._writeJson(filePath, standup);
    }

    listStandups(date: string, groupId?: string | null): any[] {
        const basePath = path.join(this.dataDir, "standups", date);
        if (!fs.existsSync(basePath)) return [];

        const items: any[] = [];
        
        if (groupId) {
            const groupPath = path.join(basePath, groupId);
            if (fs.existsSync(groupPath)) {
                fs.readdirSync(groupPath).filter(f => f.endsWith('.json')).forEach(file => {
                    items.push(this._readJson(path.join(groupPath, file), {}));
                });
            }
            // Fallback for old global data
            fs.readdirSync(basePath).forEach(file => {
                const stat = fs.statSync(path.join(basePath, file));
                if (stat.isFile() && file.endsWith('.json')) {
                    items.push(this._readJson(path.join(basePath, file), {}));
                }
            });
        } else {
            // Read recursively (2 levels deep max usually)
            const walk = (dir: string) => {
                fs.readdirSync(dir).forEach(file => {
                    const filePath = path.join(dir, file);
                    if (fs.statSync(filePath).isDirectory()) {
                        walk(filePath);
                    } else if (file.endsWith('.json')) {
                        items.push(this._readJson(filePath, {}));
                    }
                });
            };
            walk(basePath);
        }

        return items.sort((a, b) => (a.user_name || "").localeCompare(b.user_name || ""));
    }

    saveStandupMissing(date: string, payload: any): void {
        this._writeJson(path.join(this.dataDir, "standup_missing", `${date}.json`), payload);
    }

    getStandupMissing(date: string): any {
        const filePath = path.join(this.dataDir, "standup_missing", `${date}.json`);
        return fs.existsSync(filePath) ? this._readJson(filePath, null) : null;
    }

    saveDailySummary(summary: DailySummary): void {
        this._writeJson(path.join(this.dataDir, "summaries", `${summary.date}.json`), summary);
    }

    saveDashboardArtifact(artifact: DashboardArtifact): void {
        this._writeJson(path.join(this.dataDir, "dashboards", `${artifact.id}.json`), artifact);
    }

    saveBotMessageContext(context: BotMessageContext): void {
        this._writeJson(path.join(this.dataDir, "contexts", `${context.message_id}.json`), context);
    }

    getBotMessageContext(messageId?: string | null): any {
        if (!messageId) return null;
        const filePath = path.join(this.dataDir, "contexts", `${messageId}.json`);
        return fs.existsSync(filePath) ? this._readJson(filePath, null) : null;
    }

    listBotMessageContexts(): any[] {
        return this._listJson("contexts");
    }

    updateChatId(openId: string, chatId: string): void {
        const data = this._readJson(this.chatIdsPath, {});
        data[openId] = chatId;
        this._writeJson(this.chatIdsPath, data);
    }

    openIdForChatId(chatId: string): string | null {
        const data = this._readJson(this.chatIdsPath, {});
        for (const [openId, cachedChatId] of Object.entries(data)) {
            if (cachedChatId === chatId) {
                return openId;
            }
        }
        return null;
    }

    appendAuditLog(eventType: string, payload: any): void {
        const logPath = path.join(this.dataDir, "logs", "audit.jsonl");
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        const logEntry = {
            timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            event_type: eventType,
            payload
        };
        fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf-8');
    }
}
