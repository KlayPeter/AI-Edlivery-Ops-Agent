export const getTypeColor = (type: string) => {
  switch (type) {
    case 'task_confirmation': return 'volcano';
    case 'standup_prompt': return 'cyan';
    case 'task_plan_request': return 'purple';
    case 'task_group_notice': return 'green';
    case 'task_acceptance_prompt': return 'magenta';
    case 'missing_task_field': return 'orange';
    case 'task_status_notice': return 'blue';
    default: return 'default';
  }
};

export const getTypeName = (type: string) => {
  switch (type) {
    case 'task_confirmation': return '待确认任务';
    case 'standup_prompt': return '站会提醒';
    case 'task_plan_request': return '待补充计划';
    case 'task_group_notice': return '群聊通知';
    case 'task_acceptance_prompt': return '待验收任务';
    case 'missing_task_field': return '补充任务字段';
    case 'task_status_notice': return '状态变更通知';
    default: return type;
  }
};

export const ALL_CONTEXT_TYPES = [
  'task_confirmation', 'standup_prompt', 'task_plan_request', 
  'task_group_notice', 'task_acceptance_prompt', 
  'missing_task_field', 'task_status_notice'
];

export const shortId = (value: string | null | undefined) => {
  if (!value) return '-';
  return value.split('_')[1]?.substring(0, 8) || value.substring(0, 8);
};

export const formatDate = (value: string | number | null | undefined) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};
