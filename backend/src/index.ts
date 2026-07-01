import { Elysia, t } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { cors } from '@elysiajs/cors';
import * as Lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './core/config';
import { PrismaStore } from './core/storage';
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
let store = new PrismaStore(config.data_path);

const knownNames: Record<string, string> = {};
for (const g of config.groups) {
    for (const m of g.members) {
        knownNames[m.open_id] = m.name;
    }
}
let feishu = new FeishuAdapter(config.feishu, false, knownNames);
feishu.setAuditCallback((action, payload) => { store.appendAuditLog(action, payload).catch(console.error); });
let tapd = new TapdAdapter(config.tapd);
let llm = new LLMAdapter(config.ai);
let intentParser = new MessageIntentParser(llm);
let dashboard = new DashboardService(store, config.data_path, config.project.name, config.runtime.public_base_url);
let handler = new MessageHandler({ config, store, feishu, tapd, dashboard, intentParser });

const wsClient = new Lark.WSClient({
    appId: config.feishu.app_id,
    appSecret: config.feishu.app_secret,
});

wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
            console.log("=== WS Event Received ===", JSON.stringify(data).substring(0, 500));
            try {
                handler.handleEvent({ event: data });
            } catch (err: any) {
                store.appendAuditLog("handler_error", { error: String(err) }).catch(console.error);
            }
        }
    })
});

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
    .get('/api/logs', async ({ query }) => {
        const page = parseInt(query.page as string || '1');
        const pageSize = parseInt(query.pageSize as string || '20');
        const eventType = query.eventType as string || '';
        const startDate = query.startDate as string || '';
        const endDate = query.endDate as string || '';
        const groupId = query.groupId as string || '';
        
        let whereClause: any = {};
        
        if (eventType) {
            if (eventType === 'ai_*') {
                whereClause.event_type = { startsWith: 'ai_' };
            } else {
                whereClause.event_type = eventType;
            }
        }
        
        if (startDate || endDate) {
            whereClause.timestamp = {};
            if (startDate) whereClause.timestamp.gte = startDate;
            if (endDate) whereClause.timestamp.lte = endDate + 'T23:59:59Z';
        }
        
        if (groupId) {
            whereClause.payload = { contains: groupId };
        }
        
        const total = await store.prisma.auditLog.count({ where: whereClause });
        const records = await store.prisma.auditLog.findMany({
            where: whereClause,
            orderBy: { id: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize
        });
        
        const logs = records.map(r => {
            let payload = {};
            try { payload = JSON.parse(r.payload); } catch (e) {}
            return {
                timestamp: r.timestamp,
                event_type: r.event_type,
                action: r.event_type,
                payload
            };
        });
        
        return {
            logs,
            total,
            page,
            pageSize
        };
    })
    .get('/api/contexts', async ({ query }) => {
        const page = parseInt(query.page as string || '1');
        const pageSize = parseInt(query.pageSize as string || '15');
        const contextType = query.contextType as string || '';
        const startDate = query.startDate as string || '';
        const endDate = query.endDate as string || '';
        const chatType = query.chatType as string || '';
        const targetOpenId = query.targetOpenId as string || '';
        const groupId = query.groupId as string || '';
        
        const allContexts = await store.listBotMessageContexts();
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
    .get('/api/standups', async ({ query }) => {
        const targetDate = query.date as string || dayjs().format('YYYY-MM-DD');
        const groupId = query.groupId as string || '';
        
        const allMembersDict: Record<string, any> = {};
        for (const g of config.groups) {
            if (groupId && g.chat_id !== groupId) continue;
            for (const m of g.members) {
                allMembersDict[m.open_id] = m;
            }
        }
        
        const submittedStandups = await store.listStandups(targetDate);
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
        
        const jobs = new ScheduledJobs(config, store, feishu, dashboard, tapd, llm);
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
            store.appendAuditLog("job_completed", { job_name: jobName, trigger: "manual" }).catch(console.error);
            return { ok: true, message: `任务 ${jobName} 运行完成` };
        } catch (e: any) {
            set.status = 500;
            return { error: `任务 ${jobName} 执行失败`, stderr: e.message || String(e) };
        }
    })
    .listen(process.env.PORT ? parseInt(process.env.PORT) : 8090);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
console.log(`Loaded config for project: ${config.project.name}`);
console.log(`Data path: ${config.data_path}`);
