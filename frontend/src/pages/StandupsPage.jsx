import React, { useState, useEffect } from 'react';
import { Typography, Card, Table, Tag, DatePicker, Row, Col, Button, Modal, Spin, message, Descriptions, Select, Space } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
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

  const fetchStandups = async (dateStr) => {
    setLoading(true);
    try {
      const json = await api.fetchStandups(dateStr);
      setData(json);
    } catch (err) {
      console.error(err);
      message.error(err.message || "获取站会数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStandups(selectedDate.format('YYYY-MM-DD'));
  }, [selectedDate]);

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
        title={`站会详情 - ${selectedStandup?.user_name || ''}`}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={600}
      >
        {selectedStandup && (
          <Descriptions column={1} bordered>
            <Descriptions.Item label="昨日完成">
              {selectedStandup.yesterday_done?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {selectedStandup.yesterday_done.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <Text type="secondary">无</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="今日计划">
              {selectedStandup.today_plan?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {selectedStandup.today_plan.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <Text type="secondary">无</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="阻塞项">
              {selectedStandup.blockers?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {selectedStandup.blockers.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <Text type="secondary">无</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="风险预警">
              {selectedStandup.risks?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {selectedStandup.risks.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <Text type="secondary">无</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="求助/需要决策">
              {selectedStandup.decisions_needed?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {selectedStandup.decisions_needed.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              ) : <Text type="secondary">无</Text>}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}
