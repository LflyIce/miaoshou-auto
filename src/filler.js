const { sleep, toArrayValue } = require('./utils');

const OPTION_SELECTORS = [
  '.el-select-dropdown .el-select-dropdown__item',
  '.el-popper .el-select-dropdown__item',
  '.ant-select-dropdown .ant-select-item-option',
  '.ant-select-dropdown [role="option"]',
  '[role="listbox"] [role="option"]',
  '.dropdown-menu li'
];

async function fillAttribute(page, attribute, finalValue) {
  if (!finalValue || (Array.isArray(finalValue) && !finalValue.length)) {
    throw new Error('最终填写值为空');
  }

  if (attribute.controlType === 'select') {
    return fillSelect(page, attribute, String(finalValue));
  }

  if (attribute.controlType === 'multi_select') {
    return fillMultiSelect(page, attribute, finalValue);
  }

  if (attribute.controlType === 'input') {
    return fillInput(page, attribute, String(finalValue));
  }

  throw new Error(`未知控件类型: ${attribute.controlType}`);
}

async function fillSelect(page, attribute, value) {
  const row = await getRow(page, attribute);
  await openSelect(row);
  await sleep(250);

  let clicked = await clickOption(page, value, true);
  if (!clicked) {
    await typeSearchValue(row, page, value);
    await sleep(350);
    clicked = await clickOption(page, value, false);
  }

  if (!clicked) throw new Error(`下拉选项中找不到 ${value}`);
  await sleep(300);

  const ok = await verifyRowContains(row, value);
  if (!ok) throw new Error(`选择后未检测到已填写值 ${value}`);
  await page.keyboard.press('Escape').catch(() => {});
  return { status: 'success' };
}

async function fillMultiSelect(page, attribute, finalValue) {
  const row = await getRow(page, attribute);
  const values = toArrayValue(finalValue);
  if (!values.length) throw new Error('多选值为空');

  for (const value of values) {
    await openSelect(row);
    await sleep(250);
    let clicked = await clickOption(page, value, true);
    if (!clicked) {
      await typeSearchValue(row, page, value);
      await sleep(350);
      clicked = await clickOption(page, value, false);
    }
    if (!clicked) throw new Error(`多选选项中找不到 ${value}`);
    await sleep(200);
  }

  await page.keyboard.press('Escape').catch(() => {});
  const rowText = await row.innerText().catch(() => '');
  const missing = values.filter((value) => !rowText.includes(value));
  if (missing.length) throw new Error(`多选填写后未检测到: ${missing.join(', ')}`);
  return { status: 'success' };
}

async function fillInput(page, attribute, value) {
  const row = await getRow(page, attribute);
  const input = row.locator('textarea, input:not([type="hidden"])').first();
  if (!(await input.count())) throw new Error('找不到输入框');
  await input.scrollIntoViewIfNeeded();
  await input.fill('');
  await input.fill(value);
  await sleep(150);
  const actual = await input.inputValue().catch(() => '');
  if (actual.trim() !== value.trim()) throw new Error(`输入验证失败，当前值为 ${actual}`);
  return { status: 'success' };
}

async function getRow(page, attribute) {
  if (attribute._rowSelector) {
    const row = page.locator(attribute._rowSelector).first();
    if (await row.count()) return row;
  }

  const candidates = ['.el-form-item', '.ant-form-item', 'tr', 'li'];

  for (const selector of candidates) {
    const row = page.locator(selector).filter({ hasText: attribute.name }).first();
    if (await row.count().catch(() => 0)) return row;
  }
  throw new Error(`找不到属性行: ${attribute.name}`);
}

async function openSelect(row) {
  const targets = [
    '.el-select',
    '.ant-select',
    '[role="combobox"]',
    '.el-input',
    '.ant-select-selector',
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
  throw new Error('无法打开选择框');
}

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

module.exports = {
  fillAttribute
};
