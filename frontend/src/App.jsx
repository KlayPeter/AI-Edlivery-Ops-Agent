import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Layout, Menu, ConfigProvider, theme } from 'antd';
import { SettingOutlined, DashboardOutlined } from '@ant-design/icons';
import ConfigPage from './pages/ConfigPage';
import DashboardPage from './pages/DashboardPage';

const { Header, Content, Footer } = Layout;

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <BrowserRouter>
        <Layout style={{ minHeight: '100vh' }}>
          <Header style={{ display: 'flex', alignItems: 'center', background: '#001529' }}>
            <div style={{ color: '#fff', fontSize: '18px', fontWeight: 'bold', marginRight: '40px' }}>
              AI Delivery Ops
            </div>
            <Menu theme="dark" mode="horizontal" defaultSelectedKeys={['dashboard']} style={{ flex: 1, minWidth: 0 }}>
              <Menu.Item key="dashboard" icon={<DashboardOutlined />}>
                <Link to="/">Dashboard & Logs</Link>
              </Menu.Item>
              <Menu.Item key="config" icon={<SettingOutlined />}>
                <Link to="/config">Settings</Link>
              </Menu.Item>
            </Menu>
          </Header>
          <Content style={{ padding: '0 50px', marginTop: '24px' }}>
            <div style={{ background: '#fff', padding: 24, minHeight: 380, borderRadius: '8px' }}>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/config" element={<ConfigPage />} />
              </Routes>
            </div>
          </Content>
          <Footer style={{ textAlign: 'center' }}>
            AI Delivery Ops Agent ©{new Date().getFullYear()}
          </Footer>
        </Layout>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
