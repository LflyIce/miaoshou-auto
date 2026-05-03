const { sleep } = require('./utils');

const OPTION_SELECTORS = [
  '.el-select-dropdown .el-select-dropdown__item',
  '.el-popper .el-select-dropdown__item',
  '.ant-select-dropdown .ant-select-item-option',
  '.ant-select-dropdown [role="option"]',
  '[role="listbox"] [role="option"]',
  '.select-dropdown [role="option"]',
  '.dropdown-menu li'
];

async function fillSkuProperties(page, options = {}) {
  const modelName = options.modelName || '型号';
  const rules = [
    { key: 'spec-one', label: '规格一', keep: 3, setTitle: true },
    { key: 'spec-two', label: '规格二', keep: 2, setTitle: false }
  ];

  const rows = await markSkuPropertyRows(page, rules.map((rule) => rule.label));
  const summary = {
    status: 'success',
    specOneFound: Boolean(rows['规格一']),
    specTwoFound: Boolean(rows['规格二']),
    specOneTitleChanged: false,
    specOneTrimmed: 0,
    specTwoTrimmed: 0,
    changed: false
  };

  for (const rule of rules) {
    const selector = rows[rule.label];
    if (!selector) continue;

    if (rule.setTitle) {
      const titleResult = await ensureSkuPropertyTitle(page, selector, modelName);
      summary.specOneTitleChanged = Boolean(titleResult.changed);
      if (titleResult.changed) summary.changed = true;
    }

    const trimmed = await trimSkuPropertyItems(page, selector, rule.keep);
    if (rule.key === 'spec-one') summary.specOneTrimmed = trimmed;
    if (rule.key === 'spec-two') summary.specTwoTrimmed = trimmed;
    if (trimmed > 0) summary.changed = true;
  }

  if (!summary.specOneFound && !summary.specTwoFound) {
    summary.status = 'skipped';
    summary.reason = '未找到规格一/规格二';
  }

  return summary;
}

async function markSkuPropertyRows(page, labels) {
  return page.evaluate((targetLabels) => {
    const result = {};

    document.querySelectorAll('[data-ms-sku-property]').forEach((node) => {
      node.removeAttribute('data-ms-sku-property');
    });

    const rows = Array.from(document.querySelectorAll('.el-form-item, .ant-form-item, [class*="form-item"]'))
      .filter(visible)
      .filter((row) => row.querySelector('.spec-box-container, [class*="spec-box"]'));

    for (const label of targetLabels) {
      const matched = rows.find((row) => normalize(extractLabel(row)).includes(normalize(label)));
      if (!matched) continue;
      const key = label === '规格一' ? 'spec-one' : 'spec-two';
      matched.setAttribute('data-ms-sku-property', key);
      result[label] = `[data-ms-sku-property="${key}"]`;
    }

    return result;

    function extractLabel(row) {
      const label = row.querySelector(':scope > .el-form-item__label, :scope > label, :scope > .ant-form-item-label label');
      return textOf(label);
    }

    function normalize(text) {
      return String(text || '').replace(/\s+/g, '').replace(/：|:/g, '').trim();
    }

    function textOf(node) {
      return (node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
  }, labels);
}

async function ensureSkuPropertyTitle(page, propertySelector, targetTitle) {
  const row = page.locator(propertySelector).first();
  const current = await readSkuPropertyTitle(row);
  if (current === targetTitle) return { changed: false };

  const titleSelect = row.locator('.sku-property-title .el-select, .sku-property-title .ant-select, .sku-property-title [role="combobox"], .sku-property-title input[readonly], .sku-property-title .el-input').first();
  if (!(await titleSelect.count().catch(() => 0))) {
    throw new Error('找不到规格一名称下拉框');
  }

  await titleSelect.scrollIntoViewIfNeeded().catch(() => {});
  await titleSelect.click({ timeout: 3000 });
  await sleep(250);

  const clicked = await clickVisibleOption(page, targetTitle);
  if (!clicked) {
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(`规格一名称下拉选项中找不到 ${targetTitle}`);
  }

  await sleep(300);
  const actual = await readSkuPropertyTitle(row);
  if (actual !== targetTitle) {
    throw new Error(`规格一名称选择后未检测到 ${targetTitle}`);
  }

  await page.keyboard.press('Escape').catch(() => {});
  return { changed: true };
}

async function readSkuPropertyTitle(row) {
  const input = row.locator('.sku-property-title input, .sku-property-title textarea').first();
  if (!(await input.count().catch(() => 0))) return '';
  return String(await input.inputValue().catch(() => '')).trim();
}

async function trimSkuPropertyItems(page, propertySelector, keepCount) {
  const row = page.locator(propertySelector).first();
  const itemSelector = '.spec-box-container .spec-item';
  let count = await row.locator(itemSelector).count().catch(() => 0);
  let trimmed = 0;

  while (count > keepCount) {
    const item = row.locator(itemSelector).nth(count - 1);
    const deleteIcon = item.locator('.el-icon-delete, .anticon-delete, [class*="delete"]').first();
    if (!(await deleteIcon.count().catch(() => 0))) {
      throw new Error(`第 ${count} 个规格选项找不到删除按钮`);
    }

    await deleteIcon.scrollIntoViewIfNeeded().catch(() => {});
    await deleteIcon.click({ timeout: 3000 });
    await waitForItemCountBelow(row, itemSelector, count);
    trimmed += 1;
    count = await row.locator(itemSelector).count().catch(() => 0);
  }

  return trimmed;
}

async function waitForItemCountBelow(row, itemSelector, previousCount) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(150);
    const current = await row.locator(itemSelector).count().catch(() => previousCount);
    if (current < previousCount) return;
  }
  throw new Error('点击删除后规格选项数量未减少');
}

async function clickVisibleOption(page, value) {
  for (const selector of OPTION_SELECTORS) {
    const handles = await page.locator(selector).elementHandles().catch(() => []);
    for (const handle of handles) {
      const matched = await handle.evaluate((node, expected) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        if (!visible) return false;
        if (/disabled|is-disabled|ant-select-item-option-disabled/i.test(`${node.className || ''}`)) return false;
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        return text === expected;
      }, value).catch(() => false);

      if (!matched) continue;
      try {
        await handle.click({ timeout: 2500 });
        return true;
      } catch (_) {
        continue;
      }
    }
  }
  return false;
}

module.exports = {
  fillSkuProperties
};
