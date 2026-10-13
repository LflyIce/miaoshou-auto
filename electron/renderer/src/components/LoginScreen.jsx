import React, { useState } from 'react';
import { Card, Button, Input, Divider, Typography } from 'antd';
import { PlayCircleOutlined, LockOutlined } from '@ant-design/icons';
import '../global.css';

const { Title, Text } = Typography;

export default function LoginScreen({ onLogin, onGuestLogin }) {
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

        <Button
          type="primary"
          block
          size="large"
          icon={<PlayCircleOutlined />}
          onClick={onGuestLogin}
          style={{ height: 40, marginBottom: 20 }}
        >
          游客登录
        </Button>

        <Divider style={{ margin: '6px 0 14px', fontSize: 12 }}>管理员登录</Divider>

        <div style={{ display: 'grid', gap: 12 }}>
          <Input
            placeholder="admin"
            prefix={<LockOutlined style={{ color: '#9ca3af' }} />}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
          <Input.Password
            placeholder="密码"
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

        {error && (
          <Text type="danger" style={{ display: 'block', textAlign: 'center', marginTop: 8, fontSize: 13 }}>
            {error}
          </Text>
        )}
      </Card>
    </div>
  );
}
