const { loadConfig, readJSONSync, resolveRoot } = require('./utils');

function getPromptTemplates() {
  return readJSONSync(resolveRoot('config', 'prompt_templates.json'), {});
}

async function analyzeAttributes(productInfo, requiredAttributes, knowledgeContext = null) {
  const config = loadConfig();
  const templates = getPromptTemplates();
  const apiKey = process.env[config.ai.apiKeyEnv || 'ZAI_API_KEY'];

  if (!apiKey) {
    return {
      attributes: requiredAttributes.map((attr) => ({
        name: attr.name,
        value: null,
        confidence: 0,
        reason: `缺少环境变量 ${config.ai.apiKeyEnv || 'ZAI_API_KEY'}`,
        need_manual: true
      }))
    };
  }

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
  const requestImages = config.ai.sendImages === false ? [] : (productInfo.images || []);
  const messagesWithImages = [
    { role: 'system', content: templates.attributeAnalysisSystem || defaultAnalysisPrompt() },
    { role: 'user', content: buildVisionContent(userText, requestImages) }
  ];

  try {
    const content = await postChatCompletion(config, apiKey, messagesWithImages);
    return normalizeAnalysis(extractJSON(content), requiredAttributes);
  } catch (error) {
    if (requestImages.length) {
      console.warn(`[AI] 图片请求失败，改用纯文本重试: ${error.message}`);
      const textOnlyMessages = [
        { role: 'system', content: templates.attributeAnalysisSystem || defaultAnalysisPrompt() },
        { role: 'user', content: userText }
      ];
      try {
        const content = await postChatCompletion(config, apiKey, textOnlyMessages);
        return normalizeAnalysis(extractJSON(content), requiredAttributes);
      } catch (retryError) {
        return failedAnalysis(requiredAttributes, retryError);
      }
    }
    return failedAnalysis(requiredAttributes, error);
  }
}

async function secondChoice(input) {
  const config = loadConfig();
  const templates = getPromptTemplates();
  const apiKey = process.env[config.ai.apiKeyEnv || 'ZAI_API_KEY'];
  if (!apiKey) return null;

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
  const requestImages = config.ai.sendImages === false ? [] : (payload.images || []);
  const messages = [
    { role: 'system', content: templates.secondChoiceSystem || defaultSecondChoicePrompt() },
    { role: 'user', content: buildVisionContent(userText, requestImages) }
  ];

  try {
    const content = await postChatCompletion(config, apiKey, messages);
    const parsed = extractJSON(content);
    return {
      selected_option: parsed.selected_option || parsed.value || null,
      confidence: Number(parsed.confidence || 0),
      reason: parsed.reason || 'AI 二次选择'
    };
  } catch (error) {
    if (requestImages.length) {
      try {
        const content = await postChatCompletion(config, apiKey, [
          { role: 'system', content: templates.secondChoiceSystem || defaultSecondChoicePrompt() },
          { role: 'user', content: userText }
        ]);
        const parsed = extractJSON(content);
        return {
          selected_option: parsed.selected_option || parsed.value || null,
          confidence: Number(parsed.confidence || 0),
          reason: parsed.reason || 'AI 二次选择'
        };
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

async function rewriteProductTitles(productInfo) {
  const config = loadConfig();
  const templates = getPromptTemplates();
  const apiKey = process.env[config.ai.apiKeyEnv || 'ZAI_API_KEY'];
  if (!apiKey) {
    throw new Error(`缺少环境变量 ${config.ai.apiKeyEnv || 'ZAI_API_KEY'}`);
  }

  const requestImages = config.ai.sendImages === false ? [] : (productInfo.images || []);
  const systemPrompt = templates.titleRewriteSystem || defaultTitleRewritePrompt();

  // 第一步：分析原始标题并扩写为丰富的中文/日文关键词描述
  const expandPayload = {
    sourceTitle: productInfo.title || '',
    task: '分析产品标题，提取核心关键词并扩写为丰富的描述性文本，用于后续生成电商标题',
    requirements: [
      '提取产品的核心功能、材质、适用场景、目标人群、使用效果、产品卖点',
      '补充同义词、近义词、相关搜索热词以增加覆盖面',
      '用中文和日文分别列出所有扩写关键词和描述短语',
      '不得凭空捏造不存在的功能，必须基于原产品核心属性',
      '尽量多列关键词，宁多勿少'
    ],
    outputFormat: {
      coreKeywords: '核心关键词列表',
      expandedChineseText: '用中文扩写的丰富描述文本（至少200字）',
      expandedJapaneseKeywords: '日文关键词和短语的拼接（至少200字符）'
    }
  };

  const expandText = `请分析产品标题并扩写关键词，只返回JSON。\n${JSON.stringify(expandPayload, null, 2)}`;
  const expandMessages = [
    { role: 'system', content: '你是一位跨境电商日本市场SEO优化专家，专精于日本电商产品关键词挖掘和扩写。' },
    { role: 'user', content: buildVisionContent(expandText, requestImages) }
  ];

  let expandedContext = '';
  try {
    const expandContent = await postChatCompletion(config, apiKey, expandMessages);
    const expandResult = extractJSON(expandContent);
    expandedContext = [
      expandResult.expandedChineseText || '',
      expandResult.expandedJapaneseKeywords || '',
      (expandResult.coreKeywords || []).join(' ')
    ].filter(Boolean).join('\n');
    console.log(`[标题] 第一步扩写完成，扩写内容 ${expandedContext.length} 字符`);
  } catch (error) {
    console.warn(`[标题] 第一步扩写失败: ${error.message}，直接用原始标题`);
  }

  // 第二步：基于扩写结果生成最终的 150-175 字符日文标题
  const generatePayload = {
    sourceTitle: productInfo.title || '',
    expandedContext: expandedContext || '（无扩写内容，请基于源标题自行扩写）',
    task: '基于上面的原始标题和扩写关键词，生成符合日本电商SEO的日文标题和英文标题',
    rules: [
      'japaneseTitle必须严格控制在150到175个字符之间',
      'japaneseTitle严禁出现任何标点符号包括逗号句号空格括号等视为纯字符串',
      '将扩写关键词按权重排序核心词前置长尾词后置语序符合日本搜索习惯',
      'englishTitle为对应的地道英文翻译',
      '使用同义词替换重复词汇增加搜索覆盖面',
      '如果关键词素材不够150字符，继续补充适用场景目标人群材质特征等描述'
    ],
    outputFormat: {
      expandedChineseTitle: '用于扩写的中文标题',
      japaneseTitle: '无标点150到175字符的纯字符串日文标题',
      englishTitle: 'English title'
    }
  };

  const generateText = `请基于扩写素材生成最终标题，只返回JSON。\n${JSON.stringify(generatePayload, null, 2)}`;
  const generateMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildVisionContent(generateText, requestImages) }
  ];

  try {
    const content = await postChatCompletion(config, apiKey, generateMessages);
    const titles = normalizeTitles(extractJSON(content));
    if (titles.japaneseTitle.length < 150) {
      console.warn(`[标题] 日文标题 ${titles.japaneseTitle.length} 字符，不足 150`);
    } else {
      console.log(`[标题] 第二步生成完成: ${titles.japaneseTitle.length} 字符`);
    }
    return titles;
  } catch (error) {
    // 如果带图片失败，去掉图片重试
    if (requestImages.length) {
      try {
        const content = await postChatCompletion(config, apiKey, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: generateText }
        ]);
        return normalizeTitles(extractJSON(content));
      } catch (_) {}
    }
    throw error;
  }
}

function splitSystemMessage(messages) {
  const systemParts = [];
  const remaining = [];
  for (const msg of messages) {
    if (msg && msg.role === 'system') {
      const c = msg.content;
      systemParts.push(typeof c === 'string' ? c : JSON.stringify(c));
    } else {
      remaining.push(msg);
    }
  }
  return { system: systemParts.join('\n\n').trim(), remaining };
}

async function postChatCompletion(config, apiKey, messages) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 没有 fetch，请使用 Node.js 18 或更高版本');
  }

  const endpoint = `${String(config.ai.baseURL || '').replace(/\/$/, '')}/v1/messages`;
  const { system, remaining } = splitSystemMessage(messages);

  const body = {
    model: config.ai.model,
    messages: remaining,
    max_tokens: Number(config.ai.maxTokens) || 4096,
    temperature: 0.1
  };
  if (system) body.system = system;

  return requestCompletion(endpoint, apiKey, body);
}

function normalizeTitles(parsed) {
  return {
    japaneseTitle: sanitizeJapaneseTitle(parsed.japaneseTitle || parsed.japanesetitle || parsed['日文标题'] || parsed.productTitle || parsed.title || ''),
    englishTitle: sanitizeEnglishTitle(parsed.englishTitle || parsed.englishtitle || parsed['英文标题'] || parsed.enTitle || parsed.english || '')
  };
}

function sanitizeJapaneseTitle(title) {
  const cleaned = String(title || "")
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\s]/g, "")
    .replace(/[「」『』""''，。！？、；：￥（）【】《》—…·\s]/g, "");
  const chars = Array.from(cleaned);
  if (chars.length < 150) {
    console.warn("[标题] 日文标题仅 " + chars.length + " 字符，不足 150");
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

async function requestCompletion(endpoint, apiKey, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI 请求失败 ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text);
  const blocks = Array.isArray(json.content) ? json.content : [];
  const content = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!content) throw new Error(`AI 响应为空: ${text.slice(0, 300)}`);
  return content;
}

function buildVisionContent(text, images) {
  const validImages = (images || []).filter(Boolean).slice(0, 3);
  if (!validImages.length) return text;
  return [
    { type: 'text', text },
    ...validImages.map((url) => ({
      type: 'image',
      source: { type: 'url', url }
    }))
  ];
}

function extractJSON(content) {
  const raw = String(content || '').trim();
  const withoutFence = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch (_) {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error(`AI 返回不是可解析 JSON: ${raw.slice(0, 300)}`);
  }
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
  const config = loadConfig();
  const apiKey = process.env[config.ai.apiKeyEnv || 'ZAI_API_KEY'];
  if (!apiKey) return { fields: [], corrections: [] };

  const payload = {
    errorMessage,
    productTitle: productInfo.title || '',
    productCategory: productInfo.categoryName || ''
  };

  const userText = `商品保存时遇到以下错误，请分析错误信息，指出哪些字段有问题，并建议修正值。\n\n${JSON.stringify(payload, null, 2)}\n\n只返回JSON，格式: { "corrections": [{ "fieldName": "字段名", "suggestedValue": "建议值", "reason": "理由" }] }`;

  const messages = [
    { role: 'system', content: '你是跨境电商商品编辑助手。根据保存失败的错误信息分析需要修正的字段，并建议修正值。只返回严格JSON。' },
    { role: 'user', content: userText }
  ];

  try {
    const content = await postChatCompletion(config, apiKey, messages);
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
    '步骤3：严格控制字符数，将扩写后的日文标题删减或补充至150-175字符区间，并移除所有标点符号和空格。',
    '步骤4：将优化好的日文标题翻译成地道、符合跨境电商通用的英文标题。',
    '步骤5：按JSON格式输出最终结果。',
    '',
    '硬性要求：',
    '- japaneseTitle必须是150到175个字符的纯字符串，严禁任何标点符号和空格',
    '- 如果源标题是日语先翻译成中文理解再扩写',
    '- 不包含换行符emoji品牌名或虚假宣传',
    '- 只返回严格JSON，包含expandedChineseTitle、japaneseTitle、englishTitle三个字段'
  ].join('\n');
}

module.exports = {
  analyzeAttributes,
  analyzeSaveError,
  secondChoice,
  rewriteProductTitles,
  extractJSON
};
