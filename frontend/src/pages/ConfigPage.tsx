import { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Spin, message, Row, Col, InputNumber, Switch, Alert, Select, Space, TimePicker } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '@/api';
import { FeishuConfig } from '@/components/config/FeishuConfig';
import { TapdConfig } from '@/components/config/TapdConfig';
import { AiModelConfig } from '@/components/config/AiModelConfig';
import { RuntimeConfig } from '@/components/config/RuntimeConfig';
import { GroupConfigList } from '@/components/config/GroupConfigList';
const JOBS = [
  { id: 'standup_push', name: '站会首次提醒' },
  { id: 'standup_second_remind', name: '站会再次提醒' },
  { id: 'standup_mark_missing', name: '记录未交站会' },
  { id: 'standup_summary', name: '生成站会汇总' },
  { id: 'overdue_scan', name: '超期任务扫描' },
  { id: 'daily_summary', name: '群聊日报归纳' },
  { id: 'dashboard', name: '看板生成与上传' },
];

const ConfigPage = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [originalConfig, setOriginalConfig] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    
    // Fetch groups
    setGroupsLoading(true);
    api.fetchGroups().then((data: any) => {
      if (!cancelled) setGroups(data);
    }).catch((err: any) => {
      console.error('Failed to fetch groups:', err);
    }).finally(() => {
      if (!cancelled) setGroupsLoading(false);
    });

    api.fetchConfig().then(data => {
      if (cancelled) return;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('配置格式不正确');
      }
      // Ensure missing enabled flags default to true for UI display
      const config = { ...data, schedule: { ...(data.schedule || {}) }, runtime: { ...(data.runtime || {}) } };
      if (config.runtime.daily_summary_period) {
        const [start, end] = config.runtime.daily_summary_period.split('-');
        config.runtime.daily_summary_period_start = dayjs(start, 'HH:mm');
        config.runtime.daily_summary_period_end = dayjs(end, 'HH:mm');
      } else {
        config.runtime.daily_summary_period_start = dayjs('00:00', 'HH:mm');
        config.runtime.daily_summary_period_end = dayjs('23:59', 'HH:mm');
      }
      if (config.groups && Array.isArray(config.groups)) {
        config.groups = config.groups.map((group: any) => {
          const gSchedule: any = { ...(group.schedule || {}) };
          const fallback = config.schedule || {};
          
          JOBS.forEach(job => {
            if (gSchedule[`${job.id}_enabled`] === undefined) {
              gSchedule[`${job.id}_enabled`] = fallback[`${job.id}_enabled`] !== undefined ? fallback[`${job.id}_enabled`] : true;
            }
            let timeVal = gSchedule[job.id] || fallback[job.id];
            
            // specific defaults
            if (!timeVal) {
              if (job.id === 'standup_second_remind') timeVal = gSchedule.standup_remind || fallback.standup_remind || '09:30';
              if (job.id === 'standup_mark_missing') timeVal = '11:00';
            }
            
            if (timeVal && typeof timeVal === 'string') {
              gSchedule[job.id] = dayjs(timeVal, 'HH:mm');
            } else if (dayjs.isDayjs(timeVal)) {
              gSchedule[job.id] = timeVal;
            } else {
              gSchedule[job.id] = null;
            }
          });
          
          let dsPeriodStart = dayjs('00:00', 'HH:mm');
          let dsPeriodEnd = dayjs('23:59', 'HH:mm');
          if (group.daily_summary_period) {
            const [start, end] = group.daily_summary_period.split('-');
            dsPeriodStart = dayjs(start, 'HH:mm');
            dsPeriodEnd = dayjs(end, 'HH:mm');
          } else if (config.runtime.daily_summary_period) {
            const [start, end] = config.runtime.daily_summary_period.split('-');
            dsPeriodStart = dayjs(start, 'HH:mm');
            dsPeriodEnd = dayjs(end, 'HH:mm');
          }
          
          return { 
            ...group, 
            schedule: gSchedule,
            daily_summary_period_start: dsPeriodStart,
            daily_summary_period_end: dsPeriodEnd
          };
        });
      }

      setOriginalConfig(config);
      form.setFieldsValue(config);
      setLoading(false);
    }).catch((err: any) => {
      if (cancelled) return;
      setLoadError(err.message || '请求失败');
      message.error('加载配置失败：' + (err.message || '请求失败'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [form]);


  const getDefaultGroupData = () => {
    const fallback: any = originalConfig?.schedule || {};
    const s: any = {};
    JOBS.forEach((job: any) => {
      s[`${job.id}_enabled`] = fallback[`${job.id}_enabled`] !== undefined ? fallback[`${job.id}_enabled`] : true;
      let timeVal = fallback[job.id];
      if (!timeVal) {
        if (job.id === 'standup_second_remind') timeVal = fallback.standup_remind || '09:30';
        if (job.id === 'standup_mark_missing') timeVal = '11:00';
      }
      s[job.id] = timeVal ? dayjs(timeVal, 'HH:mm') : null;
    });
    return {
      members: [],
      schedule: s,
      daily_summary_period_start: dayjs('00:00', 'HH:mm'),
      daily_summary_period_end: dayjs('23:59', 'HH:mm')
    };
  };

  const onFinish = async (values: any) => {
    setSaving(true);
    try {
      const mergedConfig = { ...originalConfig, ...values };
      if (mergedConfig.runtime && mergedConfig.runtime.daily_summary_period_start && mergedConfig.runtime.daily_summary_period_end) {
        const start = mergedConfig.runtime.daily_summary_period_start;
        const end = mergedConfig.runtime.daily_summary_period_end;
        mergedConfig.runtime.daily_summary_period = `${start.format('HH:mm')}-${end.format('HH:mm')}`;
        delete mergedConfig.runtime.daily_summary_period_start;
        delete mergedConfig.runtime.daily_summary_period_end;
      }
      if (mergedConfig.groups && Array.isArray(mergedConfig.groups)) {
        mergedConfig.groups = mergedConfig.groups.filter((g: any) => g && g.chat_id).map((group: any) => {
          const gSchedule: any = { ...(group.schedule || {}) };
          JOBS.forEach(job => {
            if (gSchedule[job.id] && dayjs.isDayjs(gSchedule[job.id])) {
              gSchedule[job.id] = gSchedule[job.id].format('HH:mm');
            }
          });
          
          let daily_summary_period = group.daily_summary_period;
          if (group.daily_summary_period_start && group.daily_summary_period_end) {
            daily_summary_period = `${group.daily_summary_period_start.format('HH:mm')}-${group.daily_summary_period_end.format('HH:mm')}`;
          }
          const groupInfo = groups.find((g: any) => g.chat_id === group.chat_id);
          const name = groupInfo ? groupInfo.name : '未知群组';
          const cleanedGroup = { ...group, name, schedule: gSchedule, daily_summary_period };
          delete cleanedGroup.daily_summary_period_start;
          delete cleanedGroup.daily_summary_period_end;
          
          return cleanedGroup;
        });
      }
      await api.saveConfig(mergedConfig);
      message.success('配置保存成功');
      setOriginalConfig(mergedConfig);
    } catch (err: any) {
      message.error('保存配置失败：' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '50px auto' }} />;
  }

  return (
    <div style={{ padding: "24px", height: "100%", overflow: "auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h2 style={{ margin: 0 }}>系统配置</h2>
        <Button
          type="primary"
          onClick={() => form.submit()}
          loading={saving}
          size="large"
          disabled={!originalConfig}
        >
          保存配置
        </Button>
      </div>

      {loadError && (
        <Alert
          message="配置加载失败"
          description={loadError}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Row gutter={24}>
          <Col span={12}>
            <FeishuConfig />
            <GroupConfigList
              form={form}
              groups={groups}
              groupsLoading={groupsLoading}
              originalConfig={originalConfig}
              getDefaultGroupData={getDefaultGroupData}
              refreshGroups={async () => {
                setGroupsLoading(true);
                try {
                  const data = await api.fetchGroups();
                  setGroups(data);
                  message.success("已刷新飞书群聊列表");
                } catch (e: any) {
                  message.error("刷新群聊列表失败: " + e.message);
                } finally {
                  setGroupsLoading(false);
                }
              }}
            />
          </Col>

          <Col span={12}>
            <TapdConfig />
            <RuntimeConfig />
            <AiModelConfig />
          </Col>
        </Row>
      </Form>
    </div>
  );
};

export default ConfigPage;
