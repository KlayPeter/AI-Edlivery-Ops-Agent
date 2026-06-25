import React from 'react';
import { Layout, Menu } from 'antd';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { DashboardOutlined, UnorderedListOutlined, CheckSquareOutlined, CodeOutlined, DatabaseOutlined, SettingOutlined } from '@ant-design/icons';

const { Header, Content } = Layout;

export const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '进度看板',
    },
    {
      key: '/logs',
      icon: <UnorderedListOutlined />,
      label: '系统日志',
    },
    {
      key: '/standups',
      icon: <CheckSquareOutlined />,
      label: '站会统计',
    },
    {
      key: '/debug',
      icon: <CodeOutlined />,
      label: '流程调试',
    },
    {
      key: '/contexts',
      icon: <DatabaseOutlined />,
      label: '上下文记忆',
    },
    {
      key: '/config',
      icon: <SettingOutlined />,
      label: '系统配置',
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', background: '#001529', padding: '0 24px' }}>
        <div style={{ color: '#fff', fontSize: '20px', fontWeight: 'bold', marginRight: '48px' }}>
          AI Delivery Ops 中台
        </div>
        <Menu 
          theme="dark" 
          mode="horizontal" 
          selectedKeys={[location.pathname]} 
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0, fontSize: '16px' }} 
        />
      </Header>
      <Content style={{ background: '#f5f5f5', padding: '24px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ background: '#fff', flex: 1, borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </div>
      </Content>
    </Layout>
  );
};
