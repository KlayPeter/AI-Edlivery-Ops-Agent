import React, { useEffect, useState } from 'react';
import { Typography, Tag, Spin, Empty } from 'antd';
import { api } from '../api';

const { Title, Text } = Typography;

const LogsPage = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const logsData = await api.fetchLogs();
        setLogs(logsData);
      } catch (e) {
        console.error('加载日志失败', e);
      } finally {
        setLoading(false);
      }
    };
    fetchLogs();
  }, []);

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  }

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Title level={3} style={{ marginBottom: 24 }}>系统审计日志 (Audit Logs)</Title>
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: '8px', padding: '16px', background: '#fafafa' }}>
        {logs.map((item, index) => (
          <div key={index} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f0f0f0' }}>
            <Tag color="blue">{item.action || item.event_type || 'System'}</Tag>
            <Text type="secondary" style={{ marginRight: 8 }}>
              {item.timestamp || new Date().toISOString()}
            </Text>
            <Text>{JSON.stringify(item.details || item.payload || item)}</Text>
          </div>
        ))}
        {logs.length === 0 && <Empty description="暂无日志记录" />}
      </div>
    </div>
  );
};

export default LogsPage;
