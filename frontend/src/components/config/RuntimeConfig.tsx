import { Card, Row, Col, Form, Input, Switch } from 'antd';

export const RuntimeConfig = () => {
  return (
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
  );
};
