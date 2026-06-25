import { Card, Row, Col, Form, Input, InputNumber } from 'antd';

export const FeishuConfig = () => {
  return (
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
  );
};
