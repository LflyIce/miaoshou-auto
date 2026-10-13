import { useState, useEffect, useCallback } from 'react';

const TASK_LABELS = {
  'login': '登录',
  'fill': '填写',
  'temu-login': '登录Temu',
  'temu-price': 'Temu核价',
  'temu-retail': 'Temu零售价',
};

export function useTask() {
  const [running, setRunning] = useState(false);
  const [taskName, setTaskName] = useState('');

  useEffect(() => {
    window.miaoshouApp.onTaskState((payload) => {
      setRunning(Boolean(payload.running));
      setTaskName(payload.taskName || '');
    });
  }, []);

  const startTask = useCallback(async (name) => {
    const result = await window.miaoshouApp.startTask(name);
    return result;
  }, []);

  const continueTask = useCallback(async () => {
    const result = await window.miaoshouApp.continueTask();
    return result;
  }, []);

  const stopTask = useCallback(async () => {
    await window.miaoshouApp.stopTask();
  }, []);

  const disableMap = {
    loginBtn: taskName === 'login',
    fillBtn: taskName === 'fill',
    temuLoginBtn: taskName === 'temu-login',
    temuBtn: taskName === 'temu-price',
    temuRetailBtn: taskName === 'temu-retail',
  };

  const statusLabel = running
    ? `运行中：${TASK_LABELS[taskName] || taskName}`
    : '空闲';

  return {
    running,
    taskName,
    statusLabel,
    disableMap,
    startTask,
    continueTask,
    stopTask,
  };
}
