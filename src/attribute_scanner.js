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

async function scanRequiredAttributes(page, options = {}) {
  const errorFields = (options.errorFields || []).map((f) => f.replace(/\s+/g, '').toLowerCase());
  const rows = await page.evaluate((errorFields) => {
    const root = findCategoryAttributeRoot();
    if (!root) return [];

    const candidates = collectRows(root);
    const result = [];
    const seen = new Set();

    candidates.forEach((row, index) => {
      const validationError = extractValidationError(row);
      if (!isRequiredRow(row) && !validationError) return;
      if (!hasEditableControl(row)) return;

      const name = extractName(row);
      if (!name || shouldIgnoreName(name, row)) return;

      const controlType = detectControlType(row);
      const alreadyFilled = detectAlreadyFilled(row, controlType);

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
        errorMessage: validationError,
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
            '.el-form-item,.ant-form-item,input,textarea,select,.el-select,.ant-select,[role="combobox"]'
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
        const controls = el.querySelectorAll('input,textarea,select,.el-select,.ant-select,[role="combobox"]').length;
        const rows = el.querySelectorAll('.el-form-item,.ant-form-item,[class*="form-item"],tr').length;
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

    function collectRows(root) {
      const selectors = [
        '.category-attr-list > .category-attr-item',
        '.category-attr-item',
        '.el-form-item',
        '.ant-form-item',
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
          if (!isCategoryAttrItem(el) && closestCategoryAttrItem(el, root) && selector !== '.category-attr-item') return;
          const text = textOf(el);
          if (!text) return;
          if (!isCategoryAttrItem(el) && text.length > 600) return;
          if (!hasEditableControl(el)) return;
          seenRows.add(el);
          rows.push(el);
        });
      }

      return rows.filter((row) => {
        if (isCategoryAttrItem(row)) return true;
        return !rows.some((other) => other !== row && other.contains(row));
      });
    }

    function isCategoryAttrItem(el) {
      return Boolean(el && el.classList && el.classList.contains('category-attr-item') && el.querySelector('.category-attr-item-name'));
    }

    function closestCategoryAttrItem(el, root) {
      const item = el && el.closest ? el.closest('.category-attr-item') : null;
      return item && root.contains(item) ? item : null;
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
      if (/is-required|required|ant-form-item-required/i.test(classText)) return true;
      if (hasRequiredPseudo(row)) return true;

      const categoryName = row.querySelector('.category-attr-item-name');
      if (categoryName && /required/i.test(`${categoryName.className || ''}`)) return true;

      const possibleMarks = Array.from(row.querySelectorAll(
        'label, span, i, em, b, .required, .is-required, .ant-form-item-required, .el-form-item__label, .category-attr-item-name'
      ));
      return possibleMarks.some((el) => {
        const text = textOf(el);
        const className = `${el.className || ''}`;
        if (hasRequiredPseudo(el)) return true;
        if (/required|is-required|ant-form-item-required/i.test(className)) return true;
        if (!text.includes('*') && !/required|is-required|ant-form-item-required/i.test(className)) return false;
        return text.includes('*') ? true : hasRequiredPseudo(el);
      });
    }

    function extractValidationError(row) {
      const selectors = [
        '.el-form-item__error',
        '.ant-form-item-explain-error',
        '.ant-form-item-extra',
        '.invalid-feedback',
        '[role="alert"]',
        '[class*="error"]',
        '[class*="Error"]'
      ];
      const messages = Array.from(row.querySelectorAll(selectors.join(',')))
        .filter(visible)
        .map(textOf)
        .filter((text) => text && /不能为空|必填|请选择|未填写|有误|错误|校验|验证|required/i.test(text))
        .filter((text) => text.length <= 220);
      return Array.from(new Set(messages)).join(' | ');
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
      const categoryName = row.querySelector('.category-attr-item-name') ||
        (closestCategoryAttrItem(row, document.body) && closestCategoryAttrItem(row, document.body).querySelector('.category-attr-item-name'));
      const categoryNameText = cleanupName(textOf(categoryName));
      if (categoryNameText && categoryNameText.length <= 60) return categoryNameText;

      const selectors = [
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
      if (/发货仓库|运费模板|店铺|模板|保存当前配置|保存模板|模板管理|英语标题|AI生成|产品素材图|图片翻译|图片编辑|导出图片|添加水印|选中前|批量|同步|创建仓库|SKU|价格|库存|产品类别|商品类别|商品类目|产品类目|类目|分类/.test(text)) {
        const nameClean = name.replace(/\s+/g, '').toLowerCase();
        for (const ef of errorFields) {
          if (nameClean.includes(ef) || ef.includes(nameClean)) return false;
        }
        return true;
      }
      return false;
    }

    function hasEditableControl(row) {
      if (isMaterialRatioTable(row)) return true;
      return Boolean(row.querySelector(
        'textarea, input:not([type="hidden"]), select, .el-select, .ant-select, [role="combobox"], [contenteditable="true"], .el-cascader, .ant-cascader, .el-date-editor, .ant-picker'
      ));
    }

    function detectControlType(row) {
      if (isMaterialRatioTable(row)) return 'material_ratio_table';

      // 输入框 + 单位选择器（如 "平方克重（g/㎡）"）：主交互是输入数字，单位选择器可忽略
      const unitSelect = row.querySelector('.el-select.unit, .ant-select.unit, [class*="unit"][class*="select"]');
      if (unitSelect && row.querySelector('input:not([type="hidden"])')) return 'input';

      const multi = row.querySelector('.ant-select-multiple, .el-select__tags, [aria-multiselectable="true"], [class*="multiple"], [class*="tags"]');
      if (multi) return 'multi_select';

      const hasSelect = row.querySelector('.el-select, .ant-select, [role="combobox"], select, [class*="select"]');
      if (hasSelect) return 'select';

      if (row.querySelector('textarea, input:not([type="hidden"])')) return 'input';
      if (row.querySelector('[contenteditable="true"], .el-cascader, .ant-cascader, .el-date-editor, .ant-picker')) return 'unknown';
      return 'unknown';
    }

    function isMaterialRatioTable(row) {
      const text = textOf(row);
      const hasTable = Boolean(row.querySelector('.el-table, .jx-pro-table, table'));
      const hasAddButton = Array.from(row.querySelectorAll('button, .el-button'))
        .some((button) => /添加|新增|add/i.test(textOf(button)));
      const mentionsMaterial = /材料|材质/.test(text);
      const mentionsRatio = /成分比例|比例|100%/.test(text);
      return hasTable && hasAddButton && mentionsMaterial && mentionsRatio;
    }

    function isPlaceholderText(value) {
      return !value || /请选择|选择|请输入|输入|Select|Input|Please select/i.test(value);
    }

    function detectAlreadyFilled(row, controlType) {
      if (controlType === 'material_ratio_table') {
        const bodyRows = Array.from(row.querySelectorAll('tbody tr'))
          .filter((tr) => visible(tr) && textOf(tr) && !/暂无数据|No Data/i.test(textOf(tr)));
        return bodyRows.length > 0;
      }

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
        '.el-tag, .el-select__tags-text, .ant-select-selection-item, [class*="selection-item"], .el-select-dropdown__item.selected, .jx-pro-option.selected'
      )).map(textOf).filter((text) => text && !isPlaceholderText(text));
      if (selectedNodes.length) return true;

      const inputs = Array.from(row.querySelectorAll('.el-select input, .ant-select input, [role="combobox"], input:not([type="hidden"])'));
      return inputs.some((input) => {
        const value = String(input.value || input.getAttribute('title') || '').trim();
        if (!value || isPlaceholderText(value)) return false;
        if (/不能为空|必填|请选择|未填写|有误|错误|校验|验证/i.test(value)) return false;
        return true;
      });
    }
  }, errorFields);

  for (const row of rows) {
    row.name = cleanAttributeName(row.name);
    if ((!row.alreadyFilled || row.errorMessage) && (row.controlType === 'select' || row.controlType === 'multi_select')) {
      try {
        row.options = await readOptionsForAttribute(page, row);
      } catch (error) {
        console.warn(`[扫描] ${row.name} 读取选项失败: ${error.message}`);
        row.options = [];
      }
    }

    if ((!row.alreadyFilled || row.errorMessage) && row.controlType === 'material_ratio_table') {
      try {
        row.options = await readMaterialTableOptions(page, row);
      } catch (error) {
        console.warn(`[扫描] ${row.name} 材质表格选项读取失败: ${error.message}`);
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

async function readMaterialTableOptions(page, attribute) {
  const row = page.locator(attribute._rowSelector).first();
  if (!(await row.count())) return [];

  const hadExistingRow = (await row.locator('tbody tr').count().catch(() => 0)) > 0;

  if (!hadExistingRow) {
    const buttons = row.locator('button, .el-button');
    const count = await buttons.count().catch(() => 0);
    let added = false;
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const text = await button.innerText().catch(() => '');
      if (text && !/添加|新增|add/i.test(text)) continue;
      try {
        await button.scrollIntoViewIfNeeded();
        await button.click({ timeout: 2500 });
        added = true;
        break;
      } catch (_) {
        continue;
      }
    }
    if (!added) return [];

    let rowAppeared = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await row.locator('tbody tr').count().catch(() => 0)) > 0) { rowAppeared = true; break; }
      await sleep(150);
    }
    if (!rowAppeared) return [];
  }

  const selectRow = row.locator('tbody tr').first();
  const opened = await openSelect(selectRow);
  if (!opened) {
    await cleanupMaterialRow(row, hadExistingRow);
    return [];
  }

  let options = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleep(250);
    options = await collectVisibleOptions(page);
    if (options.length) break;
  }

  await closeDropdown(page);
  await cleanupMaterialRow(row, hadExistingRow);
  return unique(options).map((item) => item.trim()).filter((item) => item && normalizeText(item));
}

async function cleanupMaterialRow(row, hadExistingRow) {
  if (hadExistingRow) return;
  const deleteButtons = row.locator('tbody tr button, tbody tr .el-button');
  const count = await deleteButtons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const button = deleteButtons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = await button.innerText().catch(() => '');
    if (text && /删除|移除|delete|remove/i.test(text)) {
      await button.click({ timeout: 2500 }).catch(() => {});
      break;
    }
  }
  await sleep(200);
}

module.exports = {
  scanRequiredAttributes
};
