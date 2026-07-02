import React from 'react';
import { Card, Form, Input, Switch, InputNumber, Row, Col, Typography, Select } from 'antd';

const { Title, Text } = Typography;

export const EmailConfig: React.FC = () => {
  return (
    <Card 
      title={<Title level={5} style={{ margin: 0 }}>邮件发送配置 (SMTP)</Title>} 
      style={{ marginBottom: 24, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
    >
      <Form.Item name={['email', 'enabled']} valuePropName="checked" label="启用邮件发送">
        <Switch />
      </Form.Item>

      <Row gutter={16}>
        <Col span={16}>
          <Form.Item 
            name={['email', 'host']} 
            label="SMTP 服务器地址" 
            rules={[{ required: true, message: '请输入SMTP服务器地址' }]}
            tooltip="例如：smtp.qq.com 或 smtp.exmail.qq.com"
          >
            <Input placeholder="smtp.example.com" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item 
            name={['email', 'port']} 
            label="端口" 
            rules={[{ required: true, message: '请输入端口号' }]}
          >
            <InputNumber style={{ width: '100%' }} placeholder="465" />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={12}>
          <Form.Item 
            name={['email', 'user']} 
            label="发信邮箱账号" 
            rules={[{ required: true, message: '请输入发信邮箱账号' }]}
          >
            <Input placeholder="bot@example.com" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item 
            name={['email', 'pass']} 
            label="SMTP 授权码" 
            rules={[{ required: true, message: '请输入SMTP授权码' }]}
            tooltip="注意：这里通常是授权码，而不是网页登录密码"
          >
            <Input.Password placeholder="输入授权码" />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item 
        name={['email', 'from_address']} 
        label="发件人显示地址"
        tooltip="通常与发信邮箱账号保持一致"
      >
        <Input placeholder="bot@example.com" />
      </Form.Item>

      <Form.Item 
        name={['email', 'to_addresses']} 
        label="默认收件人列表" 
        rules={[{ required: true, message: '请至少输入一个收件人' }]}
        tooltip="会议纪要生成后，将会自动发送到这些邮箱"
      >
        <Select 
          mode="tags" 
          style={{ width: '100%' }} 
          placeholder="输入邮箱地址并按回车添加，例如：leader@example.com" 
          tokenSeparators={[',', ' ', ';']}
        />
      </Form.Item>

      <Form.Item name={['email', 'secure']} valuePropName="checked" label="使用 SSL/TLS 加密">
        <Switch />
      </Form.Item>
      
      <Text type="secondary" style={{ fontSize: '12px' }}>
        开启邮件功能后，机器人在生成会议纪要时，会自动将 Markdown 文件作为附件发送到默认收件人列表。
      </Text>
    </Card>
  );
};
