import { useEffect, useState } from 'react';
import { Layout, Menu, Typography, Spin, Alert, Empty, Drawer } from 'antd';
import { api } from '../api';

const { Sider, Content } = Layout;
const { Title } = Typography;

const DashboardPage = () => {
  const [dashboards, setDashboards] = useState([]);
  const [selectedDashboard, setSelectedDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [drawerVisible, setDrawerVisible] = useState(false);

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
    <Layout style={{ flex: 1, height: '100%', background: '#fff', position: 'relative' }}>
      <Drawer
        title="历史看板"
        placement="left"
        closable={true}
        onClose={() => setDrawerVisible(false)}
        open={drawerVisible}
        getContainer={false}
        style={{ position: 'absolute' }}
        width={280}
        styles={{ body: { padding: 0 } }}
      >
        <Menu
          mode="inline"
          selectedKeys={[selectedDashboard]}
          onClick={(e) => {
            setSelectedDashboard(e.key);
            setDrawerVisible(false);
          }}
          items={dashboards.map(d => ({ key: d, label: d }))}
          style={{ borderRight: 0 }}
        />
        {dashboards.length === 0 && <Empty description="暂无看板数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />}
      </Drawer>
      
      <Content style={{ padding: '24px', overflow: 'auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {error ? (
            <Alert message="看板加载失败" description={error} type="error" showIcon />
          ) : selectedDashboard ? (
            <div style={{ flex: 1, border: '1px solid #d9d9d9', borderRadius: '8px', overflow: 'hidden', minHeight: '400px', position: 'relative', background: '#101418' }}>
              <iframe
                src={api.getDashboardUrl(selectedDashboard)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="Dashboard"
              />
            </div>
          ) : (
            <Alert message="请在左侧边栏选择要查看的看板" type="info" showIcon />
          )}
        </div>
      </Content>
      
      <div 
        style={{ 
          position: 'absolute', 
          top: '24px', 
          left: '-1px', 
          zIndex: 1, 
          background: '#fff', 
          border: '1px solid #d9d9d9', 
          borderLeft: 'none',
          padding: '8px 12px', 
          borderRadius: '0 8px 8px 0', 
          cursor: 'pointer',
          boxShadow: '2px 0 8px rgba(0,0,0,0.05)'
        }}
        onClick={() => setDrawerVisible(true)}
      >
        <span style={{ fontSize: '18px', lineHeight: 1 }}>☰</span>
      </div>
    </Layout>
  );
};

export default DashboardPage;
