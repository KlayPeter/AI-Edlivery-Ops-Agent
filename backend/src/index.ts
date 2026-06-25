import { Elysia, t } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { cors } from '@elysiajs/cors';
import { loadConfig } from './core/config';
import { JsonStore } from './core/storage';
import { FeishuAdapter } from './adapters/feishu';
import { TapdAdapter } from './adapters/tapd';
import { LLMAdapter } from './adapters/llm';
import { DashboardService } from './services/dashboard';
import { MessageIntentParser } from './services/messageIntent';
import { MessageHandler } from './services/messageHandler';
import { InProcessScheduler } from './core/scheduler';
import { ScheduledJobs } from './services/jobs';
import dayjs from 'dayjs';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

let config = loadConfig();
let store = new JsonStore(config.data_path);
let feishu = new FeishuAdapter(config.feishu);
feishu.setAuditCallback((action, payload) => store.appendAuditLog(action, payload));
let tapd = new TapdAdapter(config.tapd);
let llm = new LLMAdapter(config.ai);
let intentParser = new MessageIntentParser(llm);
let dashboard = new DashboardService(store, config.data_path, config.project.name, config.runtime.public_base_url);
let handler = new MessageHandler({ config, store, feishu, tapd, dashboard, intentParser });

const scheduler = new InProcessScheduler(() => handler, 30);
scheduler.start();

const _processedEvents: Record<string, number> = {};

const app = new Elysia()
    .use(swagger({
        path: '/swagger',
        documentation: {
            info: {
                title: 'AI Delivery Ops Agent API',
                version: '1.0.0'
            }
        }
    }))
    .use(cors())
    .get('/healthz', () => ({ ok: true }))
    .get('/api/config', () => config)
    .post('/api/config', async ({ body }) => {
        // Here we could update config on disk, but for now we just accept it
        return { ok: true, message: "Config update is not fully implemented in TS yet" };
    })
    .get('/api/dashboards', () => {
        const dir = path.join(config.data_path, 'dashboards');
        if (!fs.existsSync(dir)) return { dashboards: [] };
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
        return { dashboards: files.sort().reverse() };
    })
    .get('/api/dashboards/:filename', ({ params: { filename }, set }) => {
        const filepath = path.join(config.data_path, 'dashboards', decodeURIComponent(filename));
        if (fs.existsSync(filepath) && filepath.endsWith('.html')) {
            set.headers['Content-Type'] = 'text/html; charset=utf-8';
            return fs.readFileSync(filepath, 'utf8');
        }
        set.status = 404;
        return { error: 'not_found' };
    })
    .get('/api/logs', ({ query }) => {
        const page = parseInt(query.page as string || '1');
        const pageSize = parseInt(query.pageSize as string || '20');
        const eventType = query.eventType as string || '';
        const startDate = query.startDate as string || '';
        const endDate = query.endDate as string || '';
        const groupId = query.groupId as string || '';
        
        const logsPath = path.join(config.data_path, 'logs', 'audit.jsonl');
        if (!fs.existsSync(logsPath)) return { logs: [], total: 0 };
        
        const logs: any[] = [];
        const lines = fs.readFileSync(logsPath, 'utf8').split('\n');
        
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const item = JSON.parse(line);
                const itemType = item.action || item.event_type;
                if (eventType) {
                    if (eventType === 'ai_*') {
                        if (!String(itemType).startsWith('ai_')) continue;
                    } else if (itemType !== eventType) {
                        continue;
                    }
                }
                const ts = item.timestamp || '';
                if (startDate && ts < startDate) continue;
                if (endDate && ts > endDate + 'T23:59:59Z') continue;
                if (groupId) {
                    const payload = item.payload || {};
                    const itemGroup = payload.group_id || payload.source_group_id || payload.chat_id;
                    if (itemGroup !== groupId) continue;
                }
                logs.push(item);
            } catch (e) {}
        }
        
        logs.reverse();
        const startIdx = (page - 1) * pageSize;
        const endIdx = startIdx + pageSize;
        
        return {
            logs: logs.slice(startIdx, endIdx),
            total: logs.length,
            page,
            pageSize
        };
    })
    .get('/api/contexts', ({ query }) => {
        const page = parseInt(query.page as string || '1');
        const pageSize = parseInt(query.pageSize as string || '15');
        const contextType = query.contextType as string || '';
        const startDate = query.startDate as string || '';
        const endDate = query.endDate as string || '';
        const chatType = query.chatType as string || '';
        const targetOpenId = query.targetOpenId as string || '';
        const groupId = query.groupId as string || '';
        
        const allContexts = store.listBotMessageContexts();
        allContexts.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        
        const filtered = [];
        for (const ctx of allContexts) {
            if (contextType && ctx.context_type !== contextType) continue;
            const ts = ctx.created_at || '';
            if (startDate && ts < startDate) continue;
            if (endDate && ts > endDate + 'T23:59:59Z') continue;
            if (targetOpenId && ctx.target_open_id !== targetOpenId) continue;
            if (groupId) {
                if (ctx.chat_id !== groupId && ctx.metadata?.group_id !== groupId) continue;
            }
            
            const savedChatType = ctx.chat_type || '';
            const isGroup = savedChatType ? savedChatType === 'group' : !!config.groups.find(g => g.chat_id === ctx.chat_id);
            (ctx as any).is_group = isGroup;
            
            if (chatType === 'private' && isGroup) continue;
            if (chatType === 'group' && !isGroup) continue;
            
            const targetId = ctx.target_open_id;
            if (targetId) {
                const member = config.groups.flatMap(g => g.members).find(m => m.open_id === targetId);
                if (member) (ctx as any).target_name = member.name;
            }
            
            const chatGroup = config.groups.find(g => g.chat_id === ctx.chat_id);
            if (chatGroup) {
                (ctx as any).chat_name = chatGroup.name;
            } else if (isGroup) {
                (ctx as any).chat_name = "其他群聊";
            }
            filtered.push(ctx);
        }
        
        const startIdx = (page - 1) * pageSize;
        const endIdx = startIdx + pageSize;
        return {
            contexts: filtered.slice(startIdx, endIdx),
            total: filtered.length,
            page,
            pageSize
        };
    })
    .get('/api/standups', ({ query }) => {
        const targetDate = query.date as string || dayjs().format('YYYY-MM-DD');
        const groupId = query.groupId as string || '';
        
        const allMembersDict: Record<string, any> = {};
        for (const g of config.groups) {
            if (groupId && g.chat_id !== groupId) continue;
            for (const m of g.members) {
                allMembersDict[m.open_id] = m;
            }
        }
        
        const submittedStandups = store.listStandups(targetDate);
        const submittedMap: Record<string, any> = {};
        for (const s of submittedStandups) {
            // Need to match group open ids
            if (allMembersDict[s.open_id]) {
                submittedMap[s.open_id] = s;
            }
        }
        
        const membersData = [];
        let activeMembersCount = 0;
        
        for (const m of Object.values(allMembersDict)) {
            if (m.is_active === false) continue;
            activeMembersCount++;
            membersData.push({
                open_id: m.open_id,
                name: m.name,
                submitted: !!submittedMap[m.open_id],
                standup_content: submittedMap[m.open_id] || null
            });
        }
        
        return {
            date: targetDate,
            stats: {
                total: activeMembersCount,
                submitted: Object.keys(submittedMap).length,
                missing: activeMembersCount - Object.keys(submittedMap).length
            },
            members: membersData
        };
    })
    .get('/api/feishu/groups', async ({ set }) => {
        try {
            const groups = await feishu.listGroups();
            return { groups };
        } catch (e: any) {
            set.status = 500;
            return { error: e.message || String(e) };
        }
    })
    .get('/api/feishu/groups/:chatId/members', async ({ params: { chatId }, set }) => {
        try {
            const members = await feishu.listGroupMembers(chatId);
            return { members };
        } catch (e: any) {
            set.status = 500;
            return { error: e.message || String(e) };
        }
    })
    .post('/api/jobs/:jobName', async ({ params: { jobName }, body, set }) => {
        const validJobs = new Set([
            "standup-push", "standup-remind", "standup-second-remind", 
            "standup-mark-missing", "standup-summary", "overdue-scan", 
            "daily-summary", "dashboard"
        ]);
        
        if (!validJobs.has(jobName)) {
            set.status = 400;
            return { error: '无效的任务名称' };
        }
        
        const payload: any = body || {};
        const groupId = payload.groupId || '';
        const day = new Date();
        
        const jobs = new ScheduledJobs(config, store, feishu, dashboard, llm);
        try {
            switch (jobName) {
                case "standup-push": await jobs.standupPush(groupId, day); break;
                case "standup-second-remind": await jobs.standupSecondRemind(groupId, day); break;
                case "standup-mark-missing": await jobs.standupMarkMissing(groupId, day); break;
                case "standup-summary": await jobs.standupSummary(groupId, day); break;
                case "overdue-scan": await jobs.overdueScan(groupId, day); break;
                case "daily-summary": await jobs.dailySummary(groupId, day); break;
                case "dashboard": await jobs.dashboardGenerate(groupId, day); break;
            }
            store.appendAuditLog("job_completed", { job_name: jobName, trigger: "manual" });
            return { ok: true, message: `任务 ${jobName} 运行完成` };
        } catch (e: any) {
            set.status = 500;
            return { error: `任务 ${jobName} 执行失败`, stderr: e.message || String(e) };
        }
    })
    .post('/', async ({ body, headers, set }) => {
        const payload: any = body;
        if (!payload) {
            set.status = 400;
            return { error: 'invalid_json' };
        }
        
        if (payload.type === 'url_verification') {
            return { challenge: payload.challenge || '' };
        }
        
        const verifyToken = config.feishu?.verify_token;
        if (verifyToken && payload.token !== verifyToken) {
            set.status = 403;
            return { error: 'invalid_verify_token' };
        }
        
        const eventId = payload.header?.event_id || payload.uuid;
        if (eventId) {
            const now = Date.now();
            if (_processedEvents[eventId] && now - _processedEvents[eventId] < 3600000) {
                return { ok: true, message: 'duplicate event' };
            }
            _processedEvents[eventId] = now;
            
            if (Object.keys(_processedEvents).length > 1000) {
                for (const k of Object.keys(_processedEvents)) {
                    if (now - _processedEvents[k] > 3600000) delete _processedEvents[k];
                }
            }
        }
        
        // Handle asynchronously
        Promise.resolve().then(() => {
            try {
                handler.handleEvent(payload);
            } catch (err: any) {
                store.appendAuditLog("handler_error", { error: String(err) });
            }
        });
        
        return { ok: true, message: 'processing in background' };
    })
    .listen(process.env.PORT ? parseInt(process.env.PORT) : 8090);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
console.log(`Loaded config for project: ${config.project.name}`);
console.log(`Data path: ${config.data_path}`);
