import React, { useState, useEffect } from 'react';
import { Typography, Card, Table, Tag, DatePicker, Row, Col, Button, Modal, Spin, message, Select, Space } from 'antd';
import { EyeOutlined, CheckCircleOutlined, ClockCircleOutlined, StopOutlined, WarningOutlined, QuestionCircleOutlined, CloseOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';

const { Title, Text } = Typography;

export default function StandupsPage() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(dayjs());
  const [filterStatus, setFilterStatus] = useState('all');
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedStandup, setSelectedStandup] = useState(null);
  
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState('');

  const fetchStandups = async (dateStr, groupId) => {
    if (!groupId) return; // Wait for group to be selected
    setLoading(true);
    try {
      const json = await api.fetchStandups(dateStr, groupId);
      setData(json);
    } catch (err) {
      console.error(err);
      message.error(err.message || "获取站会数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const config = await api.fetchConfig();
        const configGroups = config.groups || [];
        setGroups(configGroups);
        if (configGroups.length > 0) {
          setSelectedGroup(configGroups[0].chat_id);
        } else {
          setData(null);
        }
      } catch (e) {
        console.error("Failed to fetch config", e);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (selectedGroup) {
      fetchStandups(selectedDate.format('YYYY-MM-DD'), selectedGroup);
    }
  }, [selectedDate, selectedGroup]);

  const columns = [
    {
      title: '成员名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '提交状态',
      key: 'submitted',
      render: (_, record) => (
        <Tag color={record.submitted ? 'success' : 'error'}>
          {record.submitted ? '已提交' : '未提交'}
        </Tag>
      ),
    },
    {
      title: '提交时间',
      key: 'time',
      render: (_, record) => {
        if (!record.submitted || !record.standup_content) return '-';
        const dateStr = record.standup_content.submitted_at;
        return dateStr ? new Date(dateStr).toLocaleTimeString() : '-';
      }
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        record.submitted ? (
          <Button 
            type="link" 
            icon={<EyeOutlined />}
            onClick={() => {
              setSelectedStandup(record.standup_content);
              setModalVisible(true);
            }}
          >
            查看详情
          </Button>
        ) : null
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}>站会统计</Title>
        <Space>
          <Select 
            value={selectedGroup} 
            onChange={setSelectedGroup} 
            style={{ width: 180 }}
            placeholder="请选择所属群组"
            options={groups.map(g => ({ label: g.name || g.chat_id, value: g.chat_id }))}
          />
          <Select value={filterStatus} onChange={setFilterStatus} style={{ width: 120 }}>
            <Select.Option value="all">全部状态</Select.Option>
            <Select.Option value="submitted">已提交</Select.Option>
            <Select.Option value="missing">未提交</Select.Option>
          </Select>
          <DatePicker 
            value={selectedDate} 
            onChange={(val) => val && setSelectedDate(val)} 
            allowClear={false}
          />
        </Space>
      </div>

      <Spin spinning={loading}>
        {data && (
          <>
            <Row gutter={16} style={{ marginBottom: 24 }}>
              <Col span={8}>
                <Card>
                  <div style={{ color: '#8c8c8c' }}>团队总人数</div>
                  <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{data.stats.total}</div>
                </Card>
              </Col>
              <Col span={8}>
                <Card>
                  <div style={{ color: '#8c8c8c' }}>已提交</div>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#52c41a' }}>{data.stats.submitted}</div>
                </Card>
              </Col>
              <Col span={8}>
                <Card>
                  <div style={{ color: '#8c8c8c' }}>未提交</div>
                  <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#f5222d' }}>{data.stats.missing}</div>
                </Card>
              </Col>
            </Row>

            <Table 
              dataSource={data.members.filter(m => 
                filterStatus === 'all' ? true : 
                filterStatus === 'submitted' ? m.submitted : !m.submitted
              )} 
              columns={columns} 
              rowKey="open_id"
              pagination={false}
            />
          </>
        )}
      </Spin>

      <Modal
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, borderBottom: '1px solid #f0f0f0', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 4, height: 18, background: '#1677ff', borderRadius: 2 }}></div>
              <span style={{ fontSize: 18, fontWeight: 600 }}>站会详情 - {selectedStandup?.user_name || ''}</span>
            </div>
            <Button type="text" icon={<CloseOutlined />} onClick={() => setModalVisible(false)} />
          </div>
        }
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={650}
        closeIcon={false}
        styles={{ header: { marginBottom: 0 }, body: { padding: '8px 0' } }}
      >
        {selectedStandup && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '60vh', overflowY: 'auto', paddingRight: 8 }}>
            <StandupSection icon={<CheckCircleOutlined style={{color: '#52c41a'}}/>} title="昨日完成" items={selectedStandup.yesterday_done} />
            <StandupSection icon={<ClockCircleOutlined style={{color: '#1677ff'}}/>} title="今日计划" items={selectedStandup.today_plan} />
            <StandupSection icon={<StopOutlined style={{color: '#faad14'}}/>} title="阻塞项" items={selectedStandup.blockers} />
            <StandupSection icon={<WarningOutlined style={{color: '#ff4d4f'}}/>} title="风险预警" items={selectedStandup.risks} />
            <StandupSection icon={<QuestionCircleOutlined style={{color: '#722ed1'}}/>} title="求助/需要决策" items={selectedStandup.decisions_needed} />
          </div>
        )}
      </Modal>
    </div>
  );
}

const StandupSection = ({ icon, title, items }) => (
  <div style={{ background: '#fafafa', borderRadius: 8, padding: '16px', border: '1px solid #f0f0f0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontWeight: 600, color: '#262626' }}>{title}</span>
    </div>
    {items?.length > 0 ? (
      <ul style={{ margin: 0, paddingLeft: 24, color: '#595959', lineHeight: 1.6 }}>
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    ) : (
      <Text type="secondary" style={{ paddingLeft: 24 }}>无</Text>
    )}
  </div>
);
