import React from 'react';
import { Button, Divider, Space, Badge, message } from 'antd';
import {
  LoginOutlined,
  PlayCircleOutlined,
  ShoppingOutlined,
  DollarOutlined,
  SyncOutlined,
  PauseCircleOutlined,
  RightOutlined,
} from '@ant-design/icons';
import LogPanel from './LogPanel';

// 分组标题：小号灰色说明文字，界定功能区
const groupCaption = {
  fontSize: 12,
  color: '#6b7280',
  fontWeight: 500,
  marginBottom: 8,
  letterSpacing: '0.3px',
};

export default function RunView({ task, onSaveSilent }) {
  const { running, statusLabel, disableMap, startTask, continueTask, stopTask } = task;

  const handleStart = async (taskName) => {
    // 启动前先静默保存当前配置
    await onSaveSilent();
    const result = await startTask(taskName);
    if (!result.ok) {
      message.error(result.error || '启动失败');
    }
  };

  return (
    <div>
      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 16,
          boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          {/* 妙手 ERP 主流程 */}
          <div>
            <div style={groupCaption}>妙手 ERP</div>
            <Space>
              <Button icon={<LoginOutlined />} disabled={disableMap.loginBtn} onClick={() => handleStart('login')}>
                登录妙手
              </Button>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                disabled={disableMap.fillBtn}
                onClick={() => handleStart('fill')}
              >
                开始填写
              </Button>
            </Space>
          </div>

          <Divider type="vertical" style={{ height: 58, margin: '6px 0' }} />

          {/* Temu 侧工具 */}
          <div>
            <div style={groupCaption}>Temu 工具</div>
            <Space>
              <Button icon={<ShoppingOutlined />} disabled={disableMap.temuLoginBtn} onClick={() => handleStart('temu-login')}>
                登录Temu
              </Button>
              <Button
                type="primary"
                icon={<DollarOutlined />}
                disabled={disableMap.temuBtn}
                onClick={() => handleStart('temu-price')}
              >
                Temu核价
              </Button>
              <Button icon={<SyncOutlined />} disabled={disableMap.temuRetailBtn} onClick={() => handleStart('temu-retail')}>
                Temu零售价
              </Button>
            </Space>
          </div>

          {/* 任务控制靠右 */}
          <div style={{ marginLeft: 'auto' }}>
            <div style={{ ...groupCaption, textAlign: 'right' }}>任务</div>
            <Space>
              <Badge
                status={running ? 'processing' : 'default'}
                text={<span style={{ fontSize: 13, color: '#374151' }}>{statusLabel}</span>}
              />
              <Button icon={<RightOutlined />} disabled={!running} onClick={continueTask}>
                继续
              </Button>
              <Button danger icon={<PauseCircleOutlined />} disabled={!running} onClick={stopTask}>
                停止
              </Button>
            </Space>
          </div>
        </div>
      </div>

      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 18,
          height: 'calc(100vh - 248px)',
          boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
        }}
      >
        <LogPanel />
      </div>
    </div>
  );
}
