import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, ConfigProvider, theme } from 'antd';
import { SettingOutlined, DashboardOutlined, CodeOutlined, UnorderedListOutlined, DatabaseOutlined } from '@ant-design/icons';
import ConfigPage from './pages/ConfigPage';
import DashboardPage from './pages/DashboardPage';
import LogsPage from './pages/LogsPage';
import DebugPage from './pages/DebugPage';
import ContextsPage from './pages/ContextsPage';

const { Header, Content } = Layout;

function AppContent() {
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
      <Content style={{ background: '#f5f5f5', padding: '24px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ background: '#fff', flex: 1, borderRadius: '8px', overflow: 'hidden' }}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/debug" element={<DebugPage />} />
            <Route path="/contexts" element={<ContextsPage />} />
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
