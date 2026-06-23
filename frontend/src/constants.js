export const EVENT_TYPE_MAP = {
  task_field_missing: { text: '字段缺失', color: 'volcano' },
  bot_message_sent: { text: '机器人回复', color: 'green' },
  source_message_received: { text: '收到消息', color: 'blue' },
  job_completed: { text: '任务完成', color: 'cyan' },
  standup_saved: { text: '站会保存', color: 'purple' },
  task_created: { text: '创建任务', color: 'magenta' },
  task_updated: { text: '更新任务', color: 'orange' },
  handler_error: { text: '系统异常', color: 'red' },
};

export const getEventMapping = (eventType) => {
  if (!eventType) return { text: 'System', color: 'default' };
  return EVENT_TYPE_MAP[eventType] || { text: eventType, color: 'default' };
};
