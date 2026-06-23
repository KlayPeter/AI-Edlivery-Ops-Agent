import { useEffect, useState } from 'react';
import { Typography, Tag, Alert, Table } from 'antd';
import { api } from '../api';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const LogsPage = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });

  const fetchLogs = async (page, pageSize) => {
    setLoading(true);
    try {
      const response = await api.fetchLogs(page, pageSize);
      setLogs(response.logs || []);
      setPagination({
        current: response.page || page,
        pageSize: response.pageSize || pageSize,
        total: response.total || 0,
      });
      setError('');
    } catch (e) {
      setError(e.message || '加载日志失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(pagination.current, pagination.pageSize);
  }, []);

  const columns = [
    {
      title: '操作时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 200,
      render: (text) => dayjs(text).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '事件类型',
      key: 'event_type',
      width: 200,
      render: (_, record) => (
        <Tag color="blue">{record.action || record.event_type || 'System'}</Tag>
      ),
    },
    {
      title: '摘要信息',
      key: 'summary',
      render: (_, record) => {
        const payload = record.details || record.payload || record;
        let summary = '';
        if (payload.text) summary = payload.text;
        else if (payload.text_preview) summary = payload.text_preview;
        else if (payload.job_name) summary = `任务: ${payload.job_name}`;
        else if (payload.reason) summary = `异常原因: ${payload.reason}`;
        else summary = JSON.stringify(payload);
        
        return <Text ellipsis style={{ width: '100%', maxWidth: '500px', display: 'inline-block' }}>{summary}</Text>;
      },
    },
  ];

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Title level={3} style={{ marginBottom: 24 }}>系统审计日志 (Audit Logs)</Title>
      {error && <Alert message="日志加载失败" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}
      <div style={{ flex: 1, overflow: 'auto', background: '#fff', borderRadius: '8px' }}>
        <Table
          columns={columns}
          dataSource={logs}
          rowKey={(record, index) => `${record.timestamp}-${index}`}
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            onChange: (page, pageSize) => fetchLogs(page, pageSize),
          }}
          expandable={{
            expandedRowRender: (record) => (
              <pre style={{ margin: 0, padding: '16px', background: '#f5f5f5', borderRadius: '4px', fontSize: '13px', overflowX: 'auto' }}>
                {JSON.stringify(record.details || record.payload || record, null, 2)}
              </pre>
            ),
          }}
        />
      </div>
    </div>
  );
};

export default LogsPage;
