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

  const payload = {
    sourceTitle: productInfo.title || '',
    images: productInfo.images || [],
    requirements: [
      'First identify the source title language',
      'If the source title is Japanese translate it into Chinese first',
      'Use Chinese as the working language to expand and rewrite the product title based on Japanese marketplace search habits and search keywords',
      'The expanded Chinese working title should include product core terms usage scenarios material structure selling points and common synonym search terms',
      'Translate the expanded Chinese working title into Japanese for japaneseTitle',
      'Translate the expanded Chinese working title into English for englishTitle',
      'japaneseTitle must be 150 to 170 characters',
      'englishTitle must be 150 to 170 characters',
      'Do not include any punctuation in either final title',
      'Do not include line breaks emoji brand names or unsupported claims'
    ],
    outputFormat: {
      expandedChineseTitle: '用于扩写的中文标题',
      japaneseTitle: '日语标题',
      englishTitle: 'English title'
    }
  };

  const userText = `Generate optimized marketplace titles using this exact workflow and return JSON only.\n${JSON.stringify(payload, null, 2)}`;
  const requestImages = config.ai.sendImages === false ? [] : (productInfo.images || []);
  const messagesWithImages = [
    { role: 'system', content: templates.titleRewriteSystem || defaultTitleRewritePrompt() },
    { role: 'user', content: buildVisionContent(userText, requestImages) }
  ];

  try {
    const content = await postChatCompletion(config, apiKey, messagesWithImages);
    return normalizeTitles(extractJSON(content));
  } catch (error) {
    if (requestImages.length) {
      const content = await postChatCompletion(config, apiKey, [
        { role: 'system', content: templates.titleRewriteSystem || defaultTitleRewritePrompt() },
        { role: 'user', content: userText }
      ]);
      return normalizeTitles(extractJSON(content));
    }
    throw error;
  }
}

async function postChatCompletion(config, apiKey, messages) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 没有 fetch，请使用 Node.js 18 或更高版本');
  }

  const endpoint = `${String(config.ai.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  const baseBody = {
    model: config.ai.model,
    messages,
    temperature: 0.1
  };

  try {
    return await requestCompletion(endpoint, apiKey, {
      ...baseBody,
      response_format: { type: 'json_object' }
    });
  } catch (error) {
    if (/response_format|json_object|400|unsupported/i.test(error.message)) {
      return requestCompletion(endpoint, apiKey, baseBody);
    }
    throw error;
  }
}

function normalizeTitles(parsed) {
  return {
    japaneseTitle: sanitizeTitle(parsed.japaneseTitle || parsed.productTitle || parsed.title || ''),
    englishTitle: sanitizeTitle(parsed.englishTitle || parsed.enTitle || parsed.english || '')
  };
}

function sanitizeTitle(title) {
  const cleaned = String(title || '')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, ' ')
    .replace(/[，。！？、；：￥（）【】《》“”‘’—…·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 170).join('').trim();
}

async function requestCompletion(endpoint, apiKey, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI 请求失败 ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text);
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('AI 响应为空');
  return content;
}

function buildVisionContent(text, images) {
  const validImages = (images || []).filter(Boolean).slice(0, 3);
  if (!validImages.length) return text;
  return [
    { type: 'text', text },
    ...validImages.map((url) => ({
      type: 'image_url',
      image_url: { url }
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

function defaultAnalysisPrompt() {
  return '你是跨境电商商品属性分析助手。对于 select 和 multi_select 类型字段，只能从 options 中选择。返回严格 JSON，不要 Markdown。无法判断时 value 填 null，need_manual 填 true。';
}

function defaultSecondChoicePrompt() {
  return '你只能从 available_options 中选择一个最合适的页面选项，返回严格 JSON。';
}

function defaultTitleRewritePrompt() {
  return 'You are a Japanese cross border ecommerce title optimization assistant. Always use this workflow source title language detection then Chinese working rewrite then Japanese and English translation. If the source title is already Japanese translate it into Chinese first then expand and rewrite in Chinese according to Japanese marketplace search habits and keywords then translate into Japanese and English. Final japaneseTitle and englishTitle must be 150 to 170 characters and contain no punctuation no line breaks no emoji no invented brand names and no unsupported claims. Return strict JSON only with expandedChineseTitle japaneseTitle and englishTitle.';
}

module.exports = {
  analyzeAttributes,
  secondChoice,
  rewriteProductTitles,
  extractJSON
};
