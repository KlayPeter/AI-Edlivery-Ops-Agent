import { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Spin, message, Row, Col, InputNumber, Switch, Alert, Select, Space, TimePicker } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';

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
  const [originalConfig, setOriginalConfig] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    
    // Fetch groups
    setGroupsLoading(true);
    api.fetchGroups().then(data => {
      if (!cancelled) setGroups(data);
    }).catch(err => {
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
      if (config.schedule.task_reminder_frequency_hours === undefined) {
        config.schedule.task_reminder_frequency_hours = 24;
      }
      if (config.schedule.standup_second_remind === undefined && config.schedule.standup_remind !== undefined) {
        config.schedule.standup_second_remind = config.schedule.standup_remind;
      }
      if (config.schedule.standup_second_remind_enabled === undefined && config.schedule.standup_remind_enabled !== undefined) {
        config.schedule.standup_second_remind_enabled = config.schedule.standup_remind_enabled;
      }
      if (config.schedule.standup_mark_missing === undefined) {
        config.schedule.standup_mark_missing = '11:00';
      }
      JOBS.forEach(job => {
        if (config.schedule[`${job.id}_enabled`] === undefined) {
          config.schedule[`${job.id}_enabled`] = true;
        }
        if (config.schedule[job.id]) {
          config.schedule[job.id] = dayjs(config.schedule[job.id], 'HH:mm');
        }
      });

      setOriginalConfig(config);
      form.setFieldsValue(config);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setLoadError(err.message || '请求失败');
      message.error('加载配置失败：' + (err.message || '请求失败'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [form]);

  const onFinish = async (values) => {
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
      if (mergedConfig.schedule) {
        JOBS.forEach(job => {
          if (mergedConfig.schedule[job.id] && dayjs.isDayjs(mergedConfig.schedule[job.id])) {
            mergedConfig.schedule[job.id] = mergedConfig.schedule[job.id].format('HH:mm');
          }
        });
      }
      await api.saveConfig(mergedConfig);
      message.success('配置保存成功');
      setOriginalConfig(mergedConfig);
    } catch (err) {
      message.error('保存配置失败：' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '50px auto' }} />;
  }

  return (
    <div style={{ padding: '24px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>系统配置</h2>
        <Button type="primary" onClick={() => form.submit()} loading={saving} size="large" disabled={!originalConfig}>
          保存配置
        </Button>
      </div>

      {loadError && <Alert message="配置加载失败" description={loadError} type="error" showIcon style={{ marginBottom: 16 }} />}

      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Row gutter={24}>
          <Col span={12}>
            <Card title="飞书配置" style={{ marginBottom: 20 }}>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['feishu', 'app_id']} label="应用 ID (App ID)">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['feishu', 'app_secret']} label="应用凭证 (App Secret)">
                    <Input.Password />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['feishu', 'bot_open_id']} label="机器人 Open ID">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['feishu', 'group_chat_id']} label="群聊">
                    <Select
                      showSearch
                      allowClear
                      loading={groupsLoading}
                      placeholder="请选择或输入群聊"
                      optionFilterProp="children"
                      filterOption={(input, option) =>
                        (option?.label ?? '').toLowerCase().includes(input.toLowerCase()) ||
                        (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                      }
                      options={(() => {
                        const opts = groups.map(g => ({ label: g.name, value: g.chat_id }));
                        const currentId = originalConfig?.feishu?.group_chat_id;
                        const currentName = originalConfig?.feishu?.group_name;
                        if (currentId && !opts.find(o => o.value === currentId)) {
                          opts.push({ label: currentName || currentId, value: currentId });
                        }
                        return opts;
                      })()}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['feishu', 'send_retry_count']} label="消息发送重试次数">
                    <InputNumber min={0} max={5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card title="TAPD 配置" style={{ marginBottom: 20 }}>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['tapd', 'workspace_id']} label="项目空间 ID (Workspace ID)">
                    <InputNumber style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['tapd', 'api_token']} label="API 凭证 (Token)">
                    <Input.Password />
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card title="AI 模型配置" style={{ marginBottom: 20 }}>
              <Row gutter={24}>
                <Col span={12}>
                    <Form.Item name={['ai', 'api_base']} label="API 地址 (Base URL)" rules={[{ type: 'url', message: '请输入有效 URL' }]}>
                      <Input />
                    </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['ai', 'api_key']} label="API 密钥 (API Key)">
                    <Input.Password />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['ai', 'model']} label="模型名称">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['ai', 'temperature']} label="温度 (Temperature)">
                    <InputNumber step={0.1} min={0} max={2} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['ai', 'retry_count']} label="AI 调用重试次数">
                    <InputNumber min={0} max={5} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </Col>

          <Col span={12}>
            <Card title="运行时配置 (Runtime)" style={{ marginBottom: 20 }}>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['runtime', 'data_dir']} label="数据存储目录">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['runtime', 'public_base_url']} label="公共访问 URL 前缀" rules={[{ type: 'url', warningOnly: true, message: '建议填写完整 URL' }]}>
                    <Input placeholder="例如: https://my-dashboard.com" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={24}>
                <Col span={12}>
                  <Form.Item name={['runtime', 'public_missing_standups']} label="是否公开未交站会名单" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['runtime', 'public_overdue_owners']} label="是否公开超期负责人" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={24}>
                <Col span={24}>
                  <Form.Item label="群聊日报统计周期" required>
                    <Space align="baseline">
                      <Form.Item name={['runtime', 'daily_summary_period_start']} rules={[{ required: true, message: '请选择起始时间' }]} style={{ marginBottom: 0 }}>
                        <TimePicker format="HH:mm" placeholder="起始时间" />
                      </Form.Item>
                      <span style={{ margin: '0 8px' }}>至</span>
                      <Form.Item name={['runtime', 'daily_summary_period_end']} rules={[{ required: true, message: '请选择结束时间' }]} style={{ marginBottom: 0 }}>
                        <TimePicker format="HH:mm" placeholder="结束时间" />
                      </Form.Item>
                    </Space>
                    <div style={{ fontSize: '12px', color: '#888', marginTop: 8 }}>
                      注：若起始时间 ≥ 结束时间，则视为跨天（如 18:00 至 18:00 为昨日18点到今日18点）。
                    </div>
                  </Form.Item>
                </Col>
              </Row>
            </Card>

            <Card title="定时任务设置 (Schedule Configuration)" style={{ marginBottom: 20 }}>
              <div style={{ color: '#888', marginBottom: 16 }}>
                注：后端服务常驻时会按这里的时间自动触发；开关可随时关闭对应任务。
              </div>
              {JOBS.map(job => (
                <Row gutter={24} key={job.id} style={{ alignItems: 'center', marginBottom: 8 }}>
                  <Col span={8}>
                    <strong>{job.name}</strong>
                  </Col>
                  <Col span={10}>
                    <Form.Item
                      name={['schedule', job.id]}
                      style={{ margin: 0 }}
                      rules={[{ required: true, message: '请选择时间' }]}
                    >
                      <TimePicker format="HH:mm" style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item name={['schedule', `${job.id}_enabled`]} valuePropName="checked" style={{ margin: 0 }}>
                      <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
                    </Form.Item>
                  </Col>
                </Row>
              ))}
              <Row gutter={24} style={{ alignItems: 'center', marginTop: 12 }}>
                <Col span={8}>
                  <strong>任务提醒频率</strong>
                </Col>
                <Col span={10}>
                  <Form.Item
                    name={['schedule', 'task_reminder_frequency_hours']}
                    style={{ margin: 0 }}
                    rules={[{ type: 'number', min: 1, message: '至少 1 小时' }]}
                  >
                    <InputNumber min={1} max={168} addonAfter="小时" style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
        
        <Row gutter={24}>
          <Col span={24}>
            <Card title="团队成员列表 (Team Members)" style={{ marginBottom: 20 }}>
              <Form.List name="members">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name, ...restField }) => (
                      <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                        <Form.Item
                          {...restField}
                          name={[name, 'name']}
                          rules={[{ required: true, message: '请输入姓名' }]}
                          style={{ width: 150 }}
                        >
                          <Input placeholder="姓名 (Name)" />
                        </Form.Item>
                        <Form.Item
                          {...restField}
                          name={[name, 'open_id']}
                          rules={[{ required: true, message: '请输入飞书 Open ID' }]}
                          style={{ width: 300 }}
                        >
                          <Input placeholder="飞书 Open ID" />
                        </Form.Item>
                        <Form.Item
                          {...restField}
                          name={[name, 'role']}
                          style={{ width: 150 }}
                        >
                          <Input placeholder="角色 (可选)" />
                        </Form.Item>
                        <Form.Item
                          {...restField}
                          name={[name, 'is_active']}
                          valuePropName="checked"
                        >
                          <Switch checkedChildren="在职" unCheckedChildren="离职" />
                        </Form.Item>
                        <MinusCircleOutlined onClick={() => remove(name)} style={{ color: '#ff4d4f' }} />
                      </Space>
                    ))}
                    <Form.Item>
                      <Button type="dashed" onClick={() => add({ is_active: true })} block icon={<PlusOutlined />}>
                        添加团队成员
                      </Button>
                    </Form.Item>
                  </>
                )}
              </Form.List>
            </Card>
          </Col>
        </Row>
      </Form>
    </div>
  );
};

export default ConfigPage;
