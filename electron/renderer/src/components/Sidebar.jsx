import React from 'react';
import { Layout, Menu, Button, Badge } from 'antd';
import {
  PlayCircleOutlined,
  SettingOutlined,
  FolderOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import '../global.css';

const { Sider } = Layout;

const MENU_ITEMS = [
  { key: 'run', icon: <PlayCircleOutlined />, label: '运行' },
  { key: 'settings', icon: <SettingOutlined />, label: '配置', guestHide: true },
  { key: 'files', icon: <FolderOutlined />, label: '文件' },
];

export default function Sidebar({
  activeView,
  onSwitchView,
  onLogout,
  statusLabel,
  running,
  version,
  isGuest,
}) {
  const items = MENU_ITEMS
    .filter((item) => !item.guestHide || !isGuest)
    .map((item) => ({
      key: item.key,
      icon: item.icon,
      label: item.label,
    }));

  return (
    <Sider
      width={220}
      style={{
        background: '#fff',
        borderRight: '1px solid #e5e7eb',
        display: 'flex',
        flexDirection: 'column',
        padding: '22px 14px',
      }}
    >
      <div className="sidebar-brand" style={{ marginBottom: 24 }}>
        <h1>妙手属性助手</h1>
        <p>本地自动填写工作台{version ? ` v${version}` : ''}</p>
      </div>

      <Menu
        mode="vertical"
        selectedKeys={[activeView]}
        items={items}
        onClick={({ key }) => onSwitchView(key)}
        style={{ border: 'none', flex: 1 }}
        className="nav-menu"
      />

      <div style={{ marginTop: 'auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            marginBottom: 8,
            color: '#6b7280',
            fontSize: 13,
          }}
        >
          <Badge
            status={running ? 'processing' : 'default'}
            color={running ? '#22c55e' : '#9ca3af'}
            className={running ? 'status-dot-running' : ''}
            style={running ? { animation: 'status-pulse 1.6s ease-in-out infinite' } : {}}
          />
          <span>{statusLabel}</span>
        </div>
        <Button
          block
          icon={<LogoutOutlined />}
          onClick={onLogout}
          style={{ justifyContent: 'flex-start', color: '#6b7280' }}
        >
          退出登录
        </Button>
      </div>
    </Sider>
  );
}
