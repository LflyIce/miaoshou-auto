import React, { useState } from 'react';
import { Card, Button, Input, Typography } from 'antd';
import {
  UserOutlined,
  LockOutlined,
  IdcardOutlined,
  LeftOutlined,
} from '@ant-design/icons';
import '../global.css';

const { Title, Text } = Typography;

// 登录方式选项卡：图标 + 标题 + 说明
const optionStyle = {
  height: 64,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 12,
  padding: '0 16px',
};

function LoginOption({ icon, title, desc, onClick }) {
  return (
    <Button block style={optionStyle} onClick={onClick}>
      <span style={{ fontSize: 20, color: '#10b981', display: 'inline-flex' }}>{icon}</span>
      <span style={{ textAlign: 'left', lineHeight: 1.4 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12, color: '#6b7280' }}>{desc}</span>
      </span>
    </Button>
  );
}

export default function LoginScreen({ onLogin, onGuestLogin }) {
  const [mode, setMode] = useState('choose'); // choose | account
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAdminLogin = async () => {
    setError('');
    if (!username.trim() || !password) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    const result = await onLogin(username.trim(), password);
    setLoading(false);
    if (!result.ok) {
      setError(result.error || '登录失败');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleAdminLogin();
  };

  return (
    <div className="login-bg">
      <Card
        style={{ width: 360, border: '1px solid #e5e7eb', boxShadow: '0 10px 15px -3px rgba(15,23,42,0.08)' }}
        styles={{ body: { padding: '32px 28px' } }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title
            level={2}
            style={{
              margin: 0,
              background: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            妙手属性助手
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            请选择登录方式
          </Text>
        </div>

        {mode === 'choose' ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <LoginOption
              icon={<IdcardOutlined />}
              title="账号登录"
              desc="完整功能：运行任务与配置管理"
              onClick={() => {
                setError('');
                setMode('account');
              }}
            />
            <LoginOption
              icon={<UserOutlined />}
              title="游客登录"
              desc="免账号进入，仅查看，功能受限"
              onClick={onGuestLogin}
            />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <Button
              type="text"
              size="small"
              icon={<LeftOutlined />}
              onClick={() => {
                setError('');
                setMode('choose');
              }}
              style={{ justifySelf: 'start', paddingLeft: 0, color: '#6b7280' }}
            >
              返回选择
            </Button>
            <Input
              placeholder="账号"
              prefix={<UserOutlined style={{ color: '#9ca3af' }} />}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoFocus
            />
            <Input.Password
              placeholder="密码"
              prefix={<LockOutlined style={{ color: '#9ca3af' }} />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <Button
              type="primary"
              block
              size="large"
              loading={loading}
              onClick={handleAdminLogin}
              style={{ height: 40 }}
            >
              登录
            </Button>
          </div>
        )}

        {error && (
          <Text type="danger" style={{ display: 'block', textAlign: 'center', marginTop: 8, fontSize: 13 }}>
            {error}
          </Text>
        )}
      </Card>
    </div>
  );
}
