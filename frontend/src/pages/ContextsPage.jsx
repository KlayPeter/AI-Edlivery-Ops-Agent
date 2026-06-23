import { useEffect, useState } from 'react';
import { Table, Tag, Typography, message, Tooltip, Space, Tabs, Alert } from 'antd';
import { api } from '../api';

const { Title, Text } = Typography;

const getTypeColor = (type) => {
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

const getTypeName = (type) => {
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

const shortId = (value) => {
  if (!value) return '-';
  return value.split('_')[1]?.substring(0, 8) || value.substring(0, 8);
};

const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const ContextsPage = () => {
  const [contexts, setContexts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.fetchContexts().then(data => {
      if (cancelled) return;
      setContexts(data);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setError(err.message || '加载上下文失败');
      message.error('加载上下文失败：' + (err.message || '请求失败'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (text) => <Text type="secondary">{formatDate(text)}</Text>
    },
    {
      title: '上下文类型',
      dataIndex: 'context_type',
      key: 'context_type',
      width: 150,
      filters: [
        { text: '待确认任务', value: 'task_confirmation' },
        { text: '站会提醒', value: 'standup_prompt' },
        { text: '待补充计划', value: 'task_plan_request' },
        { text: '群聊通知', value: 'task_group_notice' },
        { text: '待验收任务', value: 'task_acceptance_prompt' },
        { text: '补充任务字段', value: 'missing_task_field' },
        { text: '状态变更通知', value: 'task_status_notice' },
      ],
      onFilter: (value, record) => record.context_type === value,
      render: (type) => (
        <Tag color={getTypeColor(type)} style={{ fontWeight: 500 }}>
          {getTypeName(type)}
        </Tag>
      )
    },
    {
      title: '关联任务',
      dataIndex: 'task_title',
      key: 'task_title',
      render: (text, record) => {
        if (!text && !record.task_id) {
          return <Text type="secondary" italic>无特定任务 (如: 每日站会提醒)</Text>;
        }
        return (
          <Space direction="vertical" size={0}>
            <Text strong>{text || '-'}</Text>
            {record.task_id && <Text type="secondary" style={{ fontSize: '12px' }}>ID: {record.task_id}</Text>}
          </Space>
        );
      }
    },
    {
      title: '目标接收人 / 群',
      key: 'target',
      width: 200,
      render: (_, record) => {
        if (record.target_name) {
          return <Tag color="blue">私聊: {record.target_name}</Tag>;
        }
        if (record.target_open_id) {
          return <Tag color="blue">私聊: {shortId(record.target_open_id)}...</Tag>;
        }
        if (record.chat_name) {
          return <Tag color="orange">群聊: {record.chat_name}</Tag>;
        }
        if (record.chat_id) {
          return <Tag color="orange">群聊: {shortId(record.chat_id)}...</Tag>;
        }
        return '-';
      }
    },
    {
      title: '源消息 ID',
      dataIndex: 'message_id',
      key: 'message_id',
      width: 180,
      render: (text) => (
        <Tooltip title={text}>
          <Text code>{shortId(text)}...</Text>
        </Tooltip>
      )
    }
  ];

  const privateContexts = contexts.filter(c => !!c.target_open_id);
  const groupContexts = contexts.filter(c => !!c.chat_id);
  
  const getDataSource = () => {
    if (activeTab === 'private') return privateContexts;
    if (activeTab === 'group') return groupContexts;
    return contexts;
  };

  const items = [
    { key: 'all', label: `全部 (${contexts.length})` },
    { key: 'private', label: `私聊上下文 (${privateContexts.length})` },
    { key: 'group', label: `群聊上下文 (${groupContexts.length})` }
  ];

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>上下文记忆 (Contexts)</Title>
        <Text type="secondary">这里展示了系统向用户发送的具有强交互属性的消息，当用户对这些消息“引用回复”时，中台能精确识别上下文语境。</Text>
      </div>
      
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={items} />

      {error && <Alert message="上下文加载失败" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}

      <Table 
        columns={columns} 
        dataSource={getDataSource()} 
        rowKey="message_id" 
        loading={loading}
        pagination={{ pageSize: 15 }}
        style={{ flex: 1, overflow: 'auto' }}
      />
    </div>
  );
};

export default ContextsPage;
