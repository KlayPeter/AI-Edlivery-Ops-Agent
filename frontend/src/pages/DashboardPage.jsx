import React, { useEffect, useState } from 'react';
import { Layout, Menu, Typography, List, Tag, Spin, Alert, Empty } from 'antd';
import { api } from '../api';

const { Sider, Content } = Layout;
const { Title, Text } = Typography;

const DashboardPage = () => {
  const [dashboards, setDashboards] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selectedDashboard, setSelectedDashboard] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [dashboardsData, logsData] = await Promise.all([
          api.fetchDashboards(),
          api.fetchLogs()
        ]);
        setDashboards(dashboardsData);
        setLogs(logsData);
        if (dashboardsData.length > 0) {
          setSelectedDashboard(dashboardsData[0]);
        }
      } catch (e) {
        console.error('加载数据失败', e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  }

  return (
    <Layout style={{ height: '100%', background: '#fff' }}>
      <Sider width={280} theme="light" style={{ borderRight: '1px solid #f0f0f0', overflow: 'auto', height: '100%' }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <Title level={4} style={{ margin: 0 }}>历史看板</Title>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedDashboard]}
          onClick={(e) => setSelectedDashboard(e.key)}
          items={dashboards.map(d => ({ key: d, label: d }))}
          style={{ borderRight: 0 }}
        />
        {dashboards.length === 0 && <Empty description="暂无看板数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />}
      </Sider>
      
      <Content style={{ padding: '24px', overflow: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Title level={3}>看板视图</Title>
          {selectedDashboard ? (
            <div style={{ flex: 1, border: '1px solid #d9d9d9', borderRadius: '8px', overflow: 'hidden', minHeight: '400px', marginBottom: '24px' }}>
              <iframe
                src={api.getDashboardUrl(selectedDashboard)}
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="Dashboard"
              />
            </div>
          ) : (
            <Alert message="请在左侧边栏选择要查看的看板" type="info" showIcon style={{ marginBottom: 24 }} />
          )}
        </div>
        
        <div style={{ height: '300px', display: 'flex', flexDirection: 'column' }}>
          <Title level={4}>系统审计日志 (Audit Logs)</Title>
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
            {logs.length === 0 && <Text type="secondary">暂无日志记录</Text>}
          </div>
        </div>
      </Content>
    </Layout>
  );
};

export default DashboardPage;
