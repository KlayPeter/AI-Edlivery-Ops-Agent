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
        console.error('Failed to load data', e);
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
    <Layout style={{ minHeight: 'calc(100vh - 64px)', background: '#fff' }}>
      <Sider width={300} theme="light" style={{ borderRight: '1px solid #f0f0f0', overflow: 'auto', height: 'calc(100vh - 64px)' }}>
        <div style={{ padding: '16px' }}>
          <Title level={4}>Dashboards</Title>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedDashboard]}
          onClick={(e) => setSelectedDashboard(e.key)}
          items={dashboards.map(d => ({ key: d, label: d }))}
        />
        {dashboards.length === 0 && <Empty description="No Dashboards Found" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Sider>
      
      <Content style={{ padding: '24px', overflow: 'auto', height: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 2, marginBottom: '24px' }}>
          <Title level={3}>Dashboard View</Title>
          {selectedDashboard ? (
            <div style={{ border: '1px solid #d9d9d9', borderRadius: '8px', height: '600px', overflow: 'hidden' }}>
              <iframe
                src={api.getDashboardUrl(selectedDashboard)}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Dashboard"
              />
            </div>
          ) : (
            <Alert message="Select a dashboard from the left sidebar to view." type="info" showIcon />
          )}
        </div>
        
        <div style={{ flex: 1 }}>
          <Title level={3}>Recent Audit Logs</Title>
          <List
            bordered
            dataSource={logs}
            size="small"
            style={{ maxHeight: '300px', overflow: 'auto' }}
            renderItem={item => (
              <List.Item>
                <Tag color="blue">{item.action || 'Log'}</Tag>
                <Text type="secondary" style={{ marginRight: 8 }}>
                  {item.timestamp || new Date().toISOString()}
                </Text>
                <Text>{JSON.stringify(item.details || item)}</Text>
              </List.Item>
            )}
          />
        </div>
      </Content>
    </Layout>
  );
};

export default DashboardPage;
