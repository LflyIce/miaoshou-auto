const { loadConfig, normalizeText, readJSONSync, resolveRoot } = require('./utils');

function levenshtein(a, b) {
  const left = Array.from(a || '');
  const right = Array.from(b || '');
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[left.length][right.length];
}

function jaccard(a, b) {
  const setA = new Set(Array.from(a || ''));
  const setB = new Set(Array.from(b || ''));
  if (!setA.size && !setB.size) return 1;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function similarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLen = Math.max(Array.from(left).length, Array.from(right).length);
  const levScore = 1 - levenshtein(left, right) / maxLen;
  const jacScore = jaccard(left, right);
  return Number((levScore * 0.55 + jacScore * 0.45).toFixed(4));
}

async function chooseBestOption({
  attrName,
  inferredValue,
  availableOptions,
  productTitle,
  images,
  aiAnalyzer
}) {
  const config = loadConfig();
  const synonyms = readJSONSync(resolveRoot('config', 'synonyms.json'), {});
  const fallbackRules = readJSONSync(resolveRoot('config', 'fallback_rules.json'), {});
  const options = (availableOptions || []).map((item) => String(item || '').trim()).filter(Boolean);
  const value = Array.isArray(inferredValue) ? String(inferredValue[0] || '') : String(inferredValue || '').trim();

  if (!options.length) {
    const fallback = chooseFallbackText(attrName, fallbackRules);
    if (fallback) {
      return ok(fallback, 'fallback_unverified', 0.35, '页面未读到选项，使用字段兜底值并在下拉中搜索');
    }
    return manual('页面没有读取到真实可选项');
  }
  if (!value) {
    return await tryFallbackOrManual({ attrName, options, fallbackRules, reason: 'AI 未给出属性值' });
  }

  const exact = options.find((option) => option.trim() === value);
  if (exact) return ok(exact, 'exact', 1, '完全匹配');

  const normalizedValue = normalizeText(value);
  const normalized = options.find((option) => normalizeText(option) === normalizedValue);
  if (normalized) return ok(normalized, 'normalized', 0.98, '标准化后完全匹配');

  const synonym = matchBySynonym(value, options, synonyms);
  if (synonym) return ok(synonym, 'synonym', 0.94, '命中同义词匹配');

  const contains = options.find((option) => normalizeText(option).includes(normalizedValue) && normalizedValue);
  if (contains) return ok(contains, 'contains', 0.9, '页面选项包含 AI 值');

  const includedBy = options.find((option) => normalizedValue.includes(normalizeText(option)) && normalizeText(option));
  if (includedBy) return ok(includedBy, 'included_by', 0.88, 'AI 值包含页面选项');

  const fuzzy = bestFuzzy(value, options);
  if (fuzzy && fuzzy.score >= Number(config.thresholds.autoSelectScore || 0.85)) {
    return ok(fuzzy.option, 'fuzzy', fuzzy.score, `模糊相似度 ${fuzzy.score}`);
  }

  if (aiAnalyzer && typeof aiAnalyzer.secondChoice === 'function') {
    const aiChoice = await aiAnalyzer.secondChoice({
      attrName,
      inferredValue: value,
      availableOptions: options,
      productTitle,
      images
    });
    const selected = aiChoice && findOption(aiChoice.selected_option, options);
    const confidence = Number(aiChoice && aiChoice.confidence || 0);
    if (selected && confidence >= Number(config.thresholds.aiSecondChoiceScore || 0.7)) {
      return ok(selected, 'ai_second_choice', confidence, aiChoice.reason || 'AI 二次选择');
    }
  }

  return tryFallbackOrManual({
    attrName,
    options,
    fallbackRules,
    reason: fuzzy ? `最佳模糊匹配 ${fuzzy.option} 分数 ${fuzzy.score}，低于自动阈值` : '没有可用匹配'
  });
}

function matchBySynonym(value, options, synonyms) {
  const normalizedValue = normalizeText(value);
  for (const [key, words] of Object.entries(synonyms || {})) {
    const allWords = [key, ...(words || [])];
    const normalizedWords = allWords.map(normalizeText);
    const valueInGroup = normalizedWords.includes(normalizedValue);
    if (!valueInGroup) continue;
    const option = options.find((item) => normalizedWords.includes(normalizeText(item)));
    if (option) return option;
  }

  for (const option of options) {
    const normalizedOption = normalizeText(option);
    for (const [key, words] of Object.entries(synonyms || {})) {
      const normalizedKey = normalizeText(key);
      const normalizedWords = (words || []).map(normalizeText);
      if (normalizedOption === normalizedKey && normalizedWords.includes(normalizedValue)) return option;
      if (normalizedValue === normalizedKey && normalizedWords.includes(normalizedOption)) return option;
    }
  }
  return null;
}

function bestFuzzy(value, options) {
  const scored = options.map((option) => ({
    option,
    score: similarity(value, option)
  })).sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function findOption(value, options) {
  if (!value) return null;
  const exact = options.find((option) => option === value);
  if (exact) return exact;
  const normalizedValue = normalizeText(value);
  return options.find((option) => normalizeText(option) === normalizedValue) || null;
}

async function tryFallbackOrManual({ attrName, options, fallbackRules, reason }) {
  const fallback = chooseFallback(attrName, options, fallbackRules);
  if (fallback) return ok(fallback.value, 'fallback', fallback.confidence, fallback.reason);
  const neutral = chooseNeutralOption(options);
  if (neutral) {
    return ok(neutral, 'neutral_fallback', 0.45, `${reason || 'AI 无法判断'}，已选择页面中较中肯的可用项`);
  }
  return manual(reason || '需要人工处理');
}

function chooseFallback(attrName, options, fallbackRules) {
  const byAttribute = fallbackRules.byAttribute || {};
  const entries = Object.entries(byAttribute)
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  for (const [name, values] of entries) {
    if (matchesFallbackAttribute(attrName, name)) {
      const matched = matchFallbackValue(values, options);
      if (matched) {
        return {
          value: matched,
          confidence: 0.72,
          reason: `命中字段兜底规则 ${name}`
        };
      }
    }
  }

  const globalMatched = matchFallbackValue(fallbackRules.global || [], options);
  if (globalMatched) {
    return {
      value: globalMatched,
      confidence: 0.65,
      reason: '命中全局兜底规则'
    };
  }
  return null;
}

function chooseFallbackText(attrName, fallbackRules) {
  const byAttribute = fallbackRules.byAttribute || {};
  const entries = Object.entries(byAttribute)
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  for (const [name, values] of entries) {
    if (matchesFallbackAttribute(attrName, name)) {
      const value = (values || []).map((item) => String(item || '').trim()).find(Boolean);
      if (value) return value;
    }
  }
  return (fallbackRules.global || []).map((item) => String(item || '').trim()).find(Boolean) || '';
}

function matchesFallbackAttribute(attrName, ruleName) {
  const attr = String(attrName || '').trim();
  const rule = String(ruleName || '').trim();
  if (!attr || !rule) return false;
  if (attr === rule) return true;
  return attr.includes(rule);
}

function chooseNeutralOption(options) {
  const neutralWords = [
    '不适用',
    '无需',
    '无',
    '否',
    '其他',
    '其它',
    '通用',
    '默认',
    '普通',
    '标准',
    '未分类',
    '无品牌'
  ];
  const matched = matchFallbackValue(neutralWords, options);
  if (matched) return matched;
  return (options || []).find((option) => normalizeText(option)) || null;
}

function matchFallbackValue(values, options) {
  for (const value of values || []) {
    const exact = options.find((option) => option === value);
    if (exact) return exact;
    const normalizedValue = normalizeText(value);
    const normalized = options.find((option) => normalizeText(option) === normalizedValue);
    if (normalized) return normalized;
    const contains = options.find((option) => normalizeText(option).includes(normalizedValue) && normalizedValue);
    if (contains) return contains;
  }
  return null;
}

function ok(value, method, confidence, reason) {
  return { value, method, confidence, reason };
}

function manual(reason) {
  return { value: null, method: 'manual_required', confidence: 0, reason };
}

module.exports = {
  chooseBestOption,
  normalizeText,
  similarity
};
