import type { AppConfig } from '@/core/config';
import { JsonStore } from '@/core/storage';
import { FeishuAdapter } from '@/adapters/feishu';
import { TapdAdapter } from '@/adapters/tapd';
import { DashboardService } from '@/services/dashboard';
import { MessageIntentParser } from '@/services/messageIntent';

export interface HandlerContext {
    config: AppConfig;
    store: JsonStore;
    feishu: FeishuAdapter;
    tapd: TapdAdapter;
    dashboard: DashboardService;
    intentParser?: MessageIntentParser;
}

export const TAPD_STATUS_IN_PROGRESS = "status_14";
export const TAPD_STATUS_TESTING = "status_3";
export const TAPD_STATUS_DONE = "status_5";
export const TAPD_STATUS_CANCELLED = "status_20";
export const TAPD_STATUS_BLOCKED = "workflow_suspended";
export const WORKING_REACTION_MIN_SECONDS = 1.2;
export const AI_CONFIDENCE_THRESHOLD = 0.85;
export const PRIORITY_TO_TAPD_LABEL: Record<string, string> = { "P0": "High", "P1": "Middle", "P2": "Low" };
