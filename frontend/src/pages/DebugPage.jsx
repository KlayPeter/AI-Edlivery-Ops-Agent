import { useState, useEffect } from 'react';
import { Typography, Card, Button, Row, Col, message, Select, Space } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Title } = Typography;

const JOBS = [
  { id: 'standup-push', name: '推送站会模板', desc: '向所有成员私聊发送每日站会模板' },
  { id: 'standup-remind', name: '站会未交提醒', desc: '检查未交站会的成员并私聊提醒' },
  { id: 'standup-summary', name: '生成站会汇总', desc: '读取所有站会信息汇总发到研发群' },
  { id: 'overdue-scan', name: '超期任务扫描', desc: '扫描 TAPD 延期任务并通知负责人' },
  { id: 'daily-summary', name: '群聊日报归纳', desc: '读取群聊消息并让大模型总结出日报' },
  { id: 'dashboard', name: '看板生成与上传', desc: '获取全量故事状态、生成并分享进度看板' },
];

const DebugPage = () => {
  const [runningJob, setRunningJob] = useState(null);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState('');

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config = await api.fetchConfig();
        const configGroups = config.groups || [];
        setGroups(configGroups);
        if (configGroups.length > 0) {
          setSelectedGroup(configGroups[0].chat_id);
        }
      } catch (err) {
        console.error('Failed to fetch config for debug page:', err);
      }
    };
    fetchConfig();
  }, []);

  const handleRun = async (jobId) => {
    if (!selectedGroup) {
      message.warning('请先选择目标群聊');
      return;
    }
    setRunningJob(jobId);
    try {
      const res = await api.triggerJob(jobId, selectedGroup, false);
      if (res.ok) {
        message.success(res.message || `任务 ${jobId} 运行完成`);
      } else {
        message.warning(`任务可能未正常启动：${JSON.stringify(res)}`);
      }
    } catch (err) {
      message.error(`执行失败: ${err.message}`);
    } finally {
      setRunningJob(null);
    }
  };

  return (
    <div style={{ padding: '24px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}>流程调试面板</Title>
        <Space>
          <span>目标群聊：</span>
          <Select 
            value={selectedGroup} 
            onChange={setSelectedGroup} 
            style={{ width: 180 }}
            placeholder="请选择群聊"
            options={groups.map(g => ({ label: g.name || g.chat_id, value: g.chat_id }))}
          />
        </Space>
      </div>

      <Row gutter={[24, 24]}>
        {JOBS.map((job) => (
          <Col xs={24} md={12} lg={8} key={job.id}>
            <Card title={job.name} hoverable>
              <p style={{ height: 44, color: '#666' }}>{job.desc}</p>
              <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                <Button 
                  type="primary" 
                  icon={<PlayCircleOutlined />} 
                  loading={runningJob === job.id} 
                  onClick={() => handleRun(job.id)}
                >
                  运行
                </Button>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
};

export default DebugPage;
