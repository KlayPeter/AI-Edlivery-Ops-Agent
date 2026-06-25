import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import { MainLayout } from '@/layouts/MainLayout';

// 页面组件
import ConfigPage from '@/pages/ConfigPage';
import DashboardPage from '@/pages/DashboardPage';
import LogsPage from '@/pages/LogsPage';
import DebugPage from '@/pages/DebugPage';
import ContextsPage from '@/pages/ContextsPage';
import StandupsPage from '@/pages/StandupsPage';

function App() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <BrowserRouter>
        <Routes>
          {/* 使用 MainLayout 包裹所有需要通用导航的页面 */}
          <Route path="/" element={<MainLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="standups" element={<StandupsPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="debug" element={<DebugPage />} />
            <Route path="contexts" element={<ContextsPage />} />
            <Route path="config" element={<ConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
