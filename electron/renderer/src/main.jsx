import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { theme } from './theme';
import App from './App';
import './global.css';

createRoot(document.getElementById('root')).render(
  <ConfigProvider theme={theme} locale={zhCN}>
    <AntdApp>
      <App />
    </AntdApp>
  </ConfigProvider>
);
