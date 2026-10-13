import React, { useEffect, useState } from 'react';
import { Button, Input, List, Card, Typography, message, Empty, Tag } from 'antd';
import {
  FolderOutlined,
  ReloadOutlined,
  CopyOutlined,
  CheckOutlined,
  SearchOutlined,
} from '@ant-design/icons';

const { Title, Text } = Typography;

export default function FilesView({ history: historyHook, isGuest, pathsText }) {
  const {
    history,
    searchResults,
    searching,
    searchEmpty,
    loadHistory,
    openHistory,
    searchDebounced,
    copyProductUrl,
  } = historyHook;

  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleSearch = (value) => {
    setQuery(value);
    searchDebounced(value);
  };

  const handleCopy = async (url, id) => {
    const result = await copyProductUrl(url);
    if (result?.ok) {
      setCopiedId(id);
      message.success('已复制');
      setTimeout(() => setCopiedId(null), 1500);
    } else {
      message.error('复制失败');
    }
  };

  const handleOpenPath = async (target) => {
    const result = await window.miaoshouApp.openPath(target);
    if (!result.ok) message.error(result.error || '打开失败');
  };

  return (
    <div>
      {/* 文件操作区（仅管理员） */}
      {!isGuest && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
            <Button icon={<FolderOutlined />} onClick={() => handleOpenPath('data')}>
              打开日志目录
            </Button>
            <Button icon={<FolderOutlined />} onClick={() => handleOpenPath('storage')}>
              打开知识库目录
            </Button>
            <Button icon={<FolderOutlined />} onClick={() => handleOpenPath('config')}>
              打开配置目录
            </Button>
            <Button icon={<FolderOutlined />} onClick={() => handleOpenPath('root')}>
              打开项目目录
            </Button>
          </div>

          <Card style={{ marginBottom: 16 }}>
            <Title level={5} style={{ margin: '0 0 8px', fontSize: 14 }}>
              运行文件
            </Title>
            <pre style={{ margin: 0, color: '#6b7280', fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {pathsText}
            </pre>
          </Card>
        </>
      )}

      {/* 商品检索 */}
      <Card style={{ marginBottom: 16 }}>
        <Title level={5} style={{ margin: '0 0 12px', fontSize: 14 }}>
          商品检索
        </Title>
        <Input.Search
          placeholder="输入日语标题关键字…"
          allowClear
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onSearch={(v) => handleSearch(v)}
          loading={searching}
          style={{ marginBottom: 12 }}
        />

        {!query && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            输入关键字后按回车或点击查找，从历史导出记录里检索。
          </Text>
        )}

        {query && searchEmpty && <Empty description="没有匹配的商品" image={Empty.SIMPLE_IMAGE} />}

        {searchResults.length > 0 && (
          <List
            dataSource={searchResults}
            renderItem={(item, index) => (
              <List.Item key={index} className="search-item-card" style={{ padding: '12px 0' }}>
                <div style={{ width: '100%' }}>
                  <div style={{ fontWeight: 600, color: '#111827', wordBreak: 'break-word', marginBottom: 4 }}>
                    {item.japaneseTitle}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12.5 }}>
                    日期：{item.date}　规格：{item.specifications || '—'}　申报价：{item.declaredPrice || '—'}
                  </Text>
                  <div style={{ marginTop: 8 }}>
                    {item.productUrl ? (
                      <Button
                        size="small"
                        icon={copiedId === index ? <CheckOutlined /> : <CopyOutlined />}
                        type={copiedId === index ? 'primary' : 'default'}
                        onClick={() => handleCopy(item.productUrl, index)}
                      >
                        {copiedId === index ? '已复制' : '复制产品地址'}
                      </Button>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>无地址</Text>
                    )}
                  </div>
                </div>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 填写历史 */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Title level={5} style={{ margin: 0, fontSize: 14 }}>
            填写历史
          </Title>
          <Button size="small" icon={<ReloadOutlined />} onClick={loadHistory}>
            刷新
          </Button>
        </div>

        {history.length === 0 ? (
          <Empty description={'暂无填写历史，运行一次「开始填写」后会按日期生成记录。'} image={Empty.SIMPLE_IMAGE} />
        ) : (
          <List
            dataSource={history}
            renderItem={(item) => (
              <List.Item
                className="history-list-item"
                style={{ padding: '10px 0' }}
                actions={[
                  <Button size="small" key="open" onClick={() => openHistory(item.fileName)}>
                    打开
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={<span style={{ fontWeight: 600 }}>{item.date}</span>}
                  description={<Text type="secondary">{item.sizeKb} KB</Text>}
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
