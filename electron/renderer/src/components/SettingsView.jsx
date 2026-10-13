import React, { useEffect, useState } from 'react';
import { Form, Select, Input, InputNumber, Switch, Button, message, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';

const { Title } = Typography;

export default function SettingsView({ settings, onSave, formRef }) {
  const [form] = Form.useForm();
  const [providers, setProviders] = useState({});

  // 将 form 实例暴露给父组件
  useEffect(() => {
    if (formRef) {
      formRef.current = form;
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

  const handleModelChange = () => {
    // placeholder 通过下面的计算属性动态显示
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
      <Title level={4} style={{ margin: '0 0 16px', fontSize: 16 }}>
        配置
      </Title>

      <Form
        form={form}
        layout="vertical"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(260px, 1fr))',
          gap: '0 16px',
        }}
      >
        <Form.Item label="模型" name="model">
          <Select options={modelOptions} onChange={handleModelChange} />
        </Form.Item>

        <Form.Item label="API Key" name="apiKey">
          <Input.Password
            placeholder={apiKeyPlaceholder}
            autoComplete="off"
          />
        </Form.Item>

        <Form.Item label="商品编辑页 URL" name="productEditUrl">
          <Input placeholder="留空则打开首页后手动进入编辑页" />
        </Form.Item>

        <Form.Item label="Temu 核价页 URL" name="temuPriceCheckUrl">
          <Input placeholder="Temu 商家后台核价列表页地址" />
        </Form.Item>

        <Form.Item label="Temu 零售价页 URL" name="temuRetailPriceUrl">
          <Input placeholder="Temu 建议零售价填写页地址（含表格的抽屉所在页面）" />
        </Form.Item>

        <Form.Item label="最大处理商品数" name="maxProducts">
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item label="自动保存" name="saveAfterFill" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item label="启动后等待我确认页面" name="waitForManualPage" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item label="后台浏览器" name="headless" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item label="发送商品图片给 AI" name="sendImages" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>

      <div style={{ marginTop: 16 }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>
          保存配置
        </Button>
      </div>
    </div>
  );
}
