import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Alert, Empty, Drawer, Select, Space, DatePicker } from 'antd';
import dayjs from 'dayjs';
import { api } from '@/api';

const { Content } = Layout;

const DashboardPage = () => {
  const [dashboards, setDashboards] = useState<string[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [selectedMonth, setSelectedMonth] = useState(dayjs().format('YYYY-MM'));
  const [selectedDashboard, setSelectedDashboard] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [drawerVisible, setDrawerVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const [dashboardsData, configData] = await Promise.all([
          api.fetchDashboards(),
          api.fetchConfig().catch(() => ({ groups: [] }))
        ]);
        if (cancelled) return;
        setDashboards(dashboardsData);
        setGroups(configData.groups || []);
        
        // Auto-select first dashboard available
        if (dashboardsData.length > 0) {
          setSelectedDashboard(dashboardsData[0]);
        }

      } catch (e: any) {
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
        <div style={{ padding: '16px', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, color: '#888', fontSize: 12 }}>所属群组</div>
            <Select 
              value={selectedGroup} 
              onChange={setSelectedGroup} 
              style={{ width: '100%' }}
              placeholder="请选择群聊"
              options={[
                { label: '全部', value: 'all' },
                ...groups.map((g: any) => ({ label: g.name || g.chat_id, value: g.chat_id }))
              ]}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, color: '#888', fontSize: 12 }}>所属月份</div>
            <DatePicker 
              picker="month" 
              value={selectedMonth ? dayjs(selectedMonth, 'YYYY-MM') : null}
              onChange={(d) => setSelectedMonth(d ? d.format('YYYY-MM') : '')}
              style={{ width: '100%' }}
              placeholder="选择月份"
              allowClear={true}
            />
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedDashboard ? [selectedDashboard] : []}
          onClick={(e) => {
            setSelectedDashboard(e.key);
            setDrawerVisible(false);
          }}
          items={dashboards
            .filter((d: string) => {
              const groupMatch = selectedGroup === 'all' || d.includes(selectedGroup);
              const dateMatch = d.match(/(\d{4}-\d{2}-\d{2})\.html$/);
              const monthMatch = selectedMonth ? (dateMatch && dateMatch[1].startsWith(selectedMonth)) : true;
              return groupMatch && monthMatch;
            })
            .map((d: string) => {
              const match = d.match(/(\d{4}-\d{2}-\d{2})\.html$/);
              let label = match ? match[1] : d;
              const group = groups.find((g: any) => d.includes(g.chat_id));
              if (group) {
                label = `${group.name || group.chat_id} ${label}`;
              }
              return { key: d, label: label };
            })}
          style={{ borderRight: 0 }}
        />
        {dashboards.filter((d: string) => {
              const groupMatch = selectedGroup === 'all' || d.includes(selectedGroup);
              const dateMatch = d.match(/(\d{4}-\d{2}-\d{2})\.html$/);
              const monthMatch = selectedMonth ? (dateMatch && dateMatch[1].startsWith(selectedMonth)) : true;
              return groupMatch && monthMatch;
            }).length === 0 && <Empty description="暂无看板数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />}
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
