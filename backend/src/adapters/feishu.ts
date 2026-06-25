import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import axios from 'axios';
import { FeishuConfig } from '../core/config';
import { SourceMessage, Mention, utcNowIso } from '../models/types';

const execFileAsync = promisify(execFile);

export const WORKING_REACTION_EMOJI_TYPES = ["Typing", "OnIt"];
export const WORKING_REACTION_EMOJI_TYPE = WORKING_REACTION_EMOJI_TYPES[0];

export interface SendResult {
    ok: boolean;
    raw: any;
    chat_id?: string;
    message_id?: string;
    file_token?: string;
    url?: string;
    error?: string;
    warning?: string;
}

export class FeishuEventParser {
    private botOpenId: string;
    private knownNames: Record<string, string>;

    constructor(botOpenId: string, knownNames: Record<string, string> = {}) {
        this.botOpenId = botOpenId;
        this.knownNames = knownNames;
    }

    parse(payload: any): SourceMessage | null {
        const event = payload?.event || {};
        const message = event.message || {};
        const sender = event.sender || {};
        if (Object.keys(message).length === 0) return null;

        const messageId = message.message_id || message.message_id_v2 || message.root_id || utcNowIso();
        const senderOpenId = sender.sender_id?.open_id || "";
        const senderName = this.knownNames[senderOpenId] || senderOpenId || "unknown";

        const mentionsRaw: any[] = message.mentions || [];
        const mentions: Mention[] = mentionsRaw
            .map(m => this._parseMention(m))
            .filter(m => !!m.open_id);

        return {
            id: messageId,
            chat_id: message.chat_id || "",
            chat_type: message.chat_type || "private",
            sender_open_id: senderOpenId,
            sender_name: senderName,
            text: this._extractText(message.content || ""),
            message_type: message.message_type || "text",
            sent_at: message.create_time || utcNowIso(),
            raw_payload: payload,
            mentions,
            parent_id: message.parent_id,
            root_id: message.root_id
        };
    }

    private _extractText(content: string): string {
        if (!content) return "";
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            return content;
        }

        if (parsed.text) return parsed.text;

        if (parsed.content && Array.isArray(parsed.content)) {
            const lines: string[] = [];
            if (parsed.title) lines.push(parsed.title);
            for (const lineElements of parsed.content) {
                if (Array.isArray(lineElements)) {
                    let lineText = "";
                    for (const el of lineElements) {
                        if (el.tag === 'text' || el.tag === 'a') {
                            lineText += el.text || "";
                        } else if (el.tag === 'at') {
                            let name = el.user_name || el.name || "";
                            if (this.knownNames[el.user_id] && (!name || name.startsWith('_user_') || name === 'User')) {
                                name = this.knownNames[el.user_id];
                            } else if (!name || name.startsWith('_user_')) {
                                name = "未知成员";
                            }
                            lineText += `@${name} `;
                        }
                    }
                    lines.push(lineText);
                }
            }
            if (lines.length > 0) return lines.join('\n');
        }

        return parsed.title || content;
    }

    private _parseMention(raw: any): Mention {
        const mentionId = raw.id || {};
        const openId = raw.open_id || mentionId.open_id || raw.user_id || "";
        let name = raw.name || raw.key || "";
        if ((!name || name.startsWith("_user_")) && this.knownNames[openId]) {
            name = this.knownNames[openId];
        } else if (!name || name.startsWith("_user_")) {
            name = "未知成员";
        }
        return { open_id: openId, name };
    }
}

export class FeishuAdapter {
    private config: FeishuConfig;
    public dryRun: boolean;
    public lastReactionError: string | null = null;
    private auditCallback?: (eventType: string, payload: any) => void;
    private tokenCache: string | null = null;
    private tokenExpires: number = 0;

    constructor(config: FeishuConfig, dryRun: boolean = false) {
        this.config = config;
        this.dryRun = dryRun;
    }

    private async _getTenantAccessToken(): Promise<string> {
        if (this.tokenCache && this.tokenExpires > Date.now()) {
            return this.tokenCache;
        }

        const url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
        try {
            const resp = await axios.post(url, {
                app_id: this.config.app_id,
                app_secret: this.config.app_secret
            });
            if (resp.data.code === 0) {
                this.tokenCache = resp.data.tenant_access_token;
                this.tokenExpires = Date.now() + (resp.data.expire * 1000) - 60000;
                return this.tokenCache!;
            }
            throw new Error(`Token Error: ${JSON.stringify(resp.data)}`);
        } catch (e) {
            throw new Error(`Network error getting token: ${e}`);
        }
    }

    setAuditCallback(callback: (eventType: string, payload: any) => void) {
        this.auditCallback = callback;
    }

    async sendGroupText(text: string, chatId: string): Promise<SendResult> {
        const result = await this._send(["--chat-id", chatId], text);
        this._auditSend("group", chatId, text, result);
        return result;
    }

    async sendPrivateText(openId: string, text: string): Promise<SendResult> {
        const result = await this._send(["--user-id", openId], text);
        this._auditSend("private", openId, text, result);
        return result;
    }

    async sendReplyText(messageId: string, text: string): Promise<SendResult> {
        if (!messageId) {
            const res = { ok: false, raw: {}, error: "message_id is required for reply" };
            this._auditSend("reply", messageId, text, res);
            return res;
        }
        const result = await this._sendReply(messageId, text);
        this._auditSend("reply", messageId, text, result);
        return result;
    }

    async uploadFile(filePath: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, filePath }, url: filePath };
        const resolvedPath = path.resolve(filePath);
        try {
            const proc = await this._runWithRetry(
                [this.config.lark_cli_path, "drive", "+upload", "--as", "bot", "--file", `./${path.basename(resolvedPath)}`],
                120000,
                path.dirname(resolvedPath)
            );
            return this._resultFromProcess(proc);
        } catch (e: any) {
            return { ok: false, raw: {}, error: String(e) };
        }
    }

    async publishFile(filePath: string, shareLinkEntity: string = "tenant_readable"): Promise<SendResult> {
        const upload = await this.uploadFile(filePath);
        if (!upload.ok || this.dryRun || !upload.file_token) return upload;

        const permission = await this._setPublicPermission(upload.file_token, shareLinkEntity);
        if (permission.ok) {
            return { ok: true, raw: { upload: upload.raw, permission: permission.raw }, file_token: upload.file_token, url: upload.url };
        }
        return { 
            ok: true, 
            raw: { upload: upload.raw, permission: permission.raw }, 
            file_token: upload.file_token, 
            url: upload.url, 
            warning: this._permissionWarning(permission) 
        };
    }

    private async _send(targetArgs: string[], text: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, targetArgs, text }, chat_id: undefined };
        const cmd = [
            this.config.lark_cli_path, "im", "+messages-send", "--as", "bot", ...targetArgs, "--msg-type", "text", "--text", text
        ];
        try {
            const proc = await this._runWithRetry(cmd, 60000);
            return this._resultFromProcess(proc);
        } catch (e) {
            return { ok: false, raw: {}, error: String(e) };
        }
    }

    private async _sendReply(messageId: string, text: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, messageId, text }, chat_id: undefined };
        const cmd = [
            this.config.lark_cli_path, "im", "+messages-reply", "--as", "bot", "--message-id", messageId, "--msg-type", "text", "--text", text
        ];
        try {
            const proc = await this._runWithRetry(cmd, 60000);
            return this._resultFromProcess(proc);
        } catch (e) {
            return { ok: false, raw: {}, error: String(e) };
        }
    }

    async addReaction(messageId: string, emojiType: string = WORKING_REACTION_EMOJI_TYPE): Promise<string | null> {
        this.lastReactionError = null;
        if (this.dryRun || !messageId) return null;

        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`;
            const resp = await axios.post(url, { reaction_type: { emoji_type: emojiType } }, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 5000
            });
            if (resp.data.code === 0) {
                return resp.data.data?.reaction_id || null;
            }
            this.lastReactionError = `API returned: ${JSON.stringify(resp.data)}`;
        } catch (e) {
            this.lastReactionError = String(e);
        }
        return null;
    }

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
        if (this.dryRun || !messageId || !reactionId) return;
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
            await axios.delete(url, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 5000
            });
        } catch (e) {}
    }

    private async _setPublicPermission(fileToken: string, shareLinkEntity: string): Promise<SendResult> {
        if (this.dryRun) return { ok: true, raw: { dry_run: true, fileToken, shareLinkEntity } };
        const data = JSON.stringify({
            link_share_entity: shareLinkEntity,
            external_access: false,
            invite_external: false,
            share_entity: "same_tenant",
            security_entity: "anyone_can_view"
        });
        const cmd = [
            this.config.lark_cli_path, "drive", "permission.public", "patch", 
            "--as", "bot", "--token", fileToken, "--type", "file", "--data", data, "--yes"
        ];
        try {
            const proc = await this._runWithRetry(cmd, 60000);
            return this._resultFromProcess(proc);
        } catch (e) {
            return { ok: false, raw: {}, error: String(e) };
        }
    }

    private async _runWithRetry(cmd: string[], timeoutMs: number, cwd?: string): Promise<{stdout: string, stderr: string, code: number}> {
        const attempts = Math.max(1, (this.config.send_retry_count || 1) + 1);
        let lastResult = { stdout: "", stderr: "", code: 1 };
        
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const [executable, ...args] = cmd;
                const { stdout, stderr } = await execFileAsync(executable, args, { timeout: timeoutMs, cwd });
                return { stdout, stderr, code: 0 };
            } catch (e: any) {
                lastResult = { stdout: e.stdout || "", stderr: e.stderr || String(e), code: e.code || 1 };
                if (attempt === attempts - 1) return lastResult;
                await new Promise(r => setTimeout(r, Math.min(Math.pow(2, attempt) * 1000, 5000)));
            }
        }
        return lastResult;
    }

    private _resultFromProcess(proc: {stdout: string, stderr: string, code: number}): SendResult {
        let raw: any = {};
        if (proc.stdout.trim()) raw = this._parseJsonOutput(proc.stdout);
        if (Object.keys(raw).length === 0 && proc.stderr.trim()) raw = this._parseJsonOutput(proc.stderr);
        
        const { chatId, messageId, fileToken, url } = this._extractResultFields(raw);
        if (proc.code !== 0) {
            return { ok: false, raw, chat_id: chatId, message_id: messageId, file_token: fileToken, url, error: proc.stderr.trim() || proc.stdout.trim() };
        }
        return { ok: true, raw, chat_id: chatId, message_id: messageId, file_token: fileToken, url };
    }

    private _parseJsonOutput(stdout: string): any {
        const text = stdout.trim();
        try { return JSON.parse(text); } catch {}
        const start = text.indexOf('{');
        if (start >= 0) {
            try { return JSON.parse(text.slice(start)); } catch {}
        }
        return { stdout };
    }

    private _extractResultFields(raw: any) {
        const scopes: any[] = [];
        if (typeof raw?.data === 'object' && raw.data !== null) scopes.push(raw.data);
        scopes.push(raw);
        return {
            chatId: this._firstValue(scopes, ["chat_id"]),
            messageId: this._firstValue(scopes, ["message_id"]),
            fileToken: this._firstValue(scopes, ["file_token", "token"]),
            url: this._firstValue(scopes, ["url", "file_url", "link"])
        };
    }

    private _firstValue(scopes: any[], keys: string[]): string | undefined {
        for (const scope of scopes) {
            for (const key of keys) {
                if (typeof scope[key] === 'string' && scope[key]) return scope[key];
            }
            for (const nestedKey of ["file", "item", "document"]) {
                const nested = scope[nestedKey];
                if (typeof nested === 'object' && nested !== null) {
                    const nestedValue = this._firstValue([nested], keys);
                    if (nestedValue) return nestedValue;
                }
            }
        }
        return undefined;
    }

    private _auditSend(channel: string, target: string, text: string, result: SendResult) {
        if (!this.auditCallback) return;
        try {
            this.auditCallback("bot_message_sent", {
                channel, target, ok: result.ok, message_id: result.message_id,
                chat_id: result.chat_id, error: result.error, text_preview: text.substring(0, 200)
            });
        } catch {}
    }

    private _permissionWarning(result: SendResult): string {
        const error = result.raw?.error || {};
        const missing = error.missing_scopes || [];
        if (missing.length > 0) return `已上传看板文件，但未能设置共享权限。请在飞书开放平台为应用开通：${missing.join('、')}`;
        return "已上传看板文件，但未能设置共享权限。";
    }

    explainError(result: SendResult): string {
        const error = result.raw?.error || {};
        const missing = error.missing_scopes || [];
        if (missing.length > 0) return `请在飞书开放平台为应用开通以下权限：${missing.join('、')}`;
        if (error.message) return String(error.message);
        if (result.error) {
            const lines = result.error.split('\n');
            return lines[lines.length - 1];
        }
        return "未知错误";
    }

    parseEvent(payload: any): SourceMessage | null {
        const parser = new FeishuEventParser(this.config.bot_open_id || "");
        return parser.parse(payload);
    }

    async listGroups(): Promise<any[]> {
        if (this.dryRun) return [];
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/chats?page_size=100`;
            const resp = await axios.get(url, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            return resp.data?.data?.items || [];
        } catch (e) {
            return [];
        }
    }

    async listGroupMembers(chatId: string): Promise<any[]> {
        if (this.dryRun || !chatId) return [];
        try {
            const token = await this._getTenantAccessToken();
            const url = `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members?page_size=100`;
            const resp = await axios.get(url, {
                headers: { "Authorization": `Bearer ${token}` }
            });
            return resp.data?.data?.items || [];
        } catch (e) {
            return [];
        }
    }
}
