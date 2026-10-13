import React, { useEffect, useRef, useState } from 'react';
import { Button, Progress, Typography } from 'antd';
import { ClearOutlined } from '@ant-design/icons';
import '../global.css';

const { Title } = Typography;

const STEP_NAMES = ['', '读取信息', '优化标题', '扫描属性', '填写属性', '保存商品'];

function parseProgress(text) {
  const stepMatch = text.match(/\[(?:商品\s*\d+|当前商品)\]\[(\d)\/5\]/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    const pct = Math.round((step / 5) * 100);
    return { visible: true, pct, label: `步骤 ${step}/5：${STEP_NAMES[step] || ''}` };
  }
  return null;
}

function shouldHideProgress(text) {
  return /保存成功|已跳过|保存失败/.test(text) && !/失败提示/.test(text);
}

export default function LogPanel() {
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState({ visible: false, pct: 0, label: '' });
  const preRef = useRef(null);
  const hideTimerRef = useRef(null);

  useEffect(() => {
    const handler = (payload) => {
      setLogs((prev) => [...prev, payload]);
      const prog = parseProgress(payload.text);
      if (prog) setProgress(prog);
      if (shouldHideProgress(payload.text)) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
          setProgress((p) => ({ ...p, visible: false }));
        }, 1500);
      }
    };
    window.miaoshouApp.onLog(handler);
    return () => clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logs]);

  const handleClear = () => setLogs([]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <Title level={4} style={{ margin: 0, fontSize: 15 }}>
          实时日志
        </Title>
        <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>
          清空
        </Button>
      </div>

      {progress.visible && (
        <div style={{ marginBottom: 10 }}>
          <Progress
            percent={progress.pct}
            strokeColor="#10b981"
            trailColor="#e5e7eb"
            showInfo={false}
            style={{ marginBottom: 4 }}
          />
          <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#111827' }}>
            {progress.label}
          </div>
        </div>
      )}

      <pre className="log-output" ref={preRef} style={{ flex: 1 }}>
        {logs.map((log, i) => {
          const cls = log.type === 'stderr' ? 'log-stderr' : log.type === 'info' ? 'log-info' : '';
          const prefix = log.type === 'stderr' ? '[错误] ' : log.type === 'info' ? '[状态] ' : '';
          return (
            <span key={i} className={cls}>
              {prefix}
              {log.text}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
