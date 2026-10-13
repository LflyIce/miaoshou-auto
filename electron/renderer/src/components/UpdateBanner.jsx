import React, { useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';

export default function UpdateBanner() {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    window.miaoshouApp.getUpdateStatus().then(setInfo);
    window.miaoshouApp.onUpdateAvailable((data) => setInfo(data));
  }, []);

  if (!info || !info.version) return null;

  return (
    <Alert
      type="info"
      showIcon
      icon={<DownloadOutlined />}
      message={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>
            发现新版本 v{info.version}{info.notes ? `　${info.notes}` : ''}
          </span>
          <Button
            size="small"
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => window.miaoshouApp.openDownloadUrl()}
          >
            立即下载
          </Button>
        </div>
      }
      closable
      onClose={() => setInfo(null)}
      style={{
        background: '#ecfdf5',
        border: '1px solid #a7f3d0',
        color: '#047857',
        marginBottom: 16,
      }}
    />
  );
}
