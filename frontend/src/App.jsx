import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, ConfigProvider, theme } from 'antd';
import { SettingOutlined, DashboardOutlined } from '@ant-design/icons';
import ConfigPage from './pages/ConfigPage';
import DashboardPage from './pages/DashboardPage';

const { Header, Content } = Layout;

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '看板与日志',
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
      <Content style={{ background: '#f5f5f5', padding: '24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ background: '#fff', flex: 1, borderRadius: '8px', overflow: 'hidden' }}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/config" element={<ConfigPage />} />
          </Routes>
        </div>
      </Content>
    </Layout>
  );
}

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
