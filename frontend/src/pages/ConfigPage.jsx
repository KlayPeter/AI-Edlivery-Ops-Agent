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
      message.error('加载配置失败：' + err.message);
      setLoading(false);
    });
  }, [form]);

  const onFinish = async (values) => {
    setSaving(true);
    try {
      const mergedConfig = { ...originalConfig, ...values };
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
      <h2 style={{ marginBottom: 24 }}>系统配置</h2>
      <Form form={form} layout="vertical" onFinish={onFinish}>
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
              <Form.Item name={['feishu', 'group_chat_id']} label="群聊 ID">
                <Input />
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
              <Form.Item name={['ai', 'api_base']} label="API 地址 (Base URL)">
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
        </Card>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} size="large">
            保存配置
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ConfigPage;
