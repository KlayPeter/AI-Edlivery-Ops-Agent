import re

def update_config_page():
    with open("frontend/src/pages/ConfigPage.jsx", "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Remove group_chat_id column
    group_chat_id_block = re.search(r'(<Col span={12}>\s*<Form\.Item name={\[\'feishu\', \'group_chat_id\'\]}.*?</Col>)', content, re.DOTALL)
    if group_chat_id_block:
        content = content.replace(group_chat_id_block.group(1), "")

    # 2. Replace members form list with groups form list
    members_block = re.search(r'(<Card title="团队成员列表 \(Team Members\)".*?</Card>)', content, re.DOTALL)
    
    new_groups_block = """<Card title="群组配置 (Groups)" style={{ marginBottom: 20 }}>
              <Form.List name="groups">
                {(groupFields, { add: addGroup, remove: removeGroup }) => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {groupFields.map(({ key: groupKey, name: groupName, ...restGroupField }) => (
                      <Card key={groupKey} size="small" title={`群组 ${groupName + 1}`} extra={<MinusCircleOutlined onClick={() => removeGroup(groupName)} style={{ color: '#ff4d4f' }} />}>
                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item
                              {...restGroupField}
                              name={[groupName, 'name']}
                              label="群组名称"
                              rules={[{ required: true, message: '请输入群组名称' }]}
                            >
                              <Input placeholder="输入名称 (例如: 前端组)" />
                            </Form.Item>
                          </Col>
                          <Col span={16}>
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
                                  const opts = groups.map(g => ({ label: g.name, value: g.chat_id }));
                                  return opts;
                                })()}
                              />
                            </Form.Item>
                          </Col>
                        </Row>
                        
                        <Form.Item label="群成员列表" style={{ marginBottom: 0 }}>
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
                      </Card>
                    ))}
                    <Button type="dashed" onClick={() => addGroup({ members: [] })} block icon={<PlusOutlined />}>
                      添加新群组
                    </Button>
                  </div>
                )}
              </Form.List>
            </Card>"""
    
    if members_block:
        content = content.replace(members_block.group(1), new_groups_block)

    with open("frontend/src/pages/ConfigPage.jsx", "w", encoding="utf-8") as f:
        f.write(content)

if __name__ == "__main__":
    update_config_page()
