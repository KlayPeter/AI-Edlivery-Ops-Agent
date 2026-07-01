import { Table, Tag, Typography, Space, Tooltip } from 'antd';
import { formatDate, getTypeColor, getTypeName, shortId } from './utils';

const { Text } = Typography;

export const ContextsTable = ({ contexts, loading, pagination, fetchContexts, appliedFilters }: any) => {
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
          const privateTag = <Tag color="blue">私聊: {record.target_name || shortId(record.target_open_id)}</Tag>;
          if (record.source_group_name) {
            return (
              <Space direction="vertical" size={2}>
                {privateTag}
                <Text type="secondary" style={{ fontSize: '12px' }}>所属群: {record.source_group_name}</Text>
              </Space>
            );
          }
          return privateTag;
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
      scroll={{ x: 900 }}
      style={{ flex: 1, overflow: 'auto' }}
    />
  );
};
