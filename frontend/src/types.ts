export interface Group {
  chat_id: string;
  name: string;
  description?: string;
  [key: string]: any;
}

export interface Member {
  open_id: string;
  name: string;
  [key: string]: any;
}

export interface Config {
  groups: Group[];
  members: Member[];
  bot_name?: string;
  [key: string]: any;
}

export interface Log {
  timestamp: string;
  details?: any;
  payload?: any;
  action?: string;
  event_type?: string;
  [key: string]: any;
}

export interface ContextItem {
  message_id: string;
  created_at: string;
  context_type: string;
  task_title?: string;
  task_id?: string;
  is_group?: boolean;
  chat_name?: string;
  chat_id?: string;
  target_open_id?: string;
  target_name?: string;
  [key: string]: any;
}

export interface Standup {
  submitted_at: string;
  user_name: string;
  yesterday_done?: string[];
  today_plan?: string[];
  blockers?: string[];
  risks?: string[];
  decisions_needed?: string[];
  [key: string]: any;
}

export interface StandupMember {
  open_id: string;
  name: string;
  submitted: boolean;
  standup_content?: Standup;
  [key: string]: any;
}

export interface FilterState {
  startDate?: string | null;
  endDate?: string | null;
  eventType?: string;
  contextType?: string;
  chatType?: string;
  targetOpenId?: string;
  groupId?: string;
  [key: string]: any;
}
