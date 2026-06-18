import React, { useEffect, useState } from 'react';
import { Form, Input, Button, Card, Spin, message, Row, Col, InputNumber } from 'antd';
import { api } from '../api';

const ConfigPage = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [originalConfig, setOriginalConfig] = useState(null);

  useEffect(() => {
    api.fetchConfig().then(data => {
      setOriginalConfig(data);
      form.setFieldsValue(data);
      setLoading(false);
    }).catch(err => {
      message.error('Failed to load config: ' + err.message);
      setLoading(false);
    });
  }, [form]);

  const onFinish = async (values) => {
    setSaving(true);
    try {
      const mergedConfig = { ...originalConfig, ...values };
      await api.saveConfig(mergedConfig);
      message.success('Configuration saved successfully');
      setOriginalConfig(mergedConfig);
    } catch (err) {
      message.error('Failed to save config: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Spin size="large" style={{ display: 'block', margin: '50px auto' }} />;
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <h2>System Configuration</h2>
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Card title="Feishu Configuration" style={{ marginBottom: 20 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name={['feishu', 'app_id']} label="App ID">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name={['feishu', 'app_secret']} label="App Secret">
                <Input.Password />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name={['feishu', 'bot_open_id']} label="Bot Open ID">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name={['feishu', 'group_chat_id']} label="Group Chat ID">
                <Input />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title="TAPD Configuration" style={{ marginBottom: 20 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name={['tapd', 'workspace_id']} label="Workspace ID">
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name={['tapd', 'api_token']} label="API Token">
                <Input.Password />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title="AI Model Configuration" style={{ marginBottom: 20 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name={['ai', 'api_base']} label="API Base URL">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name={['ai', 'api_key']} label="API Key">
                <Input.Password />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name={['ai', 'model']} label="Model Name">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name={['ai', 'temperature']} label="Temperature">
                <InputNumber step={0.1} min={0} max={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} size="large">
            Save Configuration
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ConfigPage;
