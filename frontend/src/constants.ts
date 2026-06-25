export const EVENT_TYPE_MAP: Record<string, { text: string; color: string }> = {
  ai_daily_summary_failed: { text: 'AI日报失败', color: 'red' },
  ai_intent_failed: { text: 'AI意图失败', color: 'red' },
  ai_intent_parsed: { text: 'AI意图解析', color: 'geekblue' },
  ai_standup_summary_failed: { text: 'AI站会失败', color: 'red' },
  dashboard_generated: { text: '看板生成', color: 'cyan' },
  job_failed: { text: '任务失败', color: 'red' },
  task_field_missing: { text: '字段缺失', color: 'volcano' },
  bot_message_sent: { text: '机器人回复', color: 'green' },
  source_message_received: { text: '收到消息', color: 'blue' },
  job_completed: { text: '任务完成', color: 'cyan' },
  overdue_reminder_sent: { text: '超期提醒', color: 'orange' },
  standup_saved: { text: '站会保存', color: 'purple' },
  standup_missing_marked: { text: '站会缺勤记录', color: 'gold' },
  standup_reminder_sent: { text: '站会提醒', color: 'gold' },
  task_created: { text: '创建任务', color: 'magenta' },
  task_created_after_owner_set: { text: '补主责后建任务', color: 'magenta' },
  task_due_date_updated: { text: '截止时间更新', color: 'orange' },
  task_updated: { text: '更新任务', color: 'orange' },
  task_status_updated: { text: '状态变更', color: 'orange' },
  task_ai_updated: { text: 'AI更新任务', color: 'geekblue' },
  task_plan_saved: { text: '任务计划保存', color: 'purple' },
  scheduler_error: { text: '调度异常', color: 'red' },
  handler_error: { text: '系统异常', color: 'red' },
  tapd_create_failed: { text: 'TAPD创建失败', color: 'red' },
  tapd_update_failed: { text: 'TAPD更新失败', color: 'red' },
  any_user: { text: '未知用户', color: 'volcano' },
};

export const getEventMapping = (eventType: string) => {
  if (!eventType) return { text: 'System', color: 'default' };
  return EVENT_TYPE_MAP[eventType] || { text: eventType, color: 'default' };
};
