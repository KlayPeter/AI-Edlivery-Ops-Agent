import { useEffect, useState } from 'react';
import { Table, Tag, Typography, message, Tooltip, Space, Alert, DatePicker, Select, Button, Tabs } from 'antd';
import { api } from '../api';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const getTypeColor = (type: string) => {
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

const getTypeName = (type: string) => {
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

const ALL_CONTEXT_TYPES = [
  'task_confirmation', 'standup_prompt', 'task_plan_request', 
  'task_group_notice', 'task_acceptance_prompt', 
  'missing_task_field', 'task_status_notice'
];

const shortId = (value: string | null | undefined) => {
  if (!value) return '-';
  return value.split('_')[1]?.substring(0, 8) || value.substring(0, 8);
};

const formatDate = (value: string | number | null | undefined) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const ContextsPage = () => {
  const [contexts, setContexts] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 15, total: 0 });
  const [members, setMembers] = useState<any[]>([]);
  const [filters, setFilters] = useState<any>({ startDate: null, endDate: null, contextType: 'all', chatType: 'private', targetOpenId: 'all', groupId: 'all' });
  const [appliedFilters, setAppliedFilters] = useState<any>({ startDate: null, endDate: null, contextType: 'all', chatType: 'private', targetOpenId: 'all', groupId: 'all' });

  
  useEffect(() => {
    api.fetchConfig().then(cfg => {
      if (cfg.groups) {
        setGroups(cfg.groups);
      }
    }).catch(console.error);
  }, []);

  const fetchContexts = async (page: number, pageSize: number, filtersToApply: any = {}) => {
    setLoading(true);
    try {
      const response = await api.fetchContexts(page, pageSize, filtersToApply);
      setContexts(response.contexts || []);
      setPagination({
        current: response.page || page,
        pageSize: response.pageSize || pageSize,
        total: response.total || 0,
      });
      setError('');
    } catch (err: any) {
      setError(err.message || '加载上下文失败');
      message.error('加载上下文失败：' + (err.message || '请求失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContexts(pagination.current, pagination.pageSize, appliedFilters);
  }, [appliedFilters]);

  useEffect(() => {
    api.fetchConfig().then(data => {
      if (data && data.members) setMembers(data.members);
    }).catch(err => console.error('Failed to load members:', err));
  }, []);

  const handleSearch = () => {
    setAppliedFilters(filters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const handleReset = () => {
    const defaultFilters = { startDate: null, endDate: null, contextType: 'all', chatType: filters.chatType, targetOpenId: 'all' };
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const handleTabChange = (key: string) => {
    const newFilters = { ...filters, chatType: key };
    setFilters(newFilters);
    setAppliedFilters(newFilters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (text: string) => <Text type="secondary">{formatDate(text)}</Text>
    },
    {
      title: '上下文类型',
      dataIndex: 'context_type',
      key: 'context_type',
      width: 150,
      render: (type: string) => (
        <Tag color={getTypeColor(type)} style={{ fontWeight: 500 }}>
          {getTypeName(type)}
        </Tag>
      )
    },
    {
      title: '关联任务',
      dataIndex: 'task_title',
      key: 'task_title',
      render: (text: string, record: any) => {
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
      render: (_: any, record: any) => {
        const isGroup = record.is_group;
        
        if (isGroup) {
          const groupTag = <Tag color="orange">群聊: {record.chat_name || shortId(record.chat_id)}</Tag>;
          if (record.target_open_id) {
            return (
              <Space direction="vertical" size={2}>
                {groupTag}
                <Tag color="cyan" style={{ border: 'none', background: 'transparent' }}>@ {record.target_name || shortId(record.target_open_id)}</Tag>
              </Space>
            );
          }
          return groupTag;
        }
        
        if (record.target_open_id) {
          return <Tag color="blue">私聊: {record.target_name || shortId(record.target_open_id)}</Tag>;
        }
        
        return '-';
      }
    },
    {
      title: '源消息 ID',
      dataIndex: 'message_id',
      key: 'message_id',
      width: 180,
      render: (text: string) => (
        <Tooltip title={text}>
          <Text code>{shortId(text)}...</Text>
        </Tooltip>
      )
    }
  ];

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>上下文记忆 (Contexts)</Title>
        <Text type="secondary">这里展示了系统向用户发送的具有强交互属性的消息，当用户对这些消息“引用回复”时，中台能精确识别上下文语境。</Text>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <RangePicker 
          value={filters.startDate ? [dayjs(filters.startDate), dayjs(filters.endDate)] : null}
          onChange={(dates: any) => {
            if (dates) {
              setFilters({...filters, startDate: dates[0].format('YYYY-MM-DD'), endDate: dates[1].format('YYYY-MM-DD')});
            } else {
              setFilters({...filters, startDate: null, endDate: null});
            }
          }}
        />
        <Select
          style={{ width: 150 }}
          value={filters.contextType}
          onChange={(val) => setFilters({...filters, contextType: val})}
        >
          <Select.Option value="all">所有事件类型</Select.Option>
          {ALL_CONTEXT_TYPES.map(type => (
            <Select.Option key={type} value={type}>{getTypeName(type)}</Select.Option>
          ))}
        </Select>
        {filters.chatType === 'private' && (
          <Select
            style={{ width: 120 }}
            value={filters.targetOpenId}
            onChange={(val) => setFilters({...filters, targetOpenId: val})}
          >
            <Select.Option value="all">所有人员</Select.Option>
            {members.map((m: any) => (
              <Select.Option key={m.open_id} value={m.open_id}>{m.name}</Select.Option>
            ))}
          </Select>
        )}
        
        <Select
          style={{ width: 150 }}
          value={filters.groupId}
          onChange={(val) => setFilters({...filters, groupId: val})}
          placeholder="筛选群聊"
        >
          <Select.Option value="all">所有群聊</Select.Option>
          {groups.map((g: any) => <Select.Option key={g.chat_id} value={g.chat_id}>{g.name || g.chat_id}</Select.Option>)}
        </Select>

        <Space>
          <Button type="primary" onClick={handleSearch}>查询</Button>
          <Button onClick={handleReset}>重置</Button>
        </Space>
      </div>
      
      <Tabs 
        activeKey={filters.chatType} 
        onChange={handleTabChange}
        items={[
          { key: 'private', label: '私聊上下文' },
          { key: 'group', label: '群聊上下文' },
        ]}
        style={{ marginBottom: 16 }}
      />

      {error && <Alert message="上下文加载失败" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}

      <Table 
        columns={columns} 
        dataSource={contexts} 
        rowKey="message_id" 
        loading={loading}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          showSizeChanger: true,
          onChange: (page, pageSize) => fetchContexts(page, pageSize, appliedFilters),
        }}
        style={{ flex: 1, overflow: 'auto' }}
      />
    </div>
  );
};

export default ContextsPage;
