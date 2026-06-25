import { useEffect, useState } from 'react';
import { Typography, Tag, Alert, Table, DatePicker, Select, Space, Button } from 'antd';
import { api } from '@/api';
import dayjs from 'dayjs';
import { getEventMapping, EVENT_TYPE_MAP } from '@/constants';

import { LogsFilter } from '@/components/logs/LogsFilter';
import { LogsTable } from '@/components/logs/LogsTable';

const { Title } = Typography;

const LogsPage = () => {
  const [logs, setLogs] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [filters, setFilters] = useState<any>({ startDate: null, endDate: null, eventType: 'all', groupId: 'all' });
  const [appliedFilters, setAppliedFilters] = useState<any>({ startDate: null, endDate: null, eventType: 'all', groupId: 'all' });

  
  useEffect(() => {
    api.fetchConfig().then(cfg => {
      if (cfg.groups) {
        setGroups(cfg.groups);
      }
    }).catch(console.error);
  }, []);

  const fetchLogs = async (page: number, pageSize: number, filtersToApply: any = {}) => {
    setLoading(true);
    try {
      const response = await api.fetchLogs(page, pageSize, filtersToApply);
      setLogs(response.logs || []);
      setPagination({
        current: response.page || page,
        pageSize: response.pageSize || pageSize,
        total: response.total || 0,
      });
      setError('');
    } catch (e: any) {
      setError(e.message || '加载日志失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(pagination.current, pagination.pageSize, appliedFilters);
  }, [appliedFilters]);

  const handleSearch = () => {
    setAppliedFilters(filters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  const handleReset = () => {
    const defaultFilters = { startDate: null, endDate: null, eventType: 'all', groupId: 'all' };
    setFilters(defaultFilters);
    setAppliedFilters(defaultFilters);
    setPagination(prev => ({ ...prev, current: 1 }));
  };

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Title level={3} style={{ marginBottom: 24 }}>系统审计日志 (Audit Logs)</Title>
      
      <LogsFilter
        filters={filters}
        setFilters={setFilters}
        groups={groups}
        handleSearch={handleSearch}
        handleReset={handleReset}
      />

      {error && <Alert message="日志加载失败" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}
      
      <LogsTable
        logs={logs}
        loading={loading}
        groups={groups}
        pagination={pagination}
        fetchLogs={fetchLogs}
        appliedFilters={appliedFilters}
      />
    </div>
  );
};

export default LogsPage;
