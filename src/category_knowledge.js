const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { resolveRoot, unique } = require('./utils');

const DEFAULT_PATH = resolveRoot('storage', 'category_attribute_knowledge.json');

class CategoryKnowledge {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.filePath = resolveKnowledgePath(options.path);
    this.maxSamplesPerAttribute = Number(options.maxSamplesPerAttribute || 20);
    this.maxTitlesPerCategory = Number(options.maxTitlesPerCategory || 5);
    this.data = {
      version: 1,
      updatedAt: '',
      categories: {}
    };
    this.dirty = false;
  }

  static fromConfig(config = {}) {
    return new CategoryKnowledge(config.knowledgeBase || {});
  }

  async load() {
    if (!this.enabled) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
      this.data = {
        version: 1,
        updatedAt: '',
        categories: {},
        ...parsed,
        categories: parsed.categories || {}
      };
    } catch (error) {
      console.warn(`[Knowledge] Failed to read category knowledge: ${error.message}`);
    }
  }

  async save() {
    if (!this.enabled || !this.dirty) return;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.data.updatedAt = new Date().toISOString();
    await fsp.writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    this.dirty = false;
    console.log(`[Knowledge] Saved category knowledge: ${this.filePath}`);
  }

  getReference(categoryName, attributes = []) {
    if (!this.enabled || !categoryName) return null;
    const entry = this.findEntry(categoryName);
    if (!entry) return null;

    const requested = new Set(attributes.map((attr) => normalizeKey(attr.name)));
    const knownAttributes = (entry.attributes || [])
      .filter((attr) => !requested.size || requested.has(normalizeKey(attr.name)))
      .map((attr) => ({
        name: attr.name,
        controlType: attr.controlType,
        options: attr.options || [],
        commonValues: topValues(attr.values || {}, 8)
      }));

    if (!knownAttributes.length) return null;
    return {
      categoryName: entry.categoryName,
      timesSeen: entry.timesSeen || 0,
      lastSeenAt: entry.lastSeenAt || '',
      knownAttributes,
      note: 'Use this local history only as a reference. Page options still have priority.'
    };
  }

  recordCategoryAttributes(categoryName, attributes = [], productInfo = {}) {
    if (!this.enabled || !categoryName || !attributes.length) return null;
    const now = new Date().toISOString();
    const entry = this.ensureEntry(categoryName, productInfo, now, true);
    const attrMap = new Map((entry.attributes || []).map((attr) => [normalizeKey(attr.name), attr]));

    for (const source of attributes) {
      if (!source || !source.name) continue;
      const key = normalizeKey(source.name);
      let target = attrMap.get(key);
      if (!target) {
        target = {
          name: source.name,
          controlType: source.controlType || 'unknown',
          required: source.required !== false,
          options: [],
          values: {},
          firstSeenAt: now,
          lastSeenAt: now,
          timesSeen: 0
        };
        entry.attributes.push(target);
        attrMap.set(key, target);
      }
      target.controlType = source.controlType || target.controlType;
      target.required = source.required !== false;
      target.options = unique([...(target.options || []), ...((source.options || []).map(String))]).slice(0, 120);
      target.lastSeenAt = now;
      target.timesSeen = Number(target.timesSeen || 0) + 1;
    }

    entry.attributes.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    this.dirty = true;
    return entry;
  }

  recordFillResult(categoryName, attribute, finalValue, productInfo = {}) {
    if (!this.enabled || !categoryName || !attribute || !attribute.name || !finalValue) return;
    const now = new Date().toISOString();
    const entry = this.ensureEntry(categoryName, productInfo, now, false);
    let attr = (entry.attributes || []).find((item) => normalizeKey(item.name) === normalizeKey(attribute.name));
    if (!attr) {
      attr = {
        name: attribute.name,
        controlType: attribute.controlType || 'unknown',
        required: attribute.required !== false,
        options: attribute.options || [],
        values: {},
        firstSeenAt: now,
        lastSeenAt: now,
        timesSeen: 0
      };
      entry.attributes.push(attr);
    }

    for (const value of asValues(finalValue)) {
      const text = String(value || '').trim();
      if (!text) continue;
      const key = normalizeKey(text);
      attr.values[key] = {
        value: text,
        count: Number(attr.values[key] && attr.values[key].count || 0) + 1,
        lastUsedAt: now,
        sampleTitle: productInfo.title || ''
      };
    }

    trimValues(attr.values, this.maxSamplesPerAttribute);
    attr.lastSeenAt = now;
    this.dirty = true;
  }

  findEntry(categoryName) {
    const key = normalizeKey(categoryName);
    return this.data.categories[key] || null;
  }

  ensureEntry(categoryName, productInfo, now, countSeen = false) {
    const key = normalizeKey(categoryName);
    if (!this.data.categories[key]) {
      this.data.categories[key] = {
        categoryName,
        key,
        firstSeenAt: now,
        lastSeenAt: now,
        timesSeen: 0,
        sampleTitles: [],
        attributes: []
      };
    }

    const entry = this.data.categories[key];
    entry.categoryName = entry.categoryName || categoryName;
    entry.lastSeenAt = now;
    if (countSeen) {
      entry.timesSeen = Number(entry.timesSeen || 0) + 1;
    } else {
      entry.timesSeen = Number(entry.timesSeen || 0);
    }
    if (productInfo.title) {
      entry.sampleTitles = unique([productInfo.title, ...(entry.sampleTitles || [])]).slice(0, this.maxTitlesPerCategory);
    }
    return entry;
  }
}

async function readCurrentCategory(page) {
  const candidates = await page.evaluate(() => {
    const result = [];
    const seen = new Set();

    function textOf(node) {
      return (node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function add(text, score, source) {
      const cleaned = cleanCandidate(text);
      if (!cleaned) return;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ name: cleaned, score, source });
    }

    function isCategoryLabel(text) {
      return /(\u5546\u54c1|\u4ea7\u54c1)?(\u7c7b\u76ee|\u7c7b\u522b|\u5206\u7c7b)|category/i.test(text || '');
    }

    function isModuleLabel(text) {
      return /(\u7c7b\u522b|\u7c7b\u76ee|\u5206\u7c7b)&?\s*\u5c5e\u6027|\u5546\u54c1\u5c5e\u6027|\u4ea7\u54c1\u5c5e\u6027/i.test(text || '');
    }

    function cleanCandidate(text) {
      const original = String(text || '').replace(/\s+/g, ' ').trim();
      if (/^(\u7c7b\u522b|\u7c7b\u76ee|\u5206\u7c7b)&?\s*\u5c5e\u6027/i.test(original)) return '';
      let value = original
        .replace(/\s+/g, ' ')
        .replace(/^.*?(\u5546\u54c1|\u4ea7\u54c1)?(\u7c7b\u76ee|\u7c7b\u522b|\u5206\u7c7b)\s*[:\uff1a]?\s*/i, '')
        .replace(/(\u7f16\u8f91|\u66f4\u6539|\u4fee\u6539|\u9009\u62e9|\u8bf7\u9009\u62e9).*$/i, '')
        .trim();

      value = value
        .replace(/\s*>\s*/g, ' > ')
        .replace(/\s*\/\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!value || value.length < 2 || value.length > 160) return '';
      if (isModuleLabel(value)) return '';
      if (/^\*+$/.test(value)) return '';
      if (/^\u8bf7?\u9009\u62e9$|select/i.test(value)) return '';
      return value;
    }

    function compactAncestor(el) {
      let current = el;
      for (let depth = 0; current && current !== document.body && depth < 6; depth += 1) {
        const text = textOf(current);
        if (text.length <= 220 && isCategoryLabel(text)) return current;
        current = current.parentElement;
      }
      return el;
    }

    Array.from(document.querySelectorAll('label,span,div,th,td,p'))
      .filter((el) => visible(el))
      .forEach((el) => {
        const label = textOf(el);
        if (!label || label.length > 80 || !isCategoryLabel(label) || isModuleLabel(label)) return;
        const row = compactAncestor(el);
        const values = Array.from(row.querySelectorAll('input,textarea'))
          .map((input) => input.value || input.getAttribute('value') || '')
          .filter(Boolean);
        if (values.length) values.forEach((value) => add(value, 95, 'field_value'));
        add(textOf(row), 70, 'field_text');
      });

    Array.from(document.querySelectorAll(
      '.el-breadcrumb,.ant-breadcrumb,[class*="breadcrumb"],[class*="category"],[class*="cate"],[id*="category"],[id*="cate"]'
    ))
      .filter((el) => visible(el))
      .filter((el) => !/category-attr/i.test(`${el.className || ''}`))
      .forEach((el) => {
        const text = textOf(el);
        if (!text || text.length > 220) return;
        const classText = `${el.className || ''} ${el.id || ''}`;
        let score = /breadcrumb/i.test(classText) ? 90 : 65;
        if (/[>\/]/.test(text)) score += 15;
        if (isCategoryLabel(text)) score += 10;
        add(text, score, 'category_node');
      });

    return result.sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, 8);
  }).catch(() => []);

  const best = Array.isArray(candidates) ? candidates[0] : null;
  return {
    name: best ? best.name : '',
    candidates: candidates || []
  };
}

function resolveKnowledgePath(configuredPath) {
  if (!configuredPath) return DEFAULT_PATH;
  if (path.isAbsolute(configuredPath)) return configuredPath;
  return resolveRoot(configuredPath);
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\\/:*?"<>|,.;'"`~!@#$%^&()[\]{}+=_-]/g, '')
    .trim();
}

function asValues(value) {
  if (Array.isArray(value)) return value;
  return [value];
}

function topValues(values, limit) {
  return Object.values(values || {})
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, limit)
    .map((item) => ({
      value: item.value,
      count: item.count,
      lastUsedAt: item.lastUsedAt || ''
    }));
}

function trimValues(values, limit) {
  const sorted = Object.entries(values || {})
    .sort((a, b) => Number(b[1].count || 0) - Number(a[1].count || 0));
  for (const [key] of sorted.slice(limit)) delete values[key];
}

module.exports = {
  CategoryKnowledge,
  readCurrentCategory
};
