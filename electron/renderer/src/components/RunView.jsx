import React, { useState } from 'react';
import { Button, InputNumber, Divider, message } from 'antd';
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

export default function RunView({ task, onSaveSilent }) {
  const { running, disableMap, startTask, continueTask, stopTask } = task;
  const [temuMultiplier, setTemuMultiplier] = useState(2);

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
          padding: 16,
          marginBottom: 16,
          boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button
            type="primary"
            icon={<LoginOutlined />}
            disabled={disableMap.loginBtn}
            onClick={() => handleStart('login')}
          >
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

          <Divider type="vertical" style={{ height: 22 }} />

          <Button
            icon={<ShoppingOutlined />}
            disabled={disableMap.temuLoginBtn}
            onClick={() => handleStart('temu-login')}
          >
            登录Temu
          </Button>

          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13 }}>
            倍数
            <InputNumber
              min={1}
              step={0.1}
              value={temuMultiplier}
              onChange={(v) => setTemuMultiplier(v)}
              style={{ width: 72 }}
              size="small"
            />
          </span>

          <Button
            type="primary"
            icon={<DollarOutlined />}
            disabled={disableMap.temuBtn}
            onClick={() => handleStart('temu-price')}
          >
            Temu核价
          </Button>
          <Button
            icon={<SyncOutlined />}
            disabled={disableMap.temuRetailBtn}
            onClick={() => handleStart('temu-retail')}
          >
            Temu零售价
          </Button>

          <Divider type="vertical" style={{ height: 22 }} />

          <Button
            icon={<RightOutlined />}
            disabled={!running}
            onClick={continueTask}
          >
            继续
          </Button>
          <Button
            danger
            icon={<PauseCircleOutlined />}
            disabled={!running}
            onClick={stopTask}
          >
            停止
          </Button>
        </div>
      </div>

      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 18,
          height: 'calc(100vh - 220px)',
          boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
        }}
      >
        <LogPanel />
      </div>
    </div>
  );
}
