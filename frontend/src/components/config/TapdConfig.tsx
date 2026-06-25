import { Card, Row, Col, Form, Input, InputNumber } from 'antd';

export const TapdConfig = () => {
  return (
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
  );
};
