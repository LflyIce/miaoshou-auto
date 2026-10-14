import React, { useEffect, useState } from 'react';
import { Form, Select, Input, InputNumber, Switch, Button, message, Typography } from 'antd';
import { SaveOutlined, RobotOutlined, ProfileOutlined, DollarOutlined } from '@ant-design/icons';

const { Title } = Typography;

// 配置分区：图标 + 标题 + 说明 + 双列表单，避免所有字段堆在一起
function Section({ icon, title, description, children }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: '#10b981', fontSize: 15, display: 'inline-flex' }}>{icon}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{title}</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{description}</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(280px, 1fr))',
          gap: '0 20px',
        }}
      >
        {children}
      </div>
    </section>
  );
}

// 长地址字段占满整行
const fullWidth = { gridColumn: '1 / -1' };

export default function SettingsView({ settings, onSave, formRef }) {
  const [form] = Form.useForm();
  const [providers, setProviders] = useState({});

  // 将 form 实例暴露给父组件；卸载时清理，避免残留的旧表单值在启动任务时被静默保存覆盖磁盘配置
  useEffect(() => {
    if (formRef) {
      formRef.current = form;
      return () => {
        if (formRef.current === form) formRef.current = null;
      };
    }
  }, [form, formRef]);

  useEffect(() => {
    if (settings) {
      const config = settings.config || {};
      const ai = config.ai || {};
      const behavior = config.behavior || {};
      const batch = config.batch || {};
      const temu = config.temu || {};

      setProviders(ai.providers || {});

      form.setFieldsValue({
        model: ai.model || '',
        apiKey: settings.apiKey || '',
        productEditUrl: config.productEditUrl || '',
        maxProducts: batch.maxProducts || 0,
        saveAfterFill: behavior.saveAfterFill !== false,
        waitForManualPage: behavior.waitForManualPage !== false,
        headless: Boolean(config.headless),
        sendImages: Boolean(ai.sendImages),
        temuMultiplier: temu.multiplier || 2,
        temuPriceCheckUrl: temu.priceCheckUrl || '',
        temuRetailPriceUrl: temu.retailPriceUrl || '',
      });
    }
  }, [settings, form]);

  const handleModelChange = (value) => {
    // 切换模型时回填新模型对应环境变量的已有 key，避免空输入框在保存时误导
    const nextProvider = providers[value] || {};
    const envName = nextProvider.apiKeyEnv || 'ZAI_API_KEY';
    const apiKeys = (settings && settings.apiKeys) || {};
    form.setFieldValue('apiKey', apiKeys[envName] || '');
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const result = await onSave(values);
      if (result.ok) {
        message.success('已保存');
      } else {
        message.error(result.error || '保存失败');
      }
    } catch (_) {
      // 表单校验失败
    }
  };

  const modelOptions = Object.entries(providers).map(([key, p]) => ({
    value: key,
    label: p.label || key,
  }));

  const currentModel = form.getFieldValue('model');
  const provider = providers[currentModel];
  const apiKeyPlaceholder = provider ? provider.apiKeyEnv : 'ZAI_API_KEY';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Title level={4} style={{ margin: 0, fontSize: 16 }}>
          配置
        </Title>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>
          保存配置
        </Button>
      </div>

      <Form form={form} layout="vertical">
        <Section icon={<RobotOutlined />} title="AI 模型" description="标题改写与属性分析所用模型">
          <Form.Item label="模型" name="model">
            <Select options={modelOptions} onChange={handleModelChange} />
          </Form.Item>

          <Form.Item label="API Key" name="apiKey">
            <Input.Password placeholder={apiKeyPlaceholder} autoComplete="off" />
          </Form.Item>

          <Form.Item label="发送商品图片给 AI" name="sendImages" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Section>

        <Section icon={<ProfileOutlined />} title="填写流程" description="妙手商品批量处理行为">
          <Form.Item label="商品编辑页 URL" name="productEditUrl" style={fullWidth}>
            <Input placeholder="留空则打开首页后手动进入编辑页" />
          </Form.Item>

          <Form.Item label="最大处理商品数（0 = 不限）" name="maxProducts">
            <InputNumber min={0} step={1} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item label="自动保存" name="saveAfterFill" valuePropName="checked" tooltip="开启后填写完成自动保存并进入下一个商品">
            <Switch />
          </Form.Item>

          <Form.Item
            label="启动后等待我确认页面"
            name="waitForManualPage"
            valuePropName="checked"
            tooltip="开启后启动任务时先暂停，等你在浏览器确认编辑页再开始"
          >
            <Switch />
          </Form.Item>

          <Form.Item label="后台浏览器" name="headless" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Section>

        <Section icon={<DollarOutlined />} title="Temu" description="商家后台价格工具">
          <Form.Item label="核价倍数" name="temuMultiplier" tooltip="申报价格核对时的换算倍数">
            <InputNumber min={1} step={0.1} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item label="Temu 核价页 URL" name="temuPriceCheckUrl" style={fullWidth}>
            <Input placeholder="Temu 商家后台核价列表页地址" />
          </Form.Item>

          <Form.Item label="Temu 零售价页 URL" name="temuRetailPriceUrl" style={fullWidth}>
            <Input placeholder="Temu 建议零售价填写页地址（含表格的抽屉所在页面）" />
          </Form.Item>
        </Section>
      </Form>
    </div>
  );
}
