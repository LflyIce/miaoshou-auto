// UI 原语层：妙手页面混合 jx-* / el-* / ant-* 三套组件库，
// 所有下拉交互的选择器与基础操作集中在此一处维护，scanner / filler / sku_filler 共用。
// 页面换肤或新增组件库时只改这个文件。
const { sleep, unique } = require('./utils');

/** 下拉选项节点选择器（三套组件库的可见选项） */
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

/** 下拉面板容器选择器（用于事件等待，替代固定 sleep） */
const DROPDOWN_PANEL_SELECTORS = [
  '.jx-select-dropdown',
  '.el-select-dropdown',
  '.ant-select-dropdown',
  '[role="listbox"]',
  '.dropdown-menu'
];

/** 等待任一下拉面板可见：面板已开立即返回（比固定 sleep 快）。
 *  超时或环境不支持 waitForSelector（单测 fake page）时返回 false，不抛错 */
async function waitForDropdownVisible(page, timeout = 800) {
  try {
    await page.waitForSelector(DROPDOWN_PANEL_SELECTORS.join(','), { state: 'visible', timeout });
    return true;
  } catch (_) {
    return false;
  }
}

/** 打开行内选择框：按"具体→宽泛"顺序尝试候选载体，命中即返回 true，全败返回 false（调用方决定是否报错）。
 *  注意：不兜底裸 input——宽泛匹配会点到行外的元素（如左侧商品列表），误触"是否确认离开"弹窗 */
async function openSelect(row) {
  const targets = [
    '.jx-select__wrapper',
    '.jx-select',
    '.el-select',
    '.ant-select',
    '[role="combobox"]',
    '.el-input',
    '.ant-select-selector',
    'select',
    'input[readonly]'
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

/** 点击下拉外部（模块标题）关闭下拉——jx 的多选组件按 Escape 会回滚未提交的选择 */
async function closeDropdownByOutsideClick(page) {
  const label = page.locator('.scroll-menu-pane__label').first();
  if (await label.count().catch(() => 0)) {
    await label.click({ timeout: 1500, force: true }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await sleep(150);
}

/** 按 Escape 关闭下拉（读取选项等只读场景使用） */
async function closeDropdown(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(100);
}

/** 在当前可见选项中点击匹配项：exact=true 全等，否则双向包含。返回是否点到 */
async function clickOption(page, value, exact) {
  for (const selector of OPTION_SELECTORS) {
    const handles = await page.locator(selector).elementHandles().catch(() => []);
    for (const handle of handles) {
      const matched = await handle.evaluate((node, args) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        if (!visible) return false;
        if (/disabled|is-disabled|ant-select-item-option-disabled/i.test(`${node.className || ''}`)) return false;
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        return args.exact ? text === args.value : text.includes(args.value) || args.value.includes(text);
      }, { value, exact }).catch(() => false);

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

/** 点击第一个可见且可用的选项，返回其文本（兜底场景），无则返回 '' */
async function clickFirstVisibleOption(page) {
  for (const selector of OPTION_SELECTORS) {
    const handles = await page.locator(selector).elementHandles().catch(() => []);
    for (const handle of handles) {
      const text = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        if (!visible) return '';
        if (/disabled|is-disabled|ant-select-item-option-disabled/i.test(`${node.className || ''}`)) return '';
        return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');
      if (!text) continue;
      try {
        await handle.click({ timeout: 2500 });
        return text;
      } catch (_) {
        continue;
      }
    }
  }
  return '';
}

/** 在行内搜索框输入过滤词（精确点选失败后的兜底路径） */
async function typeSearchValue(row, page, value) {
  const inputs = row.locator('.el-select input, .ant-select input, [role="combobox"], input');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    try {
      await input.click({ timeout: 1000 });
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.type(value, { delay: 20 });
      return true;
    } catch (_) {
      continue;
    }
  }
  return false;
}

/** 回读校验：行文本或行内输入框的值包含目标值即通过 */
async function verifyRowContains(row, value) {
  const text = await row.innerText().catch(() => '');
  if (text.includes(value)) return true;
  const inputs = row.locator('input, textarea');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const actual = await inputs.nth(i).inputValue().catch(() => '');
    if (actual.includes(value)) return true;
  }
  return false;
}

/** 收集当前页面所有可见、可用的下拉选项文本（一次 evaluate 拿全，避免逐节点往返） */
async function collectVisibleOptions(page) {
  const options = [];
  for (const selector of OPTION_SELECTORS) {
    const locator = page.locator(selector);
    if (typeof locator.evaluateAll !== 'function') continue; // 单测 fake locator 兼容
    const texts = await locator.evaluateAll((nodes) => {
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

module.exports = {
  OPTION_SELECTORS,
  DROPDOWN_PANEL_SELECTORS,
  waitForDropdownVisible,
  openSelect,
  closeDropdown,
  closeDropdownByOutsideClick,
  clickOption,
  clickFirstVisibleOption,
  typeSearchValue,
  verifyRowContains,
  collectVisibleOptions
};
