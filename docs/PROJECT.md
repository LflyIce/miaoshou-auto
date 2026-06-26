# 妙手 ERP 商品必填属性自动填写助手 — 项目文档

> 本地运行的自动化工具，用于在妙手 ERP 商品编辑页中**自动填写"产品属性"的红色星号必填项**，同时完成日语/英文标题 SEO 优化、描述清理、SKU 规格整理、商品数据导出与批量保存。

---

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 技术栈](#2-技术栈)
- [3. 目录结构](#3-目录结构)
- [4. 整体架构](#4-整体架构)
- [5. 核心处理流程（单商品五步）](#5-核心处理流程单商品五步)
- [6. 核心模块详解](#6-核心模块详解)
- [7. 属性匹配决策算法（核心）](#7-属性匹配决策算法核心)
- [8. 类目知识库](#8-类目知识库)
- [9. AI 集成](#9-ai-集成)
- [10. 桌面版（Electron）架构](#10-桌面版electron架构)
- [11. 配置说明](#11-配置说明)
- [12. 数据产物文件](#12-数据产物文件)
- [13. 安装与运行](#13-安装与运行)
- [14. 测试](#14-测试)
- [15. 打包发布](#15-打包发布)
- [16. 扩展与维护指南](#16-扩展与维护指南)
- [17. 安全与注意事项](#17-安全与注意事项)
- [18. 已知限制与后续演进](#18-已知限制与后续演进)

---

## 1. 项目简介

### 解决的问题

妙手 ERP 商品编辑页里"产品属性"区域有大量**红色星号必填项**（材质、风格、供电方式、产地、品牌等），手动逐个填写非常耗时。本项目用浏览器自动化 + AI 把这个过程自动化：

1. 自动切换到"类别&属性"模块
2. 读取商品标题、主图、每个必填属性的控件类型和**页面真实可选项**
3. 调用 AI（智谱 GLM，兼容 OpenAI 接口）推断每个属性的值
4. 用一套逐级匹配算法，把 AI 值**映射到页面真实存在的选项**上
5. 自动填写、保存；保存失败则读取错误信息、AI 分析原因、修正后重试

### 不止填属性

实际能力远超"只填属性"，单商品处理链路包含：

| 能力 | 说明 |
|------|------|
| 日语/英文标题 SEO | 调 AI 两步生成 150–175 字符的无标点日语标题，并填写到对应输入框 |
| 产品描述清理 | 删除描述编辑器里的"文字"模块 |
| SKU 规格整理 | 规格一改名"型号"并保留 3 项，规格二保留 2 项，多余删除 |
| 必填属性填写 | 核心能力，支持 select / multi_select / input / 材质比例表 |
| 关联属性二次扫描 | 选择某属性后页面新出现的级联必填项会被自动补填 |
| 商品数据导出 | 导出图片、地址、日语标题、规格、申报价、采购成本到 Excel |
| 批量循环 | 保存成功后自动进入下一个商品；失败重试后跳过 |
| 类目知识库 | 按类目缓存历史属性值，同类目复用，减少 AI 调用 |

### 两种运行形态

- **命令行（CLI）**：`npm run login` 登录、`npm run fill` 批量填写。终端里看日志，按回车继续。
- **桌面应用（Electron）**：`npm run app` 启动图形界面，按钮操作、实时日志、配置表单、一键打开文件目录。可打包成 Windows 安装包。

两种形态共用同一套自动化核心（`src/*.js`），桌面版只是用子进程把它包装起来。

---

## 2. 技术栈

| 类别 | 技术 | 用途 |
|------|------|------|
| 运行时 | Node.js ≥ 18 | 主运行时（依赖原生 `fetch`） |
| 浏览器自动化 | Playwright | 驱动 Chromium/Edge 操作妙手页面 |
| AI 接口 | 智谱 GLM（OpenAI 兼容协议） | 属性推断、标题生成、保存错误分析、二次选择 |
| 数据导出 | ExcelJS | 写 `logs.xlsx` / `failed_items.xlsx` / `product_export_*.xlsx` |
| 配置/密钥 | dotenv | 读取 `.env` 中的 `ZAI_API_KEY` |
| 桌面端 | Electron + electron-builder | GUI 与 Windows NSIS 安装包打包 |
| 测试 | Node.js 内置 `assert` | 手写 fake 对象的单元测试，无第三方测试框架 |

浏览器默认用本机 Edge（`channel: msedge`），通常无需下载 Playwright 自带 Chromium。

---

## 3. 目录结构

```text
miaoshou-attribute-helper/
├── src/                          # 自动化核心（CLI 与桌面版共用）
│   ├── main.js                   # 批量填写主流程入口（npm run fill）
│   ├── login.js                  # 登录态保存入口（npm run login）
│   ├── utils.js                  # 配置加载、目录解析、浏览器参数、文本工具
│   ├── page_reader.js            # 读取标题/图片/产品链接/商品总数/当前索引/列表图
│   ├── module_navigator.js       # 自动切换页面模块（产品信息 / 类别&属性）
│   ├── attribute_scanner.js      # 扫描"类别&属性"区域必填属性及页面选项
│   ├── ai_analyzer.js            # 调用 AI：属性分析 / 标题改写 / 保存错误分析 / 二次选择
│   ├── option_matcher.js         # AI 值 → 页面真实选项 的逐级匹配算法
│   ├── filler.js                 # 按控件类型把值写进页面（select/input/multi/材质表）
│   ├── category_knowledge.js     # 类目知识库：读取、记录、参考复用、当前类目识别
│   ├── title_filler.js           # 定位并填写日语/英文标题输入框
│   ├── sku_reader.js             # 预读 SKU 表（颜色/申报价/缩略图）与规格值
│   ├── sku_filler.js             # 编辑规格：改名"型号"、删除多余规格项
│   ├── description_cleaner.js    # 清理产品描述中的"文字"模块
│   ├── product_export.js         # 导出商品数据 Excel
│   ├── save_feedback.js          # 保存反馈分类、暂停时机判断、校验问题抽取
│   ├── logger.js                 # logs.xlsx / failed_items.xlsx 读写
│   └── batch_flow.js             # 下一商品切换决策（纯函数）
│
├── electron/                     # 桌面端
│   ├── main.js                   # Electron 主进程：窗口、IPC、子进程任务、配置/目录管理
│   ├── preload.js                # 安全桥接 contextBridge → window.miaoshouApp
│   └── renderer/
│       ├── index.html            # 工作台界面（运行/配置/文件 三个视图）
│       ├── app.js                # 前端交互逻辑
│       └── style.css             # 界面样式
│
├── config/                       # 配置（会被桌面版复制到运行数据目录）
│   ├── config.json               # 主配置
│   ├── prompt_templates.json     # AI 提示词模板
│   ├── synonyms.json             # 同义词表
│   └── fallback_rules.json       # 兜底规则（全局/按字段/敏感字段）
│
├── storage/                      # 运行状态与知识库
│   ├── miaoshou_state.json       # 登录态（不提交）
│   └── category_attribute_knowledge.json  # 类目属性知识库
│
├── data/                         # 运行产物（不提交）
│   ├── logs.xlsx                 # 全量字段日志
│   ├── failed_items.xlsx         # 失败字段（含截图路径、错误信息）
│   ├── screenshots/              # 失败截图
│   └── product_export_YYYYMMDD.xlsx  # 商品数据导出
│
├── test/                         # 单元测试（node 直接跑）
├── docs/                         # 文档
│   ├── PROJECT.md                # ← 本文档
│   └── desktop-development.md    # 桌面版开发文档
├── dist/                         # 打包产物（不提交）
├── package.json
├── .env.example                  # ZAI_API_KEY 占位
└── README.md
```

---

## 4. 整体架构

### 4.1 分层

```text
┌─────────────────────────────────────────────────────────┐
│  Electron 渲染层 (renderer/app.js)                      │  按钮点击、日志展示、配置表单
│           ↕ window.miaoshouApp (contextBridge IPC)       │
├─────────────────────────────────────────────────────────┤
│  Electron 主进程 (electron/main.js)                     │  窗口、子进程管理、配置/目录读写
│           ↕ child_process.fork() + stdin('\n'继续)      │
├─────────────────────────────────────────────────────────┤
│  自动化核心 (src/*.js)                                   │  Playwright + AI + 匹配 + 知识库
│           ↕                                            │
│  Playwright → 本机 Edge → 妙手 ERP 页面                 │
│           ↕                                            │
│  智谱 GLM (OpenAI 兼容接口)                              │
└─────────────────────────────────────────────────────────┘
```

### 4.2 CLI 数据流

```text
loadConfig → 启动浏览器(加载登录态) → 打开 startUrl/productEditUrl
   → [等待回车确认页面]
   → 读商品总数/当前索引
   ┌─── 循环每个商品 ────────────────────────────────┐
   │ processCurrentProduct (单商品五步，见 §5)       │
   │   若 saveAfterFill：保存(失败→AI分析→重扫→重试) │
   │ goToNextProduct → 等待新商品就绪                  │
   └────────────────────────────────────────────────┘
   → 汇总打印 / 保存日志 / 保存知识库 / 关浏览器
```

### 4.3 关键设计原则

1. **页面真实选项优先**：所有 select / multi_select 的最终填写值必须来自页面真实可选项，AI 不能凭空造值。
2. **绝不乱填**：匹配不到合适选项就记失败（`manual_required`），不强行填。
3. **敏感字段谨慎**：材质、认证、品牌、产地等敏感字段不会随便套全局兜底，必须命中字段级规则。
4. **可追溯**：每个字段都记录 AI 值、最终值、匹配方式、置信度、原因、状态；失败额外记录错误与截图。
5. **核心与界面解耦**：`src/*.js` 不知道 Electron 存在，桌面版用子进程 + stdin 把"等待回车"桥接成"继续"按钮。

---

## 5. 核心处理流程（单商品五步）

`src/main.js` 的 `processCurrentProduct()` 是单商品处理主函数。日志里标注的五步如下（实际前后还有标题、描述、SKU、导出、保存等环节）：

### 前置：读取与准备
- `navigateToModule('产品信息')` 切到产品信息页
- `readProductInfo()` 读取标题、主图、URL
- `readCurrentProductImageUrl()` 从左侧商品列表读当前商品图

### [1/5] 读取商品标题和图片
已在准备阶段完成，打印日志确认。

### [2/5] 优化并填写产品标题
- `rewriteProductTitles()`（`ai_analyzer.js`）**两步生成**日语/英文标题
- `fillProductTitles()`（`title_filler.js`）定位输入框并填写
- `cleanDescription()` 删除产品描述中的"文字"模块
- 切到"类别&属性"模块**之前**，先 `readSkuTableData()` 预读 SKU、`readProductLink()` 读链接、`fillSkuProperties()` 编辑规格

> 为什么提前读 SKU？切换到"类别&属性"后 SKU 表格可能不再可见，所以要在产品信息页读好。

### [3/5] 扫描产品属性必填项
- `navigateToModule('类别&属性')` 自动定位模块
- `scanRequiredAttributes()` 扫描带红色星号且为空的属性行，识别控件类型、读取页面真实选项
- `readCurrentCategory()` 识别当前类目
- `categoryKnowledge.getReference()` 取该类目的历史参考
- `categoryKnowledge.recordCategoryAttributes()` 记录本次属性结构

### [4/5] 调用 AI 分析属性值
- `buildKnowledgeDecisions()` 先用知识库历史值**直接决策**部分字段（省 AI 调用）
- 剩余字段 `analyzeAttributes()` 一次性发给 AI，返回每个属性的 value/confidence/reason

### [5/5] 匹配页面真实选项并填写
- 对每个字段 `decideFinalValue()` → `chooseBestOption()` 走匹配链
- `fillAttribute()` 按控件类型写入页面
- 成功后 `categoryKnowledge.recordFillResult()` 回记知识库

### 后置：关联属性 / 导出 / 保存
- 再次 `scanRequiredAttributes()` 捕捉**级联新出现的必填属性**，补填
- `exporter.addProduct()` 写入商品数据 Excel（用提前读到的 SKU 数据）
- 若 `saveAfterFill=true`：`saveCurrentProductWithRetry()` 点击保存，失败则 `analyzeSaveError()` + 重扫重试

---

## 6. 核心模块详解

### 6.1 `attribute_scanner.js` — 扫描必填属性

`scanRequiredAttributes(page, { errorFields })` 的核心在浏览器内 `page.evaluate`：

- `findCategoryAttributeRoot()`：用打分算法在 DOM 里找"类别&属性"区块根节点（标题匹配 + 控件/行数加分 + 噪音区块扣分）。
- `collectRows()`：在根节点下收集属性行（优先 `.category-attr-item`，回退 `.el-form-item` / `tr` 等）。
- `isRequiredRow()`：判断是否必填——`is-required` 类名、红色 `*` 伪元素、`*` 文本、或带校验错误信息。
- `detectControlType()`：识别 `select` / `multi_select` / `input` / `material_ratio_table` / `unknown`。
- `detectAlreadyFilled()`：判断是否已填，配合 `skipAlreadyFilled` 跳过。

扫描后，对未填或报错的 select/multi_select，**真实点击打开下拉**读取选项（`readOptionsForAttribute`）；材质表则点"添加"读选项再清理。每个属性行被打上 `data-ms-attr-row` 唯一标记，供后续填写定位。

### 6.2 `option_matcher.js` — 选项匹配（详见 §7）

`chooseBestOption()` 是 AI 值落地的关键，逐级匹配后返回 `{ value, method, confidence, reason }`。

### 6.3 `filler.js` — 写入页面

`fillAttribute(page, attribute, finalValue)` 按控件类型分发：

| 控件 | 函数 | 关键逻辑 |
|------|------|----------|
| select | `fillSelect` | 打开下拉 → 点选项；找不到则输入搜索再点；最后 `verifyRowContains` 校验 |
| multi_select | `fillMultiSelect` | 逐个值打开下拉点选，校验全部存在 |
| input | `fillInput` | `fill('')` 清空再 `fill(value)`，校验输入值 |
| material_ratio_table | `fillMaterialRatioTable` | 确保有一行 → 选材质 → 比例填 100% → 校验 |

每个填写操作都带**校验回读**，校验失败抛错记失败。

### 6.4 `ai_analyzer.js` — AI 调用

四个 AI 能力，全部走 `postChatCompletion()`（智谱 OpenAI 兼容接口，`temperature: 0.1`，优先 `response_format: json_object`，失败回退）：

| 函数 | 用途 |
|------|------|
| `analyzeAttributes` | 一次性分析多个必填属性的值（带图片可选） |
| `secondChoice` | 匹配链里"AI 二次选择"，从页面选项中选最合适的一个 |
| `rewriteProductTitles` | 两步生成日语/英文标题（先扩写关键词，再生成 150–175 字符无标点标题） |
| `analyzeSaveError` | 保存失败时分析错误信息、定位字段、建议修正值 |

所有函数都有"带图片失败 → 去图片重试"的降级逻辑。

### 6.5 `category_knowledge.js` — 类目知识库

`CategoryKnowledge` 类 + `readCurrentCategory()`：

- **存储**：`storage/category_attribute_knowledge.json`，按 `normalizeKey(类目名)` 分桶，每个类目记 `sampleTitles`、`attributes[]`，每个属性记 `options[]` 和 `values{}`（值→出现次数）。
- **getReference()**：给 AI 当参考（历史常见值）。
- **buildKnowledgeDecisions()**（在 `main.js`）：对有可靠历史值的字段，**直接复用、跳过 AI**（详见 §8）。
- **recordFillResult()**：每次成功填写回记，值出现次数 +1，按 `maxSamplesPerAttribute` 截断。
- 当前知识库已积累 **82 个类目**。

### 6.6 其他模块速览

| 模块 | 职责 |
|------|------|
| `page_reader.js` | 读标题/图片/产品链接/商品总数(分页器·全局文本·列表数)/当前索引/列表图 URL |
| `module_navigator.js` | 点击 tab/menu 或滚动到"类别&属性"等模块 |
| `title_filler.js` | 打分定位日语/英文标题输入框并填写，触发 input/change 事件 |
| `sku_reader.js` | 读 `.jx-pro-virtual-table__row` 的颜色/申报价/缩略图；读规格 input 值 |
| `sku_filler.js` | 规格一改名"型号"+保留3项，规格二保留2项（从后往前删多余项） |
| `description_cleaner.js` | 打开描述编辑弹窗 → 删"文字"模块 → 保存/取消 |
| `product_export.js` | 导出 Excel，采购成本 = 申报价/4 |
| `save_feedback.js` | 保存反馈分类（成功/校验错误/系统错误）、暂停判断、校验问题抽取 |
| `logger.js` | ExcelJS 读写 logs/failed，文件被占用时自动换带时间戳的文件名 |
| `batch_flow.js` | 纯函数 `decideNextProductTransition`，决定是否继续批量 |

---

## 7. 属性匹配决策算法（核心）

这是项目最核心、最值得维护的部分。`option_matcher.js` 的 `chooseBestOption()` 按以下**严格优先级链**把 AI 推断值映射到页面真实选项：

| 序 | 匹配方式 (method) | 置信度 | 说明 |
|----|-------------------|--------|------|
| 1 | `exact` | 1.0 | AI 值与某页面选项**完全相等** |
| 2 | `normalized` | 0.98 | 去标点/全角转半角/小写后**完全相等** |
| 3 | `synonym` | 0.94 | 命中 `synonyms.json`（正向或反向同义词组） |
| 4 | `contains` | 0.90 | 页面选项**包含** AI 值 |
| 5 | `included_by` | 0.88 | AI 值**包含**页面选项 |
| 6 | `fuzzy` | 相似度 | 莱文斯坦(0.55)+杰卡德(0.45)加权相似度，≥ `autoSelectScore`(0.85) 才采用 |
| 7 | `ai_second_choice` | AI给 | 再调一次 AI 让它**只能在页面选项里选**，≥ `aiSecondChoiceScore`(0.7) 才采用 |
| 8a | `fallback` | 0.72 | 命中**字段级**兜底规则 `fallback_rules.byAttribute` |
| 8b | `fallback` | 0.65 | 命中**全局**兜底规则 `fallback_rules.global`（敏感字段会被跳过） |
| 9 | `neutral_fallback` | 0.45 | 页面里有"不适用/无/其他/通用"等中性项，选一个 |
| 10 | `manual_required` | 0 | 都不行 → 标记**需人工处理**，不填 |

### 兜底规则的特殊处理（`chooseFallback`）

- **字段级优先于全局**，且规则名按长度倒序匹配（长的更具体优先）。
- **敏感字段**（材质/材料/认证/证书/品牌/产地）**不会用全局兜底**，只有命中自己的字段级规则才兜底——避免把"材质"乱填成"其他"。

### 模糊相似度算法

`similarity(a, b)`：
```text
归一化两个文本 → 完全相等返回1
否则 = 莱文斯坦相似度 × 0.55 + 杰卡德相似度 × 0.45
```
`normalizeText` 会做全角转半角、小写、去括号内容、去标点和"请选择/全部/不限"等噪音词。

### 控件类型的最终决策（`decideFinalValue`）

- `input`：AI 给值→直接填；没给→中性兜底文本（数量填"1"、尺寸重量填"40"、否则"不适用"）
- `select`：走匹配链
- `multi_select`：把 AI 的多个值逐个匹配，全没匹配→manual_required
- `material_ratio_table`：只取材质名，比例固定 100%
- `unknown`：manual_required

---

## 8. 类目知识库

### 作用

按商品类目缓存历史属性值。遇到同类目时，对**有稳定历史值**的字段直接复用，省 AI 调用、提速、提高一致性。

### 复用决策（`main.js` 的 `buildKnowledgeDecisions` / `decideFromKnowledge`）

只有当历史值能在当前页面选项中**可靠匹配**（exact/normalized/synonym/contains/included_by/fuzzy 之一）时才复用。置信度公式：

```text
confidence = min(0.96, 0.78 + min(出现次数, 6) × 0.03)
```

即出现过越多次，越可信，但封顶 0.96。复用后会**重新走页面选项匹配**，保证填的是当前页面真实存在的值。

不同控件复用方式：

| 控件 | method | 说明 |
|------|--------|------|
| input | `knowledge_text` | 直接用历史文本值 |
| material_ratio_table | `knowledge_material` | 用历史材质值 |
| select | `knowledge_<匹配方式>` | 历史值匹配页面选项 |
| multi_select | `knowledge_multi_match` | 多个历史值各匹配一项 |

### 数据结构

```json
{
  "version": 1,
  "updatedAt": "...",
  "categories": {
    "<normalizeKey(类目名)>": {
      "categoryName": "...",
      "timesSeen": 3,
      "sampleTitles": ["...", "..."],
      "attributes": [
        {
          "name": "材质类型",
          "controlType": "select",
          "options": ["塑料", "金属", ...],
          "values": {
            "<normalizeKey(值)>": { "value": "金属", "count": 5, "lastUsedAt": "..." }
          },
          "timesSeen": 3
        }
      ]
    }
  }
}
```

`options` 每属性上限 120，`values` 每属性按 `maxSamplesPerAttribute`(20) 截断，`sampleTitles` 每类目上限 `maxTitlesPerCategory`(5)。

---

## 9. AI 集成

### 模型与接口

- 接口：智谱 BigModel（OpenAI 兼容），`config.ai.baseURL`
- 模型：`config.ai.model`（实际配置 `glm-5.1`）
- 密钥：`process.env[config.ai.apiKeyEnv]`（默认 `ZAI_API_KEY`，来自 `.env`）
- 图片：`config.ai.sendImages` 控制是否把商品主图发给视觉模型（关闭则纯文本）

### 请求特性（`postChatCompletion`）

- `temperature: 0.1`（追求稳定）
- `thinking: { type: 'disabled' }`（关闭思维链，避免污染 JSON）
- 优先 `response_format: { type: 'json_object' }`；接口报错（不支持/400）时自动回退纯文本
- 图片失败自动去图重试
- `extractJSON()` 健壮解析：去 ```` ```json ```` 围栏、截取首个 `{` 到末个 `}`

### 提示词（`config/prompt_templates.json`）

| 键 | 用途 |
|----|------|
| `attributeAnalysisSystem` | 属性分析系统提示（select 只能从 options 选、material 只填材质名、input 带单位只填数字等硬规则） |
| `secondChoiceSystem` | 二次选择系统提示（只能从 available_options 选） |

标题改写与保存错误分析的 system 提示在 `ai_analyzer.js` 内置（`defaultTitleRewritePrompt` 等）。

### 标题两步生成（`rewriteProductTitles`）

1. **扩写**：分析原标题，提取核心关键词 + 补充同义/近义/搜索热词，产出中文描述(≥200字) + 日文关键词(≥200字符)。
2. **生成**：基于扩写素材，按权重排序（核心词前置），删减/补充到 **150–175 字符**，**去除所有标点和空格**，并翻译成英文。

硬性约束：无标点、无 emoji、不编造功能、纯字符串。

---

## 10. 桌面版（Electron）架构

详见 [`docs/desktop-development.md`](desktop-development.md)，要点：

### 进程模型

- **主进程** `electron/main.js`：建窗口、管 IPC、`child_process.fork()` 启动 `src/login.js` 或 `src/main.js` 作为子进程，捕获 stdout/stderr 实时推给前端；通过向子进程 `stdin.write('\n')` 实现"继续"按钮。
- **预加载** `preload.js`：`contextBridge` 暴露 `window.miaoshouApp`，`nodeIntegration:false` + `contextIsolation:true`，安全。
- **渲染层** `renderer/`：纯前端，三个视图（运行/配置/文件）。

### IPC 接口（`window.miaoshouApp`）

| 方法 | 作用 |
|------|------|
| `loadSettings()` | 读 config.json + .env，返回配置、apiKey、各路径 |
| `saveSettings(settings)` | 深合并写入 config.json 与 .env |
| `startTask('login'\|'fill')` | fork 子进程启动任务 |
| `continueTask()` | 向子进程 stdin 写 `\n`（继续/确认） |
| `stopTask()` | kill 子进程 |
| `openPath('data'\|'storage'\|'config'\|'root')` | 系统资源管理器打开目录 |
| `onLog(handler)` / `onTaskState(handler)` | 订阅日志/状态 |

### 运行数据目录

- **开发**：直接用项目目录 `D:\666\miaoshou-attribute-helper`。
- **打包后**：用 `app.getPath('userData')`，通过 `MIAOSHOU_DATA_ROOT` 环境变量传给子进程。`prepareRuntime()` 会把默认 `config/` 与知识库复制过去，避免写 Program Files 失败。

---

## 11. 配置说明

### `config/config.json`

| 字段 | 默认 | 说明 |
|------|------|------|
| `startUrl` | 妙手首页 | 默认打开页 |
| `productEditUrl` | 空 | 直接打开某商品编辑页；空则开首页后手动进 |
| `headless` | false | 浏览器是否后台运行 |
| `browser.channel` | `msedge` | 用本机 Edge（可改 `chrome`） |
| `browser.executablePath` | 空 | 指定浏览器可执行文件路径（优先于 channel） |
| `browser.viewport` | 1920×1080 | 窗口尺寸 |
| `ai.baseURL` | 智谱 v4 | OpenAI 兼容接口地址 |
| `ai.model` | `glm-5.1` | 模型名 |
| `ai.apiKeyEnv` | `ZAI_API_KEY` | 从哪个环境变量读密钥 |
| `ai.sendImages` | false | 是否发商品图给视觉模型 |
| `thresholds.autoSelectScore` | 0.85 | 模糊匹配自动采用阈值 |
| `thresholds.aiSecondChoiceScore` | 0.7 | AI 二次选择采用阈值 |
| `modules.attributes` | 类别&属性 + 别名 | 自动导航的目标模块 |
| `behavior.saveAfterFill` | true | 填完自动点保存 |
| `behavior.screenshotOnError` | true | 失败截图 |
| `behavior.skipAlreadyFilled` | true | 跳过已填字段 |
| `behavior.waitForManualPage` | true | 启动后等回车确认页面 |
| `knowledgeBase.enabled` | true | 启用类目知识库 |
| `knowledgeBase.path` | `storage/...json` | 知识库路径 |
| `knowledgeBase.maxSamplesPerAttribute` | 20 | 每属性最多保留多少个历史值 |
| `knowledgeBase.maxTitlesPerCategory` | 5 | 每类目最多保留多少个样例标题 |
| `batch.maxProducts` | 0 | 处理上限，0=无限 |
| `batch.saveRetryLimit` | 1 | 保存失败重试次数 |
| `batch.saveFeedbackTimeoutMs` | 6000 | 等保存反馈超时 |
| `batch.nextProductWaitMs` | 4000 | 等下一商品就绪超时 |
| `batch.saveButtonSelectors` | [] | 自定义"保存"按钮选择器 |
| `batch.nextProductSelectors` | [] | 自定义"下一商品"选择器 |

> 注：`utils.js` 的 `loadConfig()` 有完整默认值兜底，缺字段不会崩。

### `config/synonyms.json`

同义词组，**支持双向**。例：`"长方形": ["矩形", ...]`——AI 给"长方形"能匹到页面"矩形"，反之亦可。

### `config/fallback_rules.json`

- `global`：全局兜底值（不适用/无/其他…）
- `byAttribute`：按字段名的兜底值（供电方式、品牌…），规则名按长度倒序、`includes` 模糊匹配
- `sensitiveAttributes`：敏感字段（材质/认证/品牌/产地…），禁用全局兜底

### `config/prompt_templates.json`

`attributeAnalysisSystem` 与 `secondChoiceSystem` 两段系统提示，可在此微调 AI 行为。

---

## 12. 数据产物文件

| 文件 | 内容 |
|------|------|
| `data/logs.xlsx` | 全量字段日志：time/pageUrl/productTitle/attributeName/controlType/options/aiValue/finalValue/matchMethod/confidence/status/reason |
| `data/failed_items.xlsx` | 失败字段：在 logs 列基础上 +screenshot +error |
| `data/screenshots/*.png` | 失败截图（全页） |
| `data/product_export_YYYYMMDD.xlsx` | 商品数据：图片/产品地址/日语标题/规格/申报价格/采购成本(=申报价/4) |
| `storage/miaoshou_state.json` | Playwright 登录态（不提交） |
| `storage/category_attribute_knowledge.json` | 类目知识库（提交，随用随长） |

`logger.js` 在文件被占用（Excel 打开）时会自动写到带时间戳的副本，不会卡死。

---

## 13. 安装与运行

### 环境要求

Node.js ≥ 18（依赖原生 `fetch`），Windows（桌面版面向 Windows）。

### 安装

```powershell
# 可选：用国内镜像加速
$env:npm_config_cache='D:\666\miaoshou-attribute-helper\.npm-cache'
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
# 用本机 Edge 通常无需下 Chromium；需要则：
# npx playwright install chromium
```

### 配置密钥

```bash
cp .env.example .env
# 编辑 .env：ZAI_API_KEY=你的智谱API密钥
```

### 命令行运行

```bash
npm run login   # 1. 登录并保存登录态（手动登录后回车）
npm run fill    # 2. 批量填写（自动打开编辑页、扫描、AI、填写、保存、下一个）
```

### 桌面版运行

```powershell
npm run app
```

界面：左侧导航（运行/配置/文件），运行页有登录/开始填写/继续/停止按钮 + 实时日志；配置页改 API Key、模型、URL、开关；文件页一键打开各目录。

---

## 14. 测试

无第三方测试框架，用 Node 内置 `assert` + 手写 fake 对象。位于 `test/`：

| 测试 | 覆盖 |
|------|------|
| `filler.material-table.test.js` | 材质比例表填写流程（FakePage 全流程） |
| `filler.material-table-fallback-option.test.js` | 材质表兜底选项 |
| `option_matcher.material-fallback.test.js` | 材质兜底匹配 |
| `sku_filler.test.js` | SKU 规格编辑/裁剪 |
| `save_feedback.test.js` | 保存反馈分类 |
| `batch_flow.next-product-stall.test.js` | 下一商品切换停滞判断 |

### 运行测试

```powershell
Get-ChildItem test -Filter *.test.js | ForEach-Object {
  Write-Host "RUN $($_.Name)"
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

### 语法检查（改完桌面端必跑）

```powershell
node -c electron\main.js
node -c electron\preload.js
node -c electron\renderer\app.js
node -c src\utils.js
```

---

## 15. 打包发布

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist
```

产物：

- `dist/妙手属性助手 Setup 1.0.0.exe`（NSIS 安装包，可选安装路径）
- `dist/win-unpacked/妙手属性助手.exe`（免安装版）

打包配置（`package.json` 的 `build`）要点：`asar:false`（子进程直接跑 `src/*.js`）、`signAndEditExecutable:false`（不签名，免下 winCodeSign）、知识库作为 `extraResources` 带入。

---

## 16. 扩展与维护指南

### 页面 DOM 结构变了，扫不到属性？

1. 在 `config/config.json` 的 `modules.attributes.aliases` 补充模块名称。
2. 在 `src/attribute_scanner.js` 的 `collectRows()` 选择器列表 / `isRequiredRow()` 必填标识 / `findCategoryAttributeRoot()` 打分里补充新结构。
3. 下拉选项读不到，看 `OPTION_SELECTORS`（scanner 和 filler 各有一份）是否覆盖新组件库。

### AI 老匹配不到正确的选项？

- 补 `config/synonyms.json` 同义词组（双向生效）。
- 补 `config/fallback_rules.json` 字段级兜底（敏感字段只能靠字段级规则）。
- 调 `thresholds.autoSelectScore`（降一点更容易采用模糊匹配，但更易误匹配）。

### 想加新的 AI 能力？

在 `src/ai_analyzer.js` 仿照现有函数新增，统一走 `postChatCompletion()` + `extractJSON()`，带"去图重试"降级；提示词放 `config/prompt_templates.json`。

### 想加新的控件类型？

1. `attribute_scanner.js` 的 `detectControlType()` 识别它。
2. `filler.js` 的 `fillAttribute()` 加分发分支 + 校验。
3. `option_matcher.js` 的 `decideFinalValue()`（在 `main.js`）加最终决策。
4. `category_knowledge.js` 的 `decideFromKnowledge()` 加知识库复用分支。

### 桌面端加新配置项？

1. `index.html` 加表单控件。
2. `app.js` 的 `els` + `init()` + `saveSettings()` 读写。
3. `electron/main.js` 的 `app:save-settings` 深合并写入。

---

## 17. 安全与注意事项

1. **不要**把妙手账号密码或真实 API Key 写进代码或提交。`.env` 已在 `.gitignore`。
2. **稳定前别开自动保存**（`saveAfterFill`）。
3. AI 判断失败时**不乱填**，失败字段进 `failed_items.xlsx`，需人工复核。
4. 认证/品牌/材质等字段**谨慎维护兜底规则**，敏感字段禁用全局兜底。
5. 所有 select/multi_select 的最终值**必须来自页面真实可选项**。
6. 遇到未知控件**记录失败并继续**，不强行操作。
7. `.env.example` 只放占位符；`miaoshou_state.json`、`data/*.xlsx`、`data/screenshots/` 不提交。

---

## 18. 已知限制与后续演进

### 当前限制

- 仅充分兼容 Element UI、Ant Design、`role=listbox/option` 等常见结构；**虚拟列表/级联控件**可能识别失败（记录后跳过，不强行操作）。
- 依赖妙手页面 DOM 稳定；页面大改需更新选择器与打分逻辑。
- 采购成本按申报价 ÷ 4 硬编码（`product_export.js`）。
- 第一版 UI（工作台）较简，暂无失败商品重跑、知识库可视化编辑、规则编辑、任务进度统计。

### 演进方向（按现有文档规划）

- 失败商品一键重跑。
- 知识库 / 同义词 / 兜底规则的可视化编辑界面。
- 任务进度统计与历史回看。
- 更鲁棒的虚拟列表/级联控件支持。

---

*文档基于源码与现有 `README.md`、`docs/desktop-development.md` 整理。配置与代码如有调整，请同步更新本文件。*
