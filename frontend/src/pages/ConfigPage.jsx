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
      if (config.groups && Array.isArray(config.groups)) {
        config.groups = config.groups.map(group => {
          const gSchedule = { ...(group.schedule || {}) };
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

  
  const handleTriggerJob = async () => {
    if (!debugJob || !debugGroup) {
      message.warning('请选择群聊和要调试的任务');
      return;
    }
    setDebugLoading(true);
    try {
      const res = await api.triggerJob(debugJob, debugGroup, false);
      const data = await res.json();
      if (res.ok) {
        message.success(data.message || '触发成功');
      } else {
        message.error(data.error || '触发失败');
      }
    } catch (e) {
      message.error(e.message);
    } finally {
      setDebugLoading(false);
    }
  };

  const getDefaultGroupData = () => {
    const fallback = originalConfig?.schedule || {};
    const s = {};
    JOBS.forEach(job => {
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
      if (mergedConfig.groups && Array.isArray(mergedConfig.groups)) {
        mergedConfig.groups = mergedConfig.groups.filter(g => g && g.chat_id).map(group => {
          const gSchedule = { ...(group.schedule || {}) };
          JOBS.forEach(job => {
            if (gSchedule[job.id] && dayjs.isDayjs(gSchedule[job.id])) {
              gSchedule[job.id] = gSchedule[job.id].format('HH:mm');
            }
          });
          
          let daily_summary_period = group.daily_summary_period;
          if (group.daily_summary_period_start && group.daily_summary_period_end) {
            daily_summary_period = `${group.daily_summary_period_start.format('HH:mm')}-${group.daily_summary_period_end.format('HH:mm')}`;
          }
          const groupInfo = groups.find(g => g.chat_id === group.chat_id);
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
            </Card>
            <Card title="群组配置 (Groups)" style={{ marginBottom: 20 }} extra={
              <Button type="link" size="small" loading={groupsLoading} onClick={async () => {
                setGroupsLoading(true);
                try {
                  const data = await api.fetchGroups();
                  setGroups(data);
                  message.success('已刷新飞书群聊列表');
                } catch(e) {
                  message.error('刷新群聊列表失败: ' + e.message);
                } finally {
                  setGroupsLoading(false);
                }
              }}>刷新飞书群聊</Button>
            }>
              <Form.List name="groups">
                {(groupFields, { add: addGroup, remove: removeGroup }) => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -8 }}>
                      <Button type="primary" onClick={() => addGroup(getDefaultGroupData())} icon={<PlusOutlined />}>
                        添加新群组
                      </Button>
                    </div>
                    {groupFields.map(({ key: groupKey, name: groupName, ...restGroupField }) => (
                      <Card key={groupKey} size="small" title={`群组 ${groupName + 1}`} extra={<MinusCircleOutlined onClick={() => removeGroup(groupName)} style={{ color: '#ff4d4f' }} />}>
                        <Row gutter={16}>
                          <Col span={24}>
                            <Form.Item
                              {...restGroupField}
                              name={[groupName, 'chat_id']}
                              label="绑定的飞书群聊"
                              rules={[{ required: true, message: '请选择或输入群聊ID' }]}
                            >
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
                                  const selectedChats = form.getFieldValue('groups')?.map(g => g?.chat_id).filter(Boolean) || [];
                                  const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);
                                  
                                  const combinedGroups = [...groups];
                                  if (originalConfig && originalConfig.groups) {
                                    originalConfig.groups.forEach(og => {
                                      if (og.chat_id && !combinedGroups.find(g => g.chat_id === og.chat_id)) {
                                        combinedGroups.push({ chat_id: og.chat_id, name: og.name || og.chat_id });
                                      }
                                    });
                                  }

                                  return combinedGroups.map(g => ({ 
                                    label: g.name, 
                                    value: g.chat_id,
                                    disabled: selectedChats.includes(g.chat_id) && g.chat_id !== currentChatId
                                  }));
                                })()}
                                onChange={async (val) => {
                                  if (val) {
                                    const hide = message.loading('获取群成员中...', 0);
                                    try {
                                      const members = await api.fetchGroupMembers(val);
                                      const currentGroups = form.getFieldValue('groups') || [];
                                      const newGroups = [...currentGroups];
                                      newGroups[groupName] = {
                                        ...newGroups[groupName],
                                        members: members.map(m => ({ name: m.name, open_id: m.open_id, is_active: true }))
                                      };
                                      form.setFieldsValue({ groups: newGroups });
                                      hide();
                                      message.success('群成员已自动获取并填入！');
                                    } catch (e) {
                                      hide();
                                      message.error('获取群成员失败：' + e.message);
                                    }
                                  }
                                }}
                              />
                            </Form.Item>
                          </Col>
                        </Row>

                        <Form.Item noStyle dependencies={[['groups', groupName, 'chat_id']]}>
                          {() => {
                            const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);
                            if (!currentChatId) return null;
                            return (
                              <>

                        <Form.Item label="群聊日报统计周期" required style={{ marginBottom: 16 }}>
                          <Space align="baseline">
                            <Form.Item {...restGroupField} name={[groupName, 'daily_summary_period_start']} rules={[{ required: true, message: '请选择起始时间' }]} style={{ marginBottom: 0 }}>
                              <TimePicker format="HH:mm" placeholder="起始时间" />
                            </Form.Item>
                            <span style={{ margin: '0 8px' }}>至</span>
                            <Form.Item {...restGroupField} name={[groupName, 'daily_summary_period_end']} rules={[{ required: true, message: '请选择结束时间' }]} style={{ marginBottom: 0 }}>
                              <TimePicker format="HH:mm" placeholder="结束时间" />
                            </Form.Item>
                          </Space>
                          <div style={{ fontSize: '12px', color: '#888', marginTop: 8 }}>
                            注：若起始时间 ≥ 结束时间，则视为跨天（如 18:00 至 18:00 为昨日18点到今日18点）。
                          </div>
                        </Form.Item>
                        
                        <Form.Item label={
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span style={{ marginRight: 8 }}>群成员列表</span>
                            <Button type="link" size="small" style={{ padding: 0 }} onClick={async () => {
                              const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);
                              if (!currentChatId) { message.warning('请先选择群聊'); return; }
                              const hide = message.loading('重新获取群成员中...', 0);
                              try {
                                const members = await api.fetchGroupMembers(currentChatId);
                                const currentGroups = form.getFieldValue('groups') || [];
                                const newGroups = [...currentGroups];
                                newGroups[groupName] = {
                                  ...newGroups[groupName],
                                  members: members.map(m => ({ name: m.name, open_id: m.open_id, is_active: true }))
                                };
                                form.setFieldsValue({ groups: newGroups });
                                hide();
                                message.success('群成员已重新获取！');
                              } catch (e) {
                                hide();
                                message.error('获取群成员失败：' + e.message);
                              }
                            }}>
                              重新拉取群成员
                            </Button>
                          </div>
                        } style={{ marginBottom: 0 }}>
                          <Form.List name={[groupName, 'members']}>
                            {(memberFields, { add: addMember, remove: removeMember }) => (
                              <>
                                {memberFields.map(({ key: memberKey, name: memberName, ...restMemberField }) => (
                                  <Space key={memberKey} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                                    <Form.Item
                                      {...restMemberField}
                                      name={[memberName, 'name']}
                                      rules={[{ required: true, message: '请输入姓名' }]}
                                      style={{ width: 150 }}
                                    >
                                      <Input placeholder="姓名 (Name)" />
                                    </Form.Item>
                                    <Form.Item
                                      {...restMemberField}
                                      name={[memberName, 'open_id']}
                                      rules={[{ required: true, message: '请输入飞书 Open ID' }]}
                                      style={{ width: 300 }}
                                    >
                                      <Input placeholder="飞书 Open ID" />
                                    </Form.Item>
                                    <Form.Item
                                      {...restMemberField}
                                      name={[memberName, 'role']}
                                      style={{ width: 150 }}
                                    >
                                      <Input placeholder="角色 (可选)" />
                                    </Form.Item>
                                    <Form.Item
                                      {...restMemberField}
                                      name={[memberName, 'is_active']}
                                      valuePropName="checked"
                                    >
                                      <Switch checkedChildren="在职" unCheckedChildren="离职" />
                                    </Form.Item>
                                    <MinusCircleOutlined onClick={() => removeMember(memberName)} style={{ color: '#ff4d4f' }} />
                                  </Space>
                                ))}
                                <Button type="dashed" onClick={() => addMember({ is_active: true })} block icon={<PlusOutlined />}>
                                  添加成员
                                </Button>
                              </>
                            )}
                          </Form.List>
                        </Form.Item>

                        <div style={{ marginTop: 24 }}>
                          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
                            <h4 style={{ margin: 0, marginRight: 12 }}>群组定时任务配置</h4>
                            <span style={{ color: '#888', fontSize: 13 }}>注：后端服务常驻时会按这里的时间自动触发；开关可随时关闭对应任务。</span>
                          </div>
                          <Row gutter={[16, 16]}>
                            {JOBS.map(job => (
                              <Col span={12} key={job.id}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                                  <span style={{ fontWeight: 500 }}>{job.name}</span>
                                  <Space size="middle">
                                    <Form.Item
                                      {...restGroupField}
                                      name={[groupName, 'schedule', job.id]}
                                      style={{ margin: 0 }}
                                      rules={[{ required: true, message: '请选择时间' }]}
                                    >
                                      <TimePicker format="HH:mm" style={{ width: 100 }} allowClear={false} />
                                    </Form.Item>
                                    <Form.Item
                                      {...restGroupField}
                                      name={[groupName, 'schedule', `${job.id}_enabled`]}
                                      valuePropName="checked"
                                      style={{ margin: 0 }}
                                    >
                                      <Switch />
                                    </Form.Item>
                                  </Space>
                                </div>
                              </Col>
                            ))}
                          </Row>
                        </div>

                              </>
                            );
                          }}
                        </Form.Item>
                      </Card>
                    ))}
                  </div>
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
