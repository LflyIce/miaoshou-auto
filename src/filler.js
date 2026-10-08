const { sleep, toArrayValue } = require('./utils');
const { matchLocally } = require('./option_matcher');
const {
  clickFirstVisibleOption,
  clickOption,
  closeDropdownByOutsideClick,
  collectVisibleOptions,
  openSelect,
  typeSearchValue,
  verifyRowContains,
  waitForDropdownVisible
} = require('./ui');

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

  if (attribute.controlType === 'material_ratio_table') {
    return fillMaterialRatioTable(page, attribute, finalValue);
  }

  throw new Error(`未知控件类型: ${attribute.controlType}`);
}

/** 填写时活选项重匹配：决策基于扫描时的选项快照，级联/搜索型下拉的实际选项可能已变。
 *  值不在当前活选项中时用本地匹配链（exact→normalized→contains→included_by）选最接近的活选项，
 *  找不到返回原值走原有点选/搜索兜底 */
async function rematchLiveOption(page, attrName, value) {
  const target = String(value == null ? '' : value).trim();
  if (!target) return value;
  const live = await collectVisibleOptions(page);
  if (!live.length || live.some((item) => item === target)) return value;
  const local = matchLocally(target, live);
  if (!local) return value;
  console.log(`[活选项] ${attrName}: 快照值「${target}」不在当前下拉，重匹配为「${local.option}」(${local.method})`);
  return local.option;
}

async function fillSelect(page, attribute, value) {
  const row = await getRow(page, attribute);
  if (!(await openSelect(row))) throw new Error('无法打开选择框');
  await waitForDropdownVisible(page);

  const target = await rematchLiveOption(page, attribute.name, value);
  let clicked = await clickOption(page, target, true);
  if (!clicked) {
    await typeSearchValue(row, page, target);
    await sleep(350);
    clicked = await clickOption(page, target, false);
  }

  if (!clicked) throw new Error(`下拉选项中找不到 ${target}${target !== value ? `（原决策值 ${value}）` : ''}`);
  await sleep(300);

  // 关闭后再校验：若 Escape 回滚了选择（jx 多选行为），重选并改用点击外部关闭
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
  if (!(await verifyRowContains(row, target))) {
    await openSelect(row);
    await sleep(250);
    const reclicked = await clickOption(page, target, true)
      || await clickOption(page, target, false);
    if (!reclicked) throw new Error(`下拉选项中找不到 ${target}`);
    await closeDropdownByOutsideClick(page);
    await sleep(400);
  }

  const ok = await verifyRowContains(row, target);
  if (!ok) throw new Error(`选择后未检测到已填写值 ${target}`);
  return { status: 'success' };
}

async function fillMultiSelect(page, attribute, finalValue) {
  const row = await getRow(page, attribute);
  const values = toArrayValue(finalValue);
  if (!values.length) throw new Error('多选值为空');

  const targets = [];
  const missingValues = async (filled) => {
    const rowText = await row.innerText().catch(() => '');
    return filled.filter((value) => !rowText.includes(value));
  };

  for (const value of values) {
    if (!(await openSelect(row))) throw new Error('无法打开选择框');
    await waitForDropdownVisible(page);
    const target = await rematchLiveOption(page, attribute.name, value);
    let clicked = await clickOption(page, target, true);
    if (!clicked) {
      await typeSearchValue(row, page, target);
      await sleep(350);
      clicked = await clickOption(page, target, false);
    }
    if (!clicked) throw new Error(`多选选项中找不到 ${target}`);
    await sleep(250);
    targets.push(target);
  }

  // 不按 Escape（会回滚多选），用点击外部关闭；丢失的值重选一次
  await closeDropdownByOutsideClick(page);
  await sleep(300);
  let missing = await missingValues(targets);
  if (missing.length) {
    for (const value of missing) {
      await openSelect(row);
      await sleep(250);
      const clicked = await clickOption(page, value, true) || await clickOption(page, value, false);
      if (!clicked) continue;
      await sleep(250);
      await closeDropdownByOutsideClick(page);
      await sleep(300);
    }
    missing = await missingValues(targets);
  }
  if (missing.length) throw new Error(`多选填写后未检测到: ${missing.join(', ')}`);
  return { status: 'success' };
}

async function fillInput(page, attribute, value) {
  const row = await getRow(page, attribute);
  const input = row.locator('textarea, input:not([type="hidden"])').first();
  if (!(await input.count())) throw new Error('找不到输入框');
  // 只读输入框（级联/选择器的展示载体）不可 fill，等下去只会30s超时，快速失败给出明确原因
  const readOnly = await input.evaluate((el) => el.readOnly).catch(() => false);
  if (readOnly) throw new Error('输入框只读，不是文本输入控件（可能为级联/选择器）');
  await input.scrollIntoViewIfNeeded();
  await input.fill('');
  await input.fill(value);
  await sleep(150);
  const actual = await input.inputValue().catch(() => '');
  if (actual.trim() !== value.trim()) throw new Error(`输入验证失败，当前值为 ${actual}`);
  return { status: 'success' };
}

async function fillMaterialRatioTable(page, attribute, finalValue) {
  const row = await getRow(page, attribute);
  const material = toArrayValue(finalValue)[0] || String(finalValue || '').trim();
  if (!material) throw new Error('材料值为空');

  await ensureMaterialTableRow(row);

  if (!(await openSelect(row))) throw new Error('无法打开选择框');
  await waitForDropdownVisible(page);

  const materialTarget = await rematchLiveOption(page, attribute.name, material);
  let selectedMaterial = materialTarget;
  let clicked = await clickOption(page, materialTarget, true);
  if (!clicked) clicked = await clickOption(page, materialTarget, false);
  if (!clicked) {
    await typeSearchValue(row, page, materialTarget);
    await sleep(350);
    clicked = await clickOption(page, materialTarget, false);
  }

  if (!clicked) {
    await page.keyboard.press('Escape').catch(() => {});
    await openSelect(row);
    await sleep(250);
    selectedMaterial = await clickFirstVisibleOption(page);
  }

  if (!selectedMaterial) throw new Error(`材料选项中找不到 ${materialTarget}`);

  await fillMaterialRatio(row, '100');
  await sleep(200);

  const materialOk = await verifyRowContains(row, selectedMaterial);
  const ratioOk = await verifyMaterialRatio(row, '100');
  if (!materialOk || !ratioOk) {
    throw new Error(`材料表格填写后未检测到 ${selectedMaterial} / 100`);
  }

  await page.keyboard.press('Escape').catch(() => {});
  return { status: 'success' };
}

async function ensureMaterialTableRow(row) {
  const existing = await row.locator('tbody tr').count().catch(() => 0);
  if (existing > 0) return;

  const buttons = row.locator('button, .el-button');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = await button.innerText().catch(() => '');
    if (text && !/添加|新增|add/i.test(text)) continue;
    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 2500 });
      break;
    } catch (_) {
      continue;
    }
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await row.locator('tbody tr').count().catch(() => 0)) > 0) return;
    await sleep(150);
  }

  throw new Error('点击添加后未出现材料表格行');
}

async function fillMaterialRatio(row, value) {
  const inputs = row.locator('tbody tr input:not([type="hidden"]), input:not([type="hidden"])');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const isRatioInput = await input.evaluate((el) => {
      if (el.disabled || el.readOnly) return false;
      if (el.closest && el.closest('.el-select, .ant-select, [role="combobox"]')) return false;
      return true;
    }).catch(() => false);
    if (!isRatioInput) continue;
    await input.fill('');
    await input.fill(value);
    const actual = await input.inputValue().catch(() => '');
    if (String(actual).trim() === value) return;
  }
  throw new Error('找不到材料成分比例输入框');
}

async function verifyMaterialRatio(row, value) {
  const text = await row.innerText().catch(() => '');
  if (text.includes(value)) return true;
  const inputs = row.locator('input, textarea');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const actual = await inputs.nth(i).inputValue().catch(() => '');
    if (String(actual).trim() === value) return true;
  }
  return false;
}

async function getRow(page, attribute) {
  if (attribute._rowSelector) {
    const row = page.locator(attribute._rowSelector).first();
    if (await row.count()) return row;
  }

  const candidates = ['.jx-form-item', '.el-form-item', '.ant-form-item', '[class*="form-item"]', 'tr', 'li'];

  for (const selector of candidates) {
    const row = page.locator(selector).filter({ hasText: attribute.name }).first();
    if (await row.count().catch(() => 0)) return row;
  }
  throw new Error(`找不到属性行: ${attribute.name}`);
}

module.exports = {
  fillAttribute
};
