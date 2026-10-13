import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Layout } from 'antd';
import LoginScreen from './components/LoginScreen';
import Sidebar from './components/Sidebar';
import RunView from './components/RunView';
import SettingsView from './components/SettingsView';
import FilesView from './components/FilesView';
import UpdateBanner from './components/UpdateBanner';
import { useAuth } from './hooks/useAuth';
import { useTask } from './hooks/useTask';
import { useHistory } from './hooks/useHistory';

const { Content } = Layout;

export default function App() {
  const auth = useAuth();
  const task = useTask();
  const historyHook = useHistory();
  const [activeView, setActiveView] = useState('run');
  const [settings, setSettings] = useState(null);
  const settingsFormRef = useRef(null);

  const loadSettings = useCallback(async () => {
    const data = await window.miaoshouApp.loadSettings();
    setSettings(data);
    return data;
  }, []);

  // 保存当前配置（RunView 启动任务前调用）
  const saveSettingsSilent = useCallback(async () => {
    if (settingsFormRef.current) {
      try {
        const values = settingsFormRef.current.getFieldsValue();
        await window.miaoshouApp.saveSettings(values);
      } catch (_) {
        // 表单未挂载或取值失败时忽略
      }
    }
    return { ok: true };
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSwitchView = (view) => {
    setActiveView(view);
    if (view === 'files') {
      historyHook.loadHistory();
    }
  };

  if (!auth.isLoggedIn) {
    return (
      <LoginScreen
        onLogin={auth.login}
        onGuestLogin={auth.loginGuest}
      />
    );
  }

  const handleSaveSettings = async (values) => {
    const result = await window.miaoshouApp.saveSettings(values);
    if (result.ok) {
      await loadSettings();
    }
    return result;
  };

  const pathsText = settings?.paths
    ? [
        `运行数据目录：${settings.paths.runtimeRoot || settings.paths.root || ''}`,
        `程序目录：${settings.paths.codeRoot || ''}`,
        `配置文件：${settings.paths.config || ''}`,
        `环境变量：${settings.paths.env || ''}`,
        `日志目录：${settings.paths.data || ''}`,
        `知识库目录：${settings.paths.storage || ''}`,
      ].join('\n')
    : '';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sidebar
        activeView={activeView}
        onSwitchView={handleSwitchView}
        onLogout={auth.logout}
        statusLabel={task.statusLabel}
        running={task.running}
        version={settings?.version || ''}
        isGuest={auth.isGuest}
      />
      <Content style={{ padding: '22px 24px', background: '#f5f7fa' }}>
        <UpdateBanner />
        {activeView === 'run' && (
          <RunView
            task={task}
            onSaveSilent={saveSettingsSilent}
            formRef={settingsFormRef}
          />
        )}
        {activeView === 'settings' && (
          <SettingsView
            settings={settings}
            onSave={handleSaveSettings}
            formRef={settingsFormRef}
          />
        )}
        {activeView === 'files' && (
          <FilesView
            history={historyHook}
            isGuest={auth.isGuest}
            pathsText={pathsText}
          />
        )}
      </Content>
    </Layout>
  );
}
