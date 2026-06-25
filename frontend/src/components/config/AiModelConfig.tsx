import { Card, Row, Col, Form, Input, InputNumber } from 'antd';

export const AiModelConfig = () => {
  return (
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
  );
};
