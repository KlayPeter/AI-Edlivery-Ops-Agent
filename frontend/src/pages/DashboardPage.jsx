import { useEffect, useState } from 'react';
import { Layout, Menu, Typography, Spin, Alert, Empty } from 'antd';
import { api } from '../api';

const { Sider, Content } = Layout;
const { Title } = Typography;

const DashboardPage = () => {
  const [dashboards, setDashboards] = useState([]);
  const [selectedDashboard, setSelectedDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const dashboardsData = await api.fetchDashboards();
        if (cancelled) return;
        setDashboards(dashboardsData);
        if (dashboardsData.length > 0) {
          setSelectedDashboard(dashboardsData[0]);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || '加载看板失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
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
          {error ? (
            <Alert message="看板加载失败" description={error} type="error" showIcon />
          ) : selectedDashboard ? (
            <div style={{ flex: 1, border: '1px solid #d9d9d9', borderRadius: '8px', overflow: 'hidden', minHeight: '400px' }}>
              <iframe
                src={api.getDashboardUrl(selectedDashboard)}
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="Dashboard"
              />
            </div>
          ) : (
            <Alert message="请在左侧边栏选择要查看的看板" type="info" showIcon />
          )}
        </div>
      </Content>
    </Layout>
  );
};

export default DashboardPage;
