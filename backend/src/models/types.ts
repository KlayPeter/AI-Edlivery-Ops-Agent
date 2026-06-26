import { t } from 'elysia';

export const TASK_STATUS_PENDING_PRIMARY_OWNER = "pending_primary_owner";
export const TASK_STATUS_PENDING_CONFIRMATION = "pending_confirmation";
export const TASK_STATUS_CONFIRMED = "confirmed";
export const TASK_STATUS_IN_PROGRESS = "in_progress";
export const TASK_STATUS_BLOCKED = "blocked";
export const TASK_STATUS_OWNER_MARKED_DONE = "owner_marked_done";
export const TASK_STATUS_ACCEPTED = "accepted";
export const TASK_STATUS_CANCELLED = "cancelled";
export const TASK_STATUS_OVERDUE = "overdue";
export const TASK_STATUS_DELETED = "deleted";

export interface Member {
  open_id: string;
  name: string;
  role?: string;
  is_active?: boolean;
}

export interface Mention {
  open_id: string;
  name: string;
  key?: string;
}

export interface SourceMessage {
  id: string;
  chat_id: string;
  chat_type: string;
  sender_open_id: string;
  sender_name: string;
  text: string;
  message_type: string;
  sent_at: string;
  raw_payload: any;
  mentions?: Mention[];
  ai_result?: any;
  confidence?: number | null;
  parent_id?: string | null;
  root_id?: string | null;
}

export interface Task {
  id: string;
  title: string;
  creator_open_id: string;
  creator_name: string;
  primary_owner_open_id: string;
  primary_owner_name: string;
  assignee_open_ids: string[];
  assignee_names: string[];
  status: string;
  priority: string;
  source_message_id: string;
  source_group_id: string;
  created_at: string;
  updated_at: string;
  source_sender_open_id?: string;
  source_sender_name?: string;
  source_sent_at?: string;
  raw_text?: string;
  ai_result?: any;
  confidence?: number | null;
  trace?: any;
  description?: string;
  due_date?: string | null;
  acceptance_criteria?: string[];
  dependencies?: string[];
  related_links?: string[];
  tags?: string[];
  task_plan?: any;
  blocked_at?: string | null;
  blocker_info?: any;
  overdue_reminders?: Record<string, string>;
  tapd_story_id?: string | null;
  tapd_url?: string | null;
  parent_id?: string | null;
  is_draft?: boolean;
}

export interface TaskUpdate {
  id: string;
  task_id: string;
  user_open_id: string;
  user_name: string;
  update_type: string;
  content: string;
  source: string;
  source_message_id: string | null;
  created_at: string;
  source_group_id?: string;
  source_sender_open_id?: string;
  source_sender_name?: string;
  source_sent_at?: string;
  raw_text?: string;
  ai_result?: any;
  confidence?: number | null;
  trace?: any;
  metadata?: any;
}

export interface Standup {
  id: string;
  open_id: string;
  user_name: string;
  date: string;
  yesterday_done: string[];
  today_plan: string[];
  blockers: string[];
  risks: string[];
  decisions_needed: string[];
  submitted_at: string;
  source_message_id?: string | null;
  source_group_id?: string;
  source_sender_open_id?: string;
  source_sender_name?: string;
  source_sent_at?: string;
  raw_text?: string;
  ai_result?: any;
  confidence?: number | null;
  trace?: any;
}

export interface DailySummary {
  id: string;
  group_id: string;
  date: string;
  highlights: string[];
  tasks: any[];
  progress_updates: any[];
  blockers: any[];
  decisions: any[];
  risks: any[];
  helps: any[];
  shares: any[];
  meetings: any[];
  created_at: string;
  ai_abstract?: string | null;
}

export interface DashboardArtifact {
  id: string;
  date: string;
  html_path: string;
  stats_path: string;
  created_at: string;
  public_url?: string | null;
}

export interface BotMessageContext {
  message_id: string;
  context_type: string;
  created_at: string;
  chat_id?: string;
  chat_type?: string;
  target_open_id?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  metadata?: any;
}

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}
