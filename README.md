# 妙手ERP商品必填属性自动填写助手

这是一个本地运行的简易自动化工具，用于在妙手ERP商品编辑页中自动填写“产品属性”里的红色星号必填项。

第一版会在当前商品编辑页里自动切换到“类别&属性”模块：读取标题、主图、必填属性和页面真实可选项，然后调用 OpenAI 兼容接口判断属性值，再用同义词、包含关系、模糊匹配和兜底规则选择页面里真实存在的选项。填写成功后会点击“保存修改”。

## 1. 安装依赖

需要 Node.js 18 或更高版本。

```bash
cd miaoshou-attribute-helper
npm install
npx playwright install chromium
```

如果 Playwright 自带 Chromium 下载很慢，可以直接使用本机 Edge。项目默认配置了：

```json
{
  "browser": {
    "channel": "msedge",
    "executablePath": ""
  }
}
```

这样通常不需要执行 `npx playwright install chromium`。如果想用本机 Chrome，可以把 `channel` 改成 `chrome`。

## 2. 配置环境变量

复制 `.env.example` 为 `.env`，填写你的智谱 API Key：

```bash
ZAI_API_KEY=your-zhipu-api-key
```

如果你使用兼容 OpenAI 格式的接口，修改 `config/config.json`：

```json
{
  "ai": {
    "baseURL": "https://open.bigmodel.cn/api/paas/v4/",
    "model": "GLM-5V-Turbo",
    "apiKeyEnv": "ZAI_API_KEY",
    "sendImages": true
  }
}
```

`GLM-5V-Turbo` 支持图片输入，项目会把商品标题、属性名、页面真实选项和商品主图一起发送给模型。如果你临时改用纯文本模型，可以把 `sendImages` 改成 `false`。

## 3. 登录并保存状态

```bash
npm run login
```

脚本会打开浏览器并进入妙手ERP登录页。你手动登录，确认登录完成后回到终端按回车，登录态会保存到：

```text
storage/miaoshou_state.json
```

工具不会保存你的妙手账号密码。

## 4. 批量填写商品编辑页

```bash
npm run fill
```

默认会打开 `config/config.json` 里的 `startUrl`。如果 `productEditUrl` 为空，脚本会等待你手动打开商品编辑页，然后按回车。程序会自动切换到“类别&属性”模块，再开始扫描和填写。

开启 `saveAfterFill=true` 后，程序会按当前编辑窗口持续处理商品：当前商品填写完成后点击“保存修改”，识别保存成功反馈后自动进入下一个商品；如果保存失败，会读取页面弹窗/提示里的失败信息，关闭提示后重新扫描当前商品并尝试更正，再保存一次。二次保存仍失败时，会记录失败原因和截图，然后跳过该商品继续下一个。

如果你想直接打开某个商品编辑页，可以配置：

```json
{
  "productEditUrl": "https://erp.91miaoshou.com/你的商品编辑页地址",
  "behavior": {
    "waitForManualPage": false,
    "saveAfterFill": true
  },
  "batch": {
    "maxProducts": 0,
    "saveRetryLimit": 1
  }
}
```

如果你想只填写不保存，可以改成：

```json
{
  "behavior": {
    "saveAfterFill": false
  }
}
```

默认配置为 `saveAfterFill=true`，成功填写至少一个字段后会点击“保存修改”。如果没有成功填写字段，不会点击保存，也会跳过当前商品。

批量相关配置：

```json
{
  "batch": {
    "maxProducts": 0,
    "saveRetryLimit": 1,
    "saveFeedbackTimeoutMs": 6000,
    "nextProductWaitMs": 4000,
    "saveButtonSelectors": [],
    "nextProductSelectors": []
  }
}
```

`maxProducts=0` 表示一直处理到找不到下一个商品；如果妙手页面的“保存”或“下一个商品”按钮比较特殊，可以把真实 CSS 选择器放进 `saveButtonSelectors` 或 `nextProductSelectors`。

### 类目属性知识库

程序会按产品类目维护本地知识库，默认文件为：

```text
storage/category_attribute_knowledge.json
```

当某个类目第一次出现时，会记录本次扫描到的必填属性、控件类型和页面选项。后续再次遇到同类目时，会把历史属性和值作为 AI 判断的参考；最终填写仍然会经过页面真实选项匹配，不会直接填入页面不存在的值。

可在 `config/config.json` 调整：

```json
{
  "knowledgeBase": {
    "enabled": true,
    "path": "storage/category_attribute_knowledge.json",
    "maxSamplesPerAttribute": 20,
    "maxTitlesPerCategory": 5
  }
}
```

## 5. 日志输出

每次运行会输出：

```text
data/logs.xlsx
data/failed_items.xlsx
data/screenshots/
```

日志字段包括：时间、页面 URL、商品标题、属性名、控件类型、页面真实选项、AI 推断值、最终填写值、匹配方式、置信度、状态和原因。

失败字段会额外记录错误信息和截图路径。

## 6. 修改同义词

编辑 `config/synonyms.json`。

示例：

```json
{
  "长方形": ["矩形", "竖款长方形", "方形长款"],
  "亚克力": ["PMMA", "塑料", "合成树脂", "有机玻璃"]
}
```

匹配逻辑支持正向和反向：AI 返回“长方形”，页面有“矩形”可以匹配；AI 返回“矩形”，页面有“长方形”也可以匹配。

## 7. 修改兜底规则

编辑 `config/fallback_rules.json`。

```json
{
  "global": ["不适用", "无", "其他"],
  "byAttribute": {
    "供电方式": ["无电源", "无需供电", "不适用", "无", "其他"],
    "品牌": ["无品牌", "Generic", "其他"]
  }
}
```

材质、认证、证书、品牌、产地等敏感字段会更谨慎。除非字段级规则命中，否则不会随便使用全局兜底。

## 8. 常见问题

**识别不到必填属性怎么办？**

妙手ERP页面可能更新了 DOM 结构。程序会先自动点击或滚动到“类别&属性”模块；如果仍识别不到，可以在 `config/config.json` 的 `modules.attributes.aliases` 里补充模块名称，或在 `src/attribute_scanner.js` 里补充新的行选择器/必填标识选择器。

**下拉框读取不到选项怎么办？**

确认点击属性下拉框时页面真的展示选项。当前已兼容 Element UI、Ant Design、`role=listbox/option` 等常见结构，但如果妙手使用了虚拟列表或级联控件，第一版会记录失败，不会强行操作。

**AI 返回了页面没有的值怎么办？**

程序会按完全匹配、标准化匹配、同义词、包含关系、模糊匹配、AI 二次选择、兜底规则逐级处理。最终选择必须来自页面真实选项。

**没有 API Key 能运行吗？**

能打开页面和扫描属性，但 AI 会返回需要人工处理，选择框只会尝试安全兜底，不会乱填。

**为什么默认不自动保存？**

如果开启 `saveAfterFill=true`，程序只会在至少一个字段成功填写后点击“保存修改”；扫描为空或全部失败时不会保存。

## 9. 注意事项

1. 不要把妙手账号密码写进代码。
2. 不要在未验证稳定前开启自动保存。
3. AI 判断失败时不要乱填，失败字段会进入 `failed_items.xlsx`。
4. 认证、品牌、材质等字段要谨慎维护兜底规则。
5. 所有 select 和 multi_select 的最终值都必须来自页面真实可选项。
6. 遇到未知控件会记录失败并继续处理下一个字段。
