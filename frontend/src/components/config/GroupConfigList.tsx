import { Form, Button, Card, Row, Col, Select, Space, TimePicker, Input, Switch, message, FormInstance } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { api } from '@/api';

const JOBS = [
  { id: 'standup_push', name: '站会首次提醒' },
  { id: 'standup_second_remind', name: '站会再次提醒' },
  { id: 'standup_mark_missing', name: '记录未交站会' },
  { id: 'standup_summary', name: '生成站会汇总' },
  { id: 'overdue_scan', name: '超期任务扫描' },
  { id: 'daily_summary', name: '群聊日报归纳' },
  { id: 'dashboard', name: '看板生成与上传' },
];

interface GroupConfigListProps {
  form: FormInstance;
  groups: any[];
  groupsLoading: boolean;
  originalConfig: any;
  getDefaultGroupData: () => any;
  refreshGroups: () => void;
}

export const GroupConfigList = ({ form, groups, groupsLoading, originalConfig, getDefaultGroupData, refreshGroups }: GroupConfigListProps) => {
  return (
    <Card title="群组配置 (Groups)" style={{ marginBottom: 20 }} extra={
      <Button type="link" size="small" loading={groupsLoading} onClick={refreshGroups}>刷新飞书群聊</Button>
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
                          const selectedChats = form.getFieldValue('groups')?.map((g: any) => g?.chat_id).filter(Boolean) || [];
                          const currentChatId = form.getFieldValue(['groups', groupName, 'chat_id']);
                          
                          const combinedGroups = [...groups];
                          if (originalConfig && originalConfig.groups) {
                            originalConfig.groups.forEach((og: any) => {
                              if (og.chat_id && !combinedGroups.find((g: any) => g.chat_id === og.chat_id)) {
                                combinedGroups.push({ chat_id: og.chat_id, name: og.name || og.chat_id });
                              }
                            });
                          }

                          return combinedGroups.map((g: any) => ({ 
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
                                members: members.map((m: any) => ({ name: m.name, open_id: m.open_id, is_active: true }))
                              };
                              form.setFieldsValue({ groups: newGroups });
                              hide();
                              message.success('群成员已自动获取并填入！');
                            } catch (e: any) {
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
                        const members: any[] = await api.fetchGroupMembers(currentChatId);
                        const currentGroups = form.getFieldValue('groups') || [];
                        const newGroups = [...currentGroups];
                        newGroups[groupName] = {
                          ...newGroups[groupName],
                          members: members.map((m: any) => ({ name: m.name, open_id: m.open_id, is_active: true }))
                        };
                        form.setFieldsValue({ groups: newGroups });
                        hide();
                        message.success('群成员已重新获取！');
                      } catch (e: any) {
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
  );
};
