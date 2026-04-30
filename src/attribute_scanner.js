const { cleanAttributeName, normalizeText, sleep, unique } = require('./utils');

const OPTION_SELECTORS = [
  '.el-select-dropdown .el-select-dropdown__item',
  '.el-popper .el-select-dropdown__item',
  '.ant-select-dropdown .ant-select-item-option',
  '.ant-select-dropdown [role="option"]',
  '[role="listbox"] [role="option"]',
  '.select-dropdown [role="option"]',
  '.dropdown-menu li'
];

async function scanRequiredAttributes(page) {
  const rows = await page.evaluate(() => {
    const root = findCategoryAttributeRoot();
    if (!root) return [];

    const candidates = collectRows(root);
    const result = [];
    const seen = new Set();

    candidates.forEach((row, index) => {
      if (!isRequiredRow(row)) return;
      if (!hasEditableControl(row)) return;

      const name = extractName(row);
      if (!name || shouldIgnoreName(name, row)) return;

      const controlType = detectControlType(row);
      const alreadyFilled = detectAlreadyFilled(row, controlType);
      if (alreadyFilled) return;

      const key = `${name}::${controlType}`;
      if (seen.has(key)) return;
      seen.add(key);

      const rowId = `ms-attr-${Date.now()}-${index}`;
      row.setAttribute('data-ms-attr-row', rowId);
      result.push({
        name,
        required: true,
        controlType,
        options: [],
        alreadyFilled,
        _rowId: rowId,
        _rowSelector: `[data-ms-attr-row="${rowId}"]`
      });
    });

    return result;

    function textOf(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalizedText(el) {
      return textOf(el).replace(/\s+/g, '').replace(/＆/g, '&').toLowerCase();
    }

    function isTargetSectionText(text) {
      return /类别&属性|类目&属性|分类&属性|类别属性|类目属性|商品属性|产品属性/.test(text);
    }

    function findCategoryAttributeRoot() {
      const customRoot = findCustomAttributeRoot();
      if (customRoot) return customRoot;

      const titleNodes = Array.from(document.querySelectorAll(
        'h1,h2,h3,h4,h5,label,span,div,.title,[class*="title"],[class*="header"],.el-card__header,.ant-card-head-title,.el-collapse-item__header,.ant-collapse-header'
      )).filter((el) => visible(el) && isTargetSectionText(normalizedText(el)));

      const scored = [];
      for (const title of titleNodes) {
        let current = title;
        let depth = 0;
        while (current && current !== document.body && depth < 10) {
          const text = normalizedText(current);
          const controls = current.querySelectorAll(
            '.el-form-item,.ant-form-item,input,textarea,select,.el-select,.ant-select,[role="combobox"],[class*="select"],[class*="dropdown"]'
          ).length;
          const rows = current.querySelectorAll('.el-form-item,.ant-form-item,[class*="form-item"],tr').length;
          if (controls > 0 && rows > 0) {
            let score = 0;
            if (/类别&属性|类目&属性|分类&属性|类别属性|类目属性/.test(text)) score += 80;
            if (/商品属性|产品属性/.test(text)) score += 45;
            score += Math.min(controls, 30);
            score += Math.min(rows, 30);
            score -= Math.floor(text.length / 600);
            if (/发货仓库|运费模板|产品素材图|图片翻译|图片编辑|保存当前配置|模板管理/.test(text)) score -= 25;
            scored.push({ el: current, score, length: text.length });
          }
          current = current.parentElement;
          depth += 1;
        }
      }

      scored.sort((a, b) => b.score - a.score || a.length - b.length);
      if (scored[0]) return scored[0].el;

      const forms = Array.from(document.querySelectorAll('.el-form,.ant-form,form,section,.el-card,.ant-card,[class*="panel"],[class*="card"]'))
        .filter((el) => visible(el) && isTargetSectionText(normalizedText(el)));
      forms.sort((a, b) => textOf(a).length - textOf(b).length);
      if (forms[0]) return forms[0];

      const activePanels = Array.from(document.querySelectorAll(
        '.ant-tabs-tabpane-active, .el-tab-pane:not([aria-hidden="true"]), [role="tabpanel"]:not([hidden]), .el-tabs__content, .ant-tabs-content-holder, .ant-tabs-content'
      )).filter((el) => {
        if (!visible(el)) return false;
        const controls = el.querySelectorAll('input,textarea,select,.el-select,.ant-select,[role="combobox"],[class*="select"],[class*="dropdown"]').length;
        const rows = el.querySelectorAll('.category-attr-item,.el-form-item,.ant-form-item,[class*="form-item"],tr').length;
        const required = el.querySelectorAll('.is-required,.required,.ant-form-item-required').length;
        return controls > 0 && rows > 0 && required > 0;
      });

      activePanels.sort((a, b) => {
        const requiredA = a.querySelectorAll('.is-required,.required,.ant-form-item-required').length;
        const requiredB = b.querySelectorAll('.is-required,.required,.ant-form-item-required').length;
        return requiredB - requiredA || textOf(a).length - textOf(b).length;
      });
      return activePanels[0] || null;
    }

    function findCustomAttributeRoot() {
      const rows = findCustomRequiredRows();
      if (!rows.length) return null;

      const scored = [];
      for (const row of rows) {
        let current = row.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 8) {
          if (!visible(current)) {
            current = current.parentElement;
            depth += 1;
            continue;
          }

          const customRows = current.querySelectorAll('.category-attr-item').length;
          const required = current.querySelectorAll('.category-attr-item-name.required, .required, .is-required, .ant-form-item-required').length;
          const controls = current.querySelectorAll('input,textarea,select,.el-select,.ant-select,[role="combobox"],.el-cascader,.ant-cascader,[class*="select"],[class*="dropdown"]').length;
          if (required > 0 && controls > 0) {
            const text = textOf(current);
            let score = customRows * 10 + required * 20 + Math.min(controls, 20);
            if (/类别&属性|类目&属性|分类&属性|商品属性|产品属性/.test(text)) score += 60;
            if (/发货仓库|运费模板|图片编辑|保存当前配置|模板管理/.test(text)) score -= 40;
            score -= Math.floor(text.length / 500);
            scored.push({ el: current, score, length: text.length });
          }

          current = current.parentElement;
          depth += 1;
        }
      }

      scored.sort((a, b) => b.score - a.score || a.length - b.length);
      return scored[0] ? scored[0].el : rows[0].parentElement;
    }

    function findCustomRequiredRows() {
      const rows = [];
      const seenRows = new Set();

      Array.from(document.querySelectorAll('.category-attr-item'))
        .filter((row) => visible(row) && hasEditableControl(row) && isRequiredRow(row))
        .forEach((row) => {
          if (!seenRows.has(row)) {
            seenRows.add(row);
            rows.push(row);
          }
        });

      const requiredNames = Array.from(document.querySelectorAll(
        '.category-attr-item-name.required, [class*="attr-item-name"].required'
      )).filter(visible);

      for (const label of requiredNames) {
        let current = label.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 8) {
          if (visible(current) && hasEditableControl(current)) {
            const text = textOf(current);
            if (text && text.length <= 800 && !seenRows.has(current)) {
              seenRows.add(current);
              rows.push(current);
              break;
            }
          }
          current = current.parentElement;
          depth += 1;
        }
      }

      return rows;
    }

    function collectRows(root) {
      const selectors = [
        '.category-attr-item',
        '.el-form-item',
        '.ant-form-item',
        '[class*="category-attr"]',
        '[class*="form-item"]',
        '[class*="attribute-item"]',
        '[class*="property-item"]',
        '[class*="attr-item"]',
        'tr'
      ];
      const rows = [];
      const seenRows = new Set();

      for (const selector of selectors) {
        root.querySelectorAll(selector).forEach((el) => {
          if (seenRows.has(el) || !visible(el)) return;
          const text = textOf(el);
          if (!text || text.length > 600) return;
          if (!hasEditableControl(el)) return;
          seenRows.add(el);
          rows.push(el);
        });
      }

      findCustomRequiredRows().forEach((el) => {
        if (seenRows.has(el) || !root.contains(el) || !visible(el)) return;
        const text = textOf(el);
        if (!text || text.length > 800) return;
        if (!hasEditableControl(el)) return;
        seenRows.add(el);
        rows.push(el);
      });

      return rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
    }

    function isRedColor(color) {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return /red|#f56c6c|#ff4d4f|#f5222d/i.test(color || '');
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      return r >= 150 && g <= 130 && b <= 130;
    }

    function hasRequiredPseudo(el) {
      for (const pseudo of ['::before', '::after']) {
        const style = window.getComputedStyle(el, pseudo);
        const content = style && style.content;
        if (content && content.includes('*') && isRedColor(style.color)) return true;
      }
      return false;
    }

    function isRequiredRow(row) {
      const classText = `${row.className || ''}`;
      if (/(\s|^)required(\s|$)|is-required|ant-form-item-required/i.test(classText)) return true;
      if (/is-required|required|ant-form-item-required/i.test(classText) && hasRequiredPseudo(row)) return true;
      if (hasRequiredPseudo(row)) return true;

      const possibleMarks = Array.from(row.querySelectorAll(
        'label, span, i, em, b, .required, .is-required, .ant-form-item-required, .el-form-item__label'
      ));
      return possibleMarks.some((el) => {
        const text = textOf(el);
        const className = `${el.className || ''}`;
        if (/(\s|^)required(\s|$)|is-required|ant-form-item-required/i.test(className)) return true;
        if (hasRequiredPseudo(el)) return true;
        if (!text.includes('*') && !/required|is-required|ant-form-item-required/i.test(className)) return false;
        return text.includes('*') ? isRedColor(window.getComputedStyle(el).color) : hasRequiredPseudo(el);
      });
    }

    function cleanupName(text) {
      return String(text || '')
        .replace(/\*/g, '')
        .replace(/必填/g, '')
        .replace(/[:：]\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function extractName(row) {
      const selectors = [
        '.category-attr-item-name',
        '[class*="attr-item-name"]',
        '.el-form-item__label',
        '.ant-form-item-label label',
        '.ant-form-item-label',
        'label',
        '[class*="label"]',
        'th'
      ];

      for (const selector of selectors) {
        const label = row.querySelector(selector);
        const text = cleanupName(textOf(label));
        if (text && text.length <= 60 && !/请选择|输入|Select|Input/i.test(text)) return text;
      }

      const clone = row.cloneNode(true);
      clone.querySelectorAll('input, textarea, select, button, .el-select, .ant-select, [role="combobox"], [contenteditable="true"]').forEach((el) => el.remove());
      const firstLine = cleanupName(textOf(clone).split(/\s{2,}|\n/)[0]);
      return firstLine && firstLine.length <= 60 ? firstLine : '';
    }

    function shouldIgnoreName(name, row) {
      const text = `${name} ${textOf(row)}`;
      return /发货仓库|运费模板|店铺|模板|保存当前配置|保存模板|模板管理|英语标题|AI生成|产品素材图|图片翻译|图片编辑|导出图片|添加水印|选中前|批量|同步|创建仓库|SKU|价格|库存|产品类别|商品类别|商品类目|产品类目|类目|分类/.test(text);
    }

    function hasEditableControl(row) {
      return Boolean(row.querySelector(
        'textarea, input:not([type="hidden"]), select, .el-select, .ant-select, [role="combobox"], [contenteditable="true"], .el-cascader, .ant-cascader, .el-date-editor, .ant-picker, [class*="select"], [class*="dropdown"]'
      ));
    }

    function detectControlType(row) {
      const multi = row.querySelector('.ant-select-multiple, .el-select__tags, [aria-multiselectable="true"], [class*="multiple"], [class*="tags"]');
      if (multi) return 'multi_select';

      const hasSelect = row.querySelector('.el-select, .ant-select, [role="combobox"], select, [class*="select"]');
      if (hasSelect) return 'select';

      if (row.querySelector('textarea, input:not([type="hidden"])')) return 'input';
      if (row.querySelector('[contenteditable="true"], .el-cascader, .ant-cascader, .el-date-editor, .ant-picker')) return 'unknown';
      return 'unknown';
    }

    function isPlaceholderText(value) {
      return !value || /请选择|选择|请输入|输入|Select|Input|Please select/i.test(value);
    }

    function detectAlreadyFilled(row, controlType) {
      if (controlType === 'input') {
        const input = row.querySelector('textarea, input:not([type="hidden"])');
        return Boolean(input && String(input.value || '').trim());
      }

      const normalSelect = row.querySelector('select');
      if (normalSelect && normalSelect.value) {
        const selected = normalSelect.options[normalSelect.selectedIndex];
        const selectedText = selected ? textOf(selected) : normalSelect.value;
        return !isPlaceholderText(selectedText);
      }

      const selectedNodes = Array.from(row.querySelectorAll(
        '.el-tag, .el-select__tags-text, .ant-select-selection-item, [class*="selection-item"]'
      )).map(textOf).filter((text) => text && !isPlaceholderText(text));
      if (selectedNodes.length) return true;

      const inputs = Array.from(row.querySelectorAll('.el-select input, .ant-select input, [role="combobox"], input:not([type="hidden"])'));
      return inputs.some((input) => {
        const value = String(input.value || '').trim();
        return value && !isPlaceholderText(value);
      });
    }
  });

  for (const row of rows) {
    row.name = cleanAttributeName(row.name);
    if (row.controlType === 'select' || row.controlType === 'multi_select') {
      try {
        row.options = await readOptionsForAttribute(page, row);
      } catch (error) {
        console.warn(`[扫描] ${row.name} 读取选项失败: ${error.message}`);
        row.options = [];
      }
    }
  }

  return rows;
}

async function readOptionsForAttribute(page, attribute) {
  const row = page.locator(attribute._rowSelector).first();
  if (!(await row.count())) return [];

  const opened = await openSelect(row);
  if (!opened) return [];

  let options = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(250);
    options = await collectVisibleOptions(page);
    if (options.length) break;
  }

  await closeDropdown(page);
  return unique(options)
    .map((item) => item.trim())
    .filter((item) => item && normalizeText(item));
}

async function openSelect(row) {
  const targets = [
    '.el-select',
    '.ant-select',
    '[role="combobox"]',
    '.el-input',
    '.ant-select-selector',
    'select',
    'input[readonly]',
    'input'
  ];

  for (const selector of targets) {
    const locator = row.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      try {
        await item.scrollIntoViewIfNeeded();
        await item.click({ timeout: 2500 });
        return true;
      } catch (_) {
        continue;
      }
    }
  }
  return false;
}

async function collectVisibleOptions(page) {
  const options = [];
  for (const selector of OPTION_SELECTORS) {
    const texts = await page.locator(selector).evaluateAll((nodes) => {
      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      return nodes
        .filter((node) => visible(node))
        .filter((node) => !/disabled|is-disabled|ant-select-item-option-disabled/i.test(`${node.className || ''}`))
        .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }).catch(() => []);
    options.push(...texts);
  }
  return unique(options);
}

async function closeDropdown(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(100);
}

module.exports = {
  scanRequiredAttributes
};
