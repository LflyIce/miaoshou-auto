const { sleep } = require('./utils');

const OPTION_SELECTORS = [
  '.el-select-dropdown .el-select-dropdown__item',
  '.el-popper .el-select-dropdown__item',
  '.jx-select-dropdown .jx-select-dropdown__item',
  '.jx-popper [role="option"]',
  '.jx-select-dropdown [role="option"]',
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

  // 保存前规则：保留项规格值超过30字符上限（保存必被拒）→ 跳过商品
  // 注意：规格二名为"尺码"是纺织品常态（值≤30可正常保存），不能按名字跳过
  const skipReason = await detectUnfillableSpec(page, rows, rules);
  if (skipReason) {
    return {
      status: 'skip_product',
      reason: skipReason,
      specOneFound: Boolean(rows['规格一']),
      specTwoFound: Boolean(rows['规格二']),
      specOneTitleChanged: false,
      specOneTrimmed: 0,
      specTwoTrimmed: 0,
      changed: false
    };
  }

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

/** 检测无法自动处理的规格：裁剪后保留项的值超过30字符上限（保存必被拒）。返回原因字符串，无问题返回 '' */
async function detectUnfillableSpec(page, rows, rules) {
  try {
    for (const rule of rules) {
      const selector = rows[rule.label];
      if (!selector) continue;
      const row = page.locator(selector).first();

      // 只检查裁剪后仍会保留的项（规格一前3项、规格二前2项），超30字符保存必失败
      const inputs = row.locator('.spec-item input:not([type="hidden"])');
      const total = await inputs.count().catch(() => 0);
      const keep = Math.min(total, rule.keep);
      for (let i = 0; i < keep; i += 1) {
        const value = String(await inputs.nth(i).inputValue().catch(() => '')).trim();
        if (value.length > 30) {
          return `保留规格值超过30字符上限（${value.slice(0, 30)}...），保存会被拒，跳过商品`;
        }
      }
    }
  } catch (_) { /* 检测异常不阻断主流程 */ }
  return '';
}

async function markSkuPropertyRows(page, labels) {
  return page.evaluate((targetLabels) => {
    const result = {};

    document.querySelectorAll('[data-ms-sku-property]').forEach((node) => {
      node.removeAttribute('data-ms-sku-property');
    });

    const rows = Array.from(document.querySelectorAll('.el-form-item, .ant-form-item, [class*="form-item"]'))
      .filter(visible)
      .filter((row) => row.querySelector('.spec-box-container, [class*="spec-box"], .sku-property__content'));

    for (const label of targetLabels) {
      const matched = rows.find((row) => normalize(extractLabel(row)).includes(normalize(label)));
      if (!matched) continue;
      const key = label === '规格一' ? 'spec-one' : 'spec-two';
      matched.setAttribute('data-ms-sku-property', key);
      result[label] = `[data-ms-sku-property="${key}"]`;
    }

    return result;

    function extractLabel(row) {
      const label = row.querySelector('.jx-form-item__label, :scope > .el-form-item__label, :scope > label, :scope > .ant-form-item-label label');
      return textOf(label);
    }

    // 新版页面标签为"规格1/规格2"，旧版为"规格一/规格二"，归一化后互通
    function normalize(text) {
      return String(text || '')
        .replace(/\s+/g, '')
        .replace(/：|:/g, '')
        .replace(/一/g, '1')
        .replace(/二/g, '2')
        .trim();
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

  const titleSelect = row.locator('.sku-property-title .jx-select__wrapper, .sku-property-title .jx-select, .sku-property-title .el-select, .sku-property-title .ant-select, .sku-property-title [role="combobox"], .sku-property-title .el-input').first();
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
  if (await input.count().catch(() => 0)) {
    const value = String(await input.inputValue().catch(() => '')).trim();
    if (value) return value;
  }
  // jx-select 选中值可能只渲染在 placeholder span 里
  const placeholder = row.locator('.sku-property-title .jx-select__placeholder').first();
  if (await placeholder.count().catch(() => 0)) {
    return (await placeholder.innerText().catch(() => '')).trim();
  }
  return '';
}

async function trimSkuPropertyItems(page, propertySelector, keepCount) {
  const row = page.locator(propertySelector).first();
  const itemSelector = '.spec-box-container .spec-item, .sku-property__content .spec-item, .spec-item';
  let count = await row.locator(itemSelector).count().catch(() => 0);
  let trimmed = 0;

  while (count > keepCount) {
    const item = row.locator(itemSelector).nth(count - 1);
    // 新版删除按钮在输入框 append 槽内的垃圾桶图标，旧版为 el/ant 的 delete 图标
    const deleteIcon = item.locator('.jx-input-group__append .jx-icon, .el-icon-delete, .anticon-delete, [class*="delete"]').first();
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
