// Ant Design 主题定制 — 清爽企业工具风格
// 绿色主色 + 中性留白 + 深色日志区
export const theme = {
  token: {
    colorPrimary: '#10b981',
    colorPrimaryHover: '#059669',
    colorPrimaryActive: '#047857',
    colorSuccess: '#22c55e',
    colorInfo: '#3b82f6',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorBgLayout: '#f5f7fa',
    colorBgContainer: '#ffffff',
    colorBorder: '#e5e7eb',
    colorBorderSecondary: '#f0f0f0',
    colorText: '#1f2937',
    colorTextSecondary: '#6b7280',
    colorTextTertiary: '#9ca3af',
    borderRadius: 6,
    borderRadiusLG: 8,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    fontSize: 14,
    fontSizeHeading1: 20,
    fontSizeHeading2: 15,
    fontSizeHeading3: 14,
    lineHeight: 1.5,
    controlHeight: 38,
    controlHeightSM: 32,
    motionDurationMid: '180ms',
    motionEaseInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
    boxShadowSecondary: '0 4px 6px -1px rgba(15, 23, 42, 0.06), 0 2px 4px -2px rgba(15, 23, 42, 0.05)',
  },
  components: {
    Layout: {
      siderBg: '#ffffff',
      bodyBg: '#f5f7fa',
    },
    Menu: {
      itemBg: 'transparent',
      itemActiveBg: '#ecfdf5',
      itemSelectedColor: '#047857',
      itemBorderRadius: 6,
    },
    Card: {
      colorBgContainer: '#ffffff',
      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
    },
    Button: {
      borderRadius: 6,
      controlHeight: 36,
      primaryShadow: 'none',
    },
    Input: {
      borderRadius: 6,
      controlHeight: 38,
    },
    Select: {
      borderRadius: 6,
      controlHeight: 38,
    },
    Switch: {
      colorPrimary: '#10b981',
    },
    Progress: {
      remainingProcessColor: '#e5e7eb',
    },
    Alert: {
      colorInfoBg: '#ecfdf5',
      colorInfoBorder: '#a7f3d0',
    },
    List: {
      itemPadding: '10px 0',
    },
    Badge: {
      dotSize: 8,
    },
  },
};
