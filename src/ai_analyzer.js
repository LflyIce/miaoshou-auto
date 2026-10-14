const { loadConfig, readJSONSync, resolveRoot } = require('./utils');
const { AnthropicClient, extractJSON } = require('./anthropic_client');

function getPromptTemplates() {
  return readJSONSync(resolveRoot('config', 'prompt_templates.json'), {});
}

// ==================== 标题合规后处理 ====================
// 违禁词库（从原 system prompt 迁移到确定性代码，省 token）
// 每条: { pattern: 匹配正则, replace: 替换字符串, flags: 正则标志 }
const TITLE_BLOCKED_WORDS = [
  // 绝对化/夸大用语
  { pattern: '最', replace: '', flags: 'g' },
  { pattern: '第一', replace: '', flags: 'g' },
  { pattern: '顶级', replace: '高级', flags: 'g' },
  { pattern: '极品', replace: '优质', flags: 'g' },
  { pattern: '唯一', replace: '', flags: 'g' },
  { pattern: '绝对', replace: '', flags: 'g' },
  { pattern: '顶尖', replace: '高品质', flags: 'g' },
  { pattern: '最好', replace: '优质', flags: 'g' },
  { pattern: '非常好', replace: '优良', flags: 'g' },
  { pattern: '特别好', replace: '优良', flags: 'g' },
  { pattern: '最強', replace: '强力', flags: 'g' },
  { pattern: '絶対', replace: '', flags: 'g' },
  { pattern: 'No\\.1', replace: '', flags: 'gi' },
  { pattern: '军工级品质', replace: '高品质', flags: 'g' },
  { pattern: '第一品牌', replace: '人気品牌', flags: 'g' },
  { pattern: '领先品牌', replace: '人気品牌', flags: 'g' },
  { pattern: '超越', replace: '', flags: 'g' },
  // 医疗/功效宣称
  { pattern: '治病', replace: '', flags: 'g' },
  { pattern: '治疗', replace: '', flags: 'g' },
  { pattern: '消炎', replace: '', flags: 'g' },
  { pattern: '抗病毒', replace: '', flags: 'g' },
  { pattern: '减肥', replace: 'ダイエット', flags: 'g' },
  { pattern: '祛斑', replace: 'シミ対策', flags: 'g' },
  { pattern: '治愈', replace: '', flags: 'g' },
  { pattern: '增强免疫力', replace: '健康サポート', flags: 'g' },
  { pattern: '延缓衰老', replace: 'ケア', flags: 'g' },
  // 诱导性/紧迫性
  { pattern: '必买', replace: 'おすすめ', flags: 'g' },
  { pattern: '抢光', replace: '', flags: 'g' },
  { pattern: '错过后悔', replace: '', flags: 'g' },
  { pattern: '限时特价', replace: '現価格', flags: 'g' },
  { pattern: '限量', replace: '', flags: 'g' },
  { pattern: '秒杀', replace: '', flags: 'g' },
  { pattern: '万人疯抢', replace: '大人気', flags: 'g' },
  { pattern: 'hot sale', replace: '', flags: 'gi' },
  { pattern: 'clearance', replace: '', flags: 'gi' },
  { pattern: 'タイムセール', replace: '', flags: 'g' },
  { pattern: '在庫僅少', replace: '', flags: 'g' },
  // 虚假数据
  { pattern: '销量第一', replace: '好評発売中', flags: 'g' },
  { pattern: '十万好评', replace: '好評', flags: 'g' },
  { pattern: '全网最低价', replace: 'お得な価格', flags: 'g' },
  { pattern: '虚构原价', replace: '', flags: 'g' },
  // 质保/保修
  { pattern: 'warranty', replace: '', flags: 'gi' },
  { pattern: 'Money-back', replace: '', flags: 'gi' },
  { pattern: 'Lifetime Guarantee', replace: '', flags: 'gi' },
  { pattern: 'refund guarantee', replace: '', flags: 'gi' },
  { pattern: 'return guarantee', replace: '', flags: 'gi' },
  { pattern: 'extended warranty', replace: '', flags: 'gi' },
  { pattern: '质保', replace: '', flags: 'g' },
  { pattern: '保修', replace: '', flags: 'g' },
  { pattern: '返品保証', replace: 'アフターサービス', flags: 'g' },
  { pattern: '長期保証', replace: '品質に自信', flags: 'g' },
  // 环保无依据
  { pattern: 'environmental friendly', replace: '', flags: 'gi' },
  { pattern: 'save energy', replace: '', flags: 'gi' },
  { pattern: '100%環境に優しい', replace: '', flags: 'g' },
];

/**
 * 对 AI 生成的标题做违禁词清洗（确定性代码替代 AI 内嵌规则，省 token）。
 * 返回 { title, violations }，violations 为命中的违禁词列表。
 */
function sanitizeTitleCompliance(title) {
  let cleaned = String(title || '');
  const violations = [];
  for (const rule of TITLE_BLOCKED_WORDS) {
    const re = new RegExp(rule.pattern, rule.flags);
    if (re.test(cleaned)) {
      violations.push(rule.pattern);
      cleaned = cleaned.replace(re, rule.replace);
    }
  }
  return { title: cleaned, violations };
}

/**
 * 根据当前 config.ai.model 创建对应的 AnthropicClient 实例。
 * 支持 Anthropic / OpenAI 两种协议格式，通过 provider.apiType 自动切换。
 * - apiType: 'openai' → 智谱 GLM 常规 API（/paas/v4/chat/completions）
 * - apiType: 'anthropic'（默认）→ LongCat 等 Anthropic 兼容服务
 */
function createAIClient(modelOverride) {
  const config = loadConfig();
  const model = modelOverride || config.ai.model || '';
  const providers = (config.ai && config.ai.providers) || {};
  const provider = providers[model] || {};
  const baseURL = provider.baseURL || config.ai.baseURL || '';
  const apiKeyEnv = provider.apiKeyEnv || config.ai.apiKeyEnv || 'ZAI_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  const maxTokens = Number(config.ai.maxTokens) || 4096;
  const apiType = provider.apiType || 'anthropic';
  const timeoutMs = Number(config.ai.timeoutMs) || 0;
  // ai.thinking 显式为 true 才开启思考链，默认关闭以提速
  const enableThinking = config.ai.thinking === true;
  return new AnthropicClient({ baseURL, apiKey, model, maxTokens, apiType, enableThinking, ...(timeoutMs > 0 ? { timeoutMs } : {}) });
}

/**
 * 创建快速模型客户端（用于 secondChoice 等简单任务）。
 */
function createFastAIClient() {
  const config = loadConfig();
  const fastModel = config.ai.fastModel || '';
  // 如果未配置快速模型或与主模型相同，回退到主模型
  if (!fastModel || fastModel === config.ai.model) return createAIClient();
  return createAIClient(fastModel);
}

/**
 * 从 provider 配置中读取 apiKeyEnv（用于错误提示）。
 */
function resolveApiKeyEnv() {
  const config = loadConfig();
  const model = config.ai.model || '';
  const providers = (config.ai && config.ai.providers) || {};
  const provider = providers[model] || {};
  return provider.apiKeyEnv || config.ai.apiKeyEnv || 'ZAI_API_KEY';
}

async function analyzeAttributes(productInfo, requiredAttributes, knowledgeContext = null, retryCount = 0) {
  const templates = getPromptTemplates();
  const apiKeyEnv = resolveApiKeyEnv();
  const apiKey = process.env[apiKeyEnv];

  if (!apiKey) {
    throw new Error(`缺少环境变量 ${apiKeyEnv}`);
  }

  const config = loadConfig();
  const maxRetries = Number(config.ai.maxRetries) || 2;
  const client = createAIClient();

  const payload = {
    productInfo: {
      title: productInfo.title || '',
      images: productInfo.images || [],
      url: productInfo.url || '',
      categoryName: productInfo.categoryName || ''
    },
    requiredAttributes: requiredAttributes.map((attr) => ({
      name: attr.name,
      controlType: attr.controlType,
      options: attr.options || [],
      errorMessage: attr.errorMessage || ''
    })),
    outputFormat: {
      attributes: [
        {
          name: '属性名',
          value: '选中的值或 null',
          confidence: 0.9,
          reason: '简短理由',
          need_manual: false
        }
      ]
    }
  };
  if (knowledgeContext) {
    payload.categoryKnowledgeReference = knowledgeContext;
  }

  const userText = `请分析下面商品的必填属性，并只返回 JSON。\n${JSON.stringify(payload, null, 2)}`;
  const system = templates.attributeAnalysisSystem || defaultAnalysisPrompt();
  const requestImages = config.ai.sendImages === false ? [] : (productInfo.images || []);

  try {
    const tAi = Date.now();
    const content = await client.completeWithFallback({
      system,
      userText,
      images: requestImages
    });
    console.log(`[耗时] analyzeAttributes AI响应: ${Date.now() - tAi}ms, 模型=${client.model}, 字段数=${requiredAttributes.length}${retryCount > 0 ? ` (第${retryCount + 1}次)` : ''}`);
    return normalizeAnalysis(extractJSON(content), requiredAttributes);
  } catch (error) {
    if (retryCount < maxRetries) {
      const waitMs = (retryCount + 1) * 3000;
      console.warn(`[属性AI] 分析失败 (${retryCount + 1}/${maxRetries + 1}): ${error.message}，${waitMs / 1000}s 后重试...`);
      await sleep(waitMs);
      return analyzeAttributes(productInfo, requiredAttributes, knowledgeContext, retryCount + 1);
    }
    throw new Error(`属性分析重试 ${maxRetries + 1} 次后仍失败: ${error.message}`);
  }
}

async function secondChoice(input) {
  const templates = getPromptTemplates();
  const apiKeyEnv = resolveApiKeyEnv();
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) return null;

  const client = createAIClient();

  const payload = {
    attribute_name: input.attrName || input.attribute_name,
    ai_inferred_value: input.inferredValue || input.ai_inferred_value,
    available_options: input.availableOptions || input.available_options || [],
    product_title: input.productTitle || input.product_title || '',
    images: input.images || [],
    outputFormat: {
      selected_option: '必须来自 available_options',
      confidence: 0.9,
      reason: '简短理由'
    }
  };

  const userText = `请从 available_options 中选择最合适的一项，并只返回 JSON。\n${JSON.stringify(payload, null, 2)}`;
  const system = templates.secondChoiceSystem || defaultSecondChoicePrompt();

  try {
    const content = await client.completeWithFallback({
      system,
      userText,
      images: payload.images || []
    });
    const parsed = extractJSON(content);
    return {
      selected_option: parsed.selected_option || parsed.value || null,
      confidence: Number(parsed.confidence || 0),
      reason: parsed.reason || 'AI 二次选择'
    };
  } catch (error) {
    return null;
  }
}

/**
 * 批量二次选择：一次 AI 调用处理多个字段，减少网络往返。
 * @param {Array<{attrName, inferredValue, availableOptions, productTitle}>} inputs
 * @returns {Array<{selected_option, confidence, reason} | null>}
 */
async function secondChoiceBatch(inputs, retryCount = 0) {
  if (!inputs || !inputs.length) return [];

  const templates = getPromptTemplates();
  const apiKeyEnv = resolveApiKeyEnv();
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) return inputs.map(() => null);

  const config = loadConfig();
  const maxRetries = Number(config.ai.maxRetries) || 2;

  // P1-2: 简单匹配任务使用快速模型（如 LongCat-Flash-Chat），提速降本
  const client = createFastAIClient();

  const payload = inputs.map((input, index) => ({
    index,
    attribute_name: input.attrName || '',
    ai_inferred_value: input.inferredValue || '',
    available_options: (input.availableOptions || []).slice(0, 30),
    product_title: input.productTitle || ''
  }));

  const userText = `请为以下每个属性从 available_options 中选择最合适的一项。返回 JSON 数组，每个元素包含 index、selected_option、confidence、reason。\n\n${JSON.stringify(payload, null, 2)}`;
  const system = templates.secondChoiceSystem || defaultSecondChoicePrompt();

  try {
    const tAi = Date.now();
    const content = await client.completeText({ system, userText });
    console.log(`[耗时] secondChoiceBatch AI响应: ${Date.now() - tAi}ms, 模型=${client.model}${retryCount > 0 ? ` (第${retryCount + 1}次)` : ''}`);
    const parsed = extractJSON(content);
    const results = Array.isArray(parsed) ? parsed : (parsed.results || parsed.attributes || []);
    const byIndex = new Map();
    for (const r of results) {
      const idx = Number(r.index);
      if (!Number.isNaN(idx)) {
        byIndex.set(idx, {
          selected_option: r.selected_option || r.value || null,
          confidence: Number(r.confidence || 0),
          reason: r.reason || 'AI 二次选择'
        });
      }
    }
    return inputs.map((_, i) => byIndex.get(i) || null);
  } catch (error) {
    if (retryCount < maxRetries) {
      const waitMs = (retryCount + 1) * 2000;
      console.warn(`[二次选择] 失败 (${retryCount + 1}/${maxRetries + 1}): ${error.message}，${waitMs / 1000}s 后重试...`);
      await sleep(waitMs);
      return secondChoiceBatch(inputs, retryCount + 1);
    }
    // 重试耗尽仍失败，返回 null 数组（各字段走 fallback/manual）
    console.warn(`[二次选择] 重试 ${maxRetries + 1} 次后仍失败: ${error.message}`);
    return inputs.map(() => null);
  }
}

/**
 * 提前发起标题生成，与 DOM 操作（描述清理/SKU/规格编辑）并行。
 * corrections 命中时直接返回修正值（不调 AI）；返回的 titles 带 __corrected 标记供日志区分。
 */
function startTitleGeneration(productInfo, corrections = {}) {
  const japaneseTitle = corrections['产品标题'] || corrections['japaneseTitle'] || '';
  const englishTitle = corrections['英文标题'] || corrections['englishTitle'] || '';
  if (japaneseTitle || englishTitle) {
    return Promise.resolve({ japaneseTitle, englishTitle, __corrected: true });
  }
  return rewriteProductTitles(productInfo);
}

async function rewriteProductTitles(productInfo, retryCount = 0) {
  const templates = getPromptTemplates();
  const apiKeyEnv = resolveApiKeyEnv();
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`缺少环境变量 ${apiKeyEnv}`);
  }

  const config = loadConfig();
  const maxRetries = Number(config.ai.maxRetries) || 2; // 默认重试 2 次
  const client = createAIClient();
  const requestImages = config.ai.sendImages === false ? [] : (productInfo.images || []);
  const titleSystemPrompt = templates.titleRewriteSystem || defaultTitleRewritePrompt();

  // 一步完成：分析标题 → 扩写关键词 → 合规校验 → 生成最终标题
  const payload = {
    sourceTitle: productInfo.title || '',
    task: '分析产品标题，提取核心关键词，结合日本电商搜索热词进行扩写，同时完成违禁词扫描与合规校验，最终生成符合日本电商SEO的日文标题和英文标题',
    outputFormat: {
      japaneseTitle: '不超过175字符的纯日文字符串，无标点无空格无换行；素材不足时自然收尾（不足150也没关系），严禁凑字数',
      englishTitle: '对应的跨境电商英文标题'
    }
  };

  const userText = `请分析并优化以下产品标题，只返回JSON。\n${JSON.stringify(payload, null, 2)}`;

  try {
    const tAi = Date.now();
    const content = await client.completeWithFallback({
      system: titleSystemPrompt,
      userText,
      images: requestImages
    });
    console.log(`[耗时] rewriteProductTitles AI响应: ${Date.now() - tAi}ms, 模型=${client.model}${retryCount > 0 ? ` (第${retryCount + 1}次)` : ''}`);
    const titles = normalizeTitles(extractJSON(content));

    // 违禁词后处理（确定性代码，替代原 prompt 中的违禁词库，省 token）
    const jpClean = sanitizeTitleCompliance(titles.japaneseTitle);
    if (jpClean.violations.length) {
      console.warn(`[标题] 日文标题命中违禁词 ${jpClean.violations.length} 个，已自动清洗: ${jpClean.violations.slice(0, 5).join(', ')}`);
    }
    titles.japaneseTitle = jpClean.title;

    // 质量校验：AI 把报错文字/重复填充/乱码当标题输出的情况一律拒绝重试，
    // 宁可标题短一点或本商品不填标题，也不能把垃圾文字填进 ERP
    const suspicious = isSuspiciousJapaneseTitle(titles.japaneseTitle);
    if (suspicious) {
      throw new Error(`日文标题疑似异常输出(${suspicious}): ${titles.japaneseTitle.slice(0, 40)}...`);
    }

    if (titles.japaneseTitle.length < 120) {
      console.warn(`[标题] 日文标题 ${titles.japaneseTitle.length} 字符，不足 120（不再强制凑 150，避免模型填充垃圾词）`);
    } else {
      console.log(`[标题] 标题生成完成: ${titles.japaneseTitle.length} 字符`);
    }
    return titles;
  } catch (error) {
    // AI 请求失败时重试，达到上限仍失败才抛出异常
    if (retryCount < maxRetries) {
      const waitMs = (retryCount + 1) * 3000; // 等 3s、6s 再重试
      console.warn(`[标题] 标题生成失败 (${retryCount + 1}/${maxRetries + 1}): ${error.message}，${waitMs / 1000}s 后重试...`);
      await sleep(waitMs);
      return rewriteProductTitles(productInfo, retryCount + 1);
    }
    // 重试耗尽仍失败，抛出异常让上层处理
    throw new Error(`标题生成重试 ${maxRetries + 1} 次后仍失败: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitles(parsed) {
  const japaneseTitle = sanitizeJapaneseTitle(parsed.japaneseTitle || parsed.japanesetitle || parsed['日文标题'] || parsed.productTitle || parsed.title || '');
  let englishTitle = sanitizeEnglishTitle(parsed.englishTitle || parsed.englishtitle || parsed['英文标题'] || parsed.enTitle || parsed.english || '');

  // 安全校验：如果"英文标题"实际包含日文（假名/汉字），说明 AI 返回了错误内容，丢弃
  if (englishTitle && /[぀-ゟ゠-ヿ一-鿿]/.test(englishTitle)) {
    console.warn(`[标题] 英文标题包含日文字符，已丢弃: ${englishTitle.slice(0, 40)}...`);
    englishTitle = '';
  }
  // 安全校验：英文标题是 AI 的报错/说明文字（如 "Error No valid product title..."），丢弃
  if (englishTitle && (/^(error|invalid|no valid|sorry|i cannot|unable)/i.test(englishTitle) || /sourceTitle|provide (a )?(valid|product)/i.test(englishTitle))) {
    console.warn(`[标题] 英文标题疑似 AI 报错文字，已丢弃: ${englishTitle.slice(0, 40)}...`);
    englishTitle = '';
  }

  return { japaneseTitle, englishTitle };
}

/**
 * 检测日文标题是否为 AI 异常输出。返回命中的异常类型字符串，干净标题返回 ''。
 * 覆盖三类真实事故（2026-10-14）：报错文字直填、凑字数重复堆词、乱码/无意义拉丁串。
 */
function isSuspiciousJapaneseTitle(title) {
  if (!title) return '';
  if (/エラー|無効|入力された|確認できません|できませんでした|不適切|適化不可/.test(title)) {
    return '报错文字';
  }
  if (/[A-Za-z]{6,}/.test(title)) return '可疑拉丁串';
  if (/(UUID|API|JSON|Token|Error)/i.test(title)) return '技术词';
  if (/[A-Za-z]+\d{3,}/.test(title)) return '乱码后缀';
  // 重复填充：≥10 字符片段出现 2 次，或 3-9 字符片段出现 ≥4 次（あったか 等正常复现 ≤3 次不受影响）
  for (let len = 3; len <= Math.min(12, Math.floor(title.length / 2)); len++) {
    const min = len >= 10 ? 2 : 4;
    for (let i = 0; i + len * min <= title.length; i++) {
      const seg = title.slice(i, i + len);
      if (title.split(seg).length - 1 >= min) return `重复填充(${seg.slice(0, 8)})`;
    }
  }
  return '';
}

function sanitizeJapaneseTitle(title) {
  const cleaned = String(title || "")
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\s]/g, "")
    .replace(/[「」『』""''，。！？、；：￥（）【】《》—…·\s]/g, "");
  const chars = Array.from(cleaned);
  if (chars.length < 120) {
    console.warn("[标题] 日文标题仅 " + chars.length + " 字符，不足 120");
  }
  return chars.slice(0, 175).join("");
}

function sanitizeEnglishTitle(title) {
  const cleaned = String(title || '')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, ' ')
    .replace(/[""'']|，|。|！|？|、|；|：|￥|（|）|【|】|《|》|—|…|·/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 170).join('').trim();
}

function normalizeAnalysis(parsed, requiredAttributes) {
  const rawAttributes = Array.isArray(parsed) ? parsed : parsed.attributes || [];
  const byName = new Map();
  for (const item of rawAttributes) {
    if (!item || !item.name) continue;
    byName.set(String(item.name).trim(), item);
  }

  return {
    attributes: requiredAttributes.map((attr) => {
      const item = byName.get(attr.name) || findLooseName(attr.name, rawAttributes) || {};
      return {
        name: attr.name,
        value: item.value === undefined ? null : item.value,
        confidence: Number(item.confidence || 0),
        reason: item.reason || (item.need_manual ? 'AI 无法判断' : ''),
        need_manual: Boolean(item.need_manual || item.value === null || item.value === undefined)
      };
    })
  };
}

function findLooseName(name, rawAttributes) {
  return rawAttributes.find((item) => item && item.name && String(item.name).includes(name));
}

function failedAnalysis(requiredAttributes, error) {
  return {
    attributes: requiredAttributes.map((attr) => ({
      name: attr.name,
      value: null,
      confidence: 0,
      reason: `AI 分析失败: ${error.message}`,
      need_manual: true
    }))
  };
}

async function analyzeSaveError(errorMessage, productInfo) {
  const apiKeyEnv = resolveApiKeyEnv();
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) return { fields: [], corrections: [] };

  const client = createAIClient();

  const payload = {
    errorMessage,
    productTitle: productInfo.title || '',
    productCategory: productInfo.categoryName || ''
  };

  const userText = `商品保存时遇到以下错误，请分析错误信息，指出哪些字段有问题，并建议修正值。\n\n错误信息：${errorMessage}\n产品原标题：${productInfo.title || ''}\n产品类别：${productInfo.categoryName || ''}\n\n注意：\n- 产品标题（产品标题/商品标题）必须是纯日文（175字符以内，无标点无空格；低于150不是错误，严禁凑字）\n- 英文标题必须是纯英文（ASCII字符），不能包含日文、中文或其他非英文字符\n- 如果错误提到"英文标题含有其他语言"，说明英文标题字段混入了日文/中文，需要翻译为纯英文\n- 如果错误提到"产品标题"相关问题，检查是否超过175字符或含标点，不要为了凑长度添加无意义内容\n\n只返回JSON，格式: { "corrections": [{ "fieldName": "字段名（如：英文标题、产品标题）", "suggestedValue": "修正后的值", "reason": "修正理由" }] }`;

  try {
    const content = await client.completeText({
      system: '你是跨境电商日本站商品编辑助手，熟悉妙手ERP平台的字段校验规则。根据保存失败的错误信息，分析哪些字段不合规，并给出修正值。只返回严格JSON。',
      userText
    });
    const parsed = extractJSON(content);
    const corrections = parsed.corrections || [];
    const fields = corrections.map((c) => c.fieldName || c.name || c.field || '').filter(Boolean);
    return { fields, corrections };
  } catch (error) {
    console.warn(`[AI] 保存错误分析失败: ${error.message}`);
    return { fields: [], corrections: [] };
  }
}

function defaultAnalysisPrompt() {
  return '你是跨境电商商品属性分析助手。对于 select 和 multi_select 类型字段，只能从 options 中选择。返回严格 JSON，不要 Markdown。无法判断时 value 填 null，need_manual 填 true。';
}

function defaultSecondChoicePrompt() {
  return '你只能从 available_options 中选择一个最合适的页面选项，返回严格 JSON。';
}

function defaultTitleRewritePrompt() {
  return [
    '你是一位跨境电商日本市场SEO优化专家，专精于日本电商市场（亚马逊日本站、乐天、雅虎购物）的产品Listing优化。',
    '你擅长根据日本消费者的搜索心理和算法机制编写高曝光标题，精通日语SEO关键词挖掘、跨语言本地化翻译、电商搜索算法优化。',
    '',
    '核心原则：',
    '1. 搜索优先：标题内容必须以提升搜索排名（SEO）为核心目标，优先植入高流量热词。',
    '2. 原意保留：扩写必须基于原产品的核心功能和属性，不得凭空捏造不存在的功能。',
    '3. 格式规范：严格遵守无标点符号的要求，日文标题仅使用汉字、假名、英文字母及数字，纯字符串无空格。',
    '4. 词汇丰富：使用同义词替换重复词汇，增加标题覆盖的搜索词面。',
    '5. 逻辑连贯：即使没有标点，通过词语组合也要让标题在阅读时逻辑清晰，符合日语语法结构。',
    '',
    '执行流程：',
    '步骤1：分析输入的产品原始标题，提取核心关键词、属性词、用途及适用人群。',
    '步骤2：结合日本电商搜索热词，对标题进行扩写。按关键词权重排序（核心词前置，长尾词后置），调整语序以符合日本搜索习惯。',
    '步骤3：扩写后的日文标题上限175字符，超出必须删减，并移除所有标点符号和空格。素材不足时自然收尾，没有达到150也没关系，严禁凑字数。',
    '步骤4：将优化好的日文标题翻译成地道、符合跨境电商通用的英文标题。',
    '步骤5：按JSON格式输出最终结果。',
    '',
    '硬性要求：',
    '- japaneseTitle必须是175字符以内的纯字符串（低于150完全允许），严禁任何标点符号和空格，严禁重复堆词或无意义词汇凑长度',
    '- 如果源标题是日语先翻译成中文理解再扩写',
    '- 不包含换行符emoji品牌名或虚假宣传',
    '- 只返回严格JSON，包含japaneseTitle、englishTitle两个字段'
  ].join('\n');
}

module.exports = {
  analyzeAttributes,
  analyzeSaveError,
  secondChoice,
  secondChoiceBatch,
  rewriteProductTitles,
  startTitleGeneration,
  extractJSON,
  createAIClient,
  createFastAIClient,
  sanitizeTitleCompliance,
  isSuspiciousJapaneseTitle
};
