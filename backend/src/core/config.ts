import * as fs from 'fs';
import * as path from 'path';
import { Member } from '@/models/types';

export const DEFAULT_SCHEDULE: Record<string, any> = {
    standup_push: "10:00",
    standup_push_enabled: true,
    standup_second_remind: "10:30",
    standup_second_remind_enabled: true,
    standup_mark_missing: "11:00",
    standup_mark_missing_enabled: true,
    standup_summary: "11:10",
    standup_summary_enabled: true,
    overdue_scan: "10:00",
    overdue_scan_enabled: true,
    daily_summary: "18:30",
    daily_summary_enabled: true,
    dashboard: "18:40",
    dashboard_enabled: true,
    task_reminder_frequency_hours: 24,
};

export interface ProjectConfig {
    name: string;
    root: string;
}

export interface FeishuConfig {
    app_id: string;
    app_secret: string;
    bot_open_id: string;
    bot_name: string;
    lark_cli_path: string;
    verify_token: string;
    send_retry_count: number;
}

export interface GroupConfig {
    chat_id: string;
    name: string;
    members: Member[];
    schedule: Record<string, any>;
    daily_summary_period: string;
}

export interface TapdConfig {
    workspace_id: number;
    api_token: string;
    api_base: string;
    workitem_type_id: string;
}

export interface AIConfig {
    provider: string;
    api_base: string;
    api_key: string;
    model: string;
    max_tokens: number;
    temperature: number;
    retry_count: number;
}

export interface RuntimeConfig {
    data_dir: string;
    public_base_url: string;
    public_missing_standups: boolean;
    public_overdue_owners: boolean;
    daily_summary_period: string;
    daily_summary_fetch_history: boolean;
    daily_summary_fetch_page_size: number;
}

export interface AppConfig {
    project: ProjectConfig;
    feishu: FeishuConfig;
    tapd: TapdConfig;
    ai: AIConfig;
    runtime: RuntimeConfig;
    groups: GroupConfig[];
    schedule: Record<string, any>;
    root_path: string;
    data_path: string;
}

function envOverride(value: string | undefined, envName: string, defaultValue: string = ""): string {
    return process.env[envName] || value || defaultValue;
}

export function resolveConfigPath(configPath?: string, defaultPath = "config/config.json"): string {
    let p = configPath || process.env.DELIVERY_OPS_CONFIG || defaultPath;
    if (!path.isAbsolute(p)) {
        p = path.join(process.cwd(), "..", p); // default resolves from repo root usually, assume backend is in /backend
    }
    return path.resolve(p);
}

function normalizeSchedule(rawSchedule: Record<string, any> = {}): Record<string, any> {
    const schedule = { ...DEFAULT_SCHEDULE, ...rawSchedule };
    if (!rawSchedule.standup_second_remind && rawSchedule.standup_remind) {
        schedule.standup_second_remind = rawSchedule.standup_remind;
    }
    if (rawSchedule.standup_second_remind_enabled === undefined && rawSchedule.standup_remind_enabled !== undefined) {
        schedule.standup_second_remind_enabled = rawSchedule.standup_remind_enabled;
    }
    return schedule;
}

export function buildConfig(raw: any, rawPath: string | null = null): AppConfig {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error("Config must be a JSON object");
    }

    const projectRoot = raw.project?.root && raw.project.root !== '.' 
        ? raw.project.root 
        : (rawPath ? path.dirname(path.dirname(rawPath)) : process.cwd());

    const project: ProjectConfig = {
        name: raw.project?.name || "ZenithStrat",
        root: projectRoot,
    };

    const feishuRaw = raw.feishu || {};
    const feishu: FeishuConfig = {
        app_id: feishuRaw.app_id || "",
        app_secret: envOverride(feishuRaw.app_secret, "FEISHU_APP_SECRET"),
        bot_open_id: feishuRaw.bot_open_id || "",
        bot_name: feishuRaw.bot_name || "AI交付助理",
        lark_cli_path: feishuRaw.lark_cli_path || "lark-cli",
        verify_token: feishuRaw.verify_token || "",
        send_retry_count: Math.max(0, Number(feishuRaw.send_retry_count || 1)),
    };

    const tapdRaw = raw.tapd || {};
    const tapd: TapdConfig = {
        workspace_id: Number(tapdRaw.workspace_id || 52052188),
        api_token: envOverride(tapdRaw.api_token, "TAPD_API_TOKEN"),
        api_base: tapdRaw.api_base || "https://api.tapd.cn",
        workitem_type_id: tapdRaw.workitem_type_id || "1152052188001000017",
    };

    const aiRaw = raw.ai || {};
    const ai: AIConfig = {
        provider: aiRaw.provider || "openai",
        api_base: envOverride(aiRaw.api_base, "AI_API_BASE", "https://api.openai.com/v1"),
        api_key: envOverride(aiRaw.api_key, "AI_API_KEY"),
        model: envOverride(aiRaw.model, "AI_MODEL", "gpt-4o"),
        max_tokens: Number(process.env.AI_MAX_TOKENS || aiRaw.max_tokens || 4096),
        temperature: Number(process.env.AI_TEMPERATURE || aiRaw.temperature || 0.2),
        retry_count: Math.max(0, Number(process.env.AI_RETRY_COUNT || aiRaw.retry_count || 1)),
    };

    const runtimeRaw = raw.runtime || {};
    const runtime: RuntimeConfig = {
        data_dir: runtimeRaw.data_dir || "data",
        public_base_url: runtimeRaw.public_base_url || "",
        public_missing_standups: !!runtimeRaw.public_missing_standups,
        public_overdue_owners: !!runtimeRaw.public_overdue_owners,
        daily_summary_period: runtimeRaw.daily_summary_period || "00:00-23:59",
        daily_summary_fetch_history: runtimeRaw.daily_summary_fetch_history ?? true,
        daily_summary_fetch_page_size: Number(runtimeRaw.daily_summary_fetch_page_size || 50),
    };

    const schedule = normalizeSchedule(raw.schedule);

    const groupsRaw = raw.groups || [];
    const groups: GroupConfig[] = [];

    if (groupsRaw.length > 0) {
        for (const g of groupsRaw) {
            groups.push({
                chat_id: g.chat_id || "",
                name: g.name || "",
                members: g.members || [],
                schedule: normalizeSchedule(g.schedule || schedule),
                daily_summary_period: g.daily_summary_period || runtime.daily_summary_period
            });
        }
    } else {
        const oldGroupId = feishuRaw.group_chat_id || "";
        const oldGroupName = feishuRaw.group_name || "研发群";
        const oldMembers = raw.members || [];
        if (oldGroupId) {
            groups.push({
                chat_id: oldGroupId,
                name: oldGroupName,
                members: oldMembers,
                schedule: schedule,
                daily_summary_period: runtime.daily_summary_period
            });
        }
    }

    const dataPath = path.isAbsolute(runtime.data_dir) 
        ? runtime.data_dir 
        : path.join(project.root, runtime.data_dir);

    return {
        project,
        feishu,
        tapd,
        ai,
        runtime,
        groups,
        schedule,
        root_path: project.root,
        data_path: dataPath,
    };
}

export function loadConfig(configPath?: string): AppConfig {
    const rawPath = resolveConfigPath(configPath);
    let raw = {};
    if (fs.existsSync(rawPath)) {
        raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    }
    return buildConfig(raw, rawPath);
}

export function writeConfig(configPathStr: string, payload: any): void {
    const configPath = path.resolve(configPathStr);
    buildConfig(payload, configPath); // Validate before saving
    const tmp = `${configPath}.tmp`;
    
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, configPath);
}
