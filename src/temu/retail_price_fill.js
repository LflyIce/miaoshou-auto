require('dotenv').config();

const fs = require('fs');
const { chromium } = require('playwright');
const {
  ensureProjectDirs,
  applyAntiDetection,
  getBrowserContextOptions,
  getBrowserLaunchOptions,
  loadConfig,
  resolveRoot,
  waitForEnter
} = require('../utils');

// Temu 建议零售价填写页 DOM 说明：
// - 含表格的抽屉由使用者在 goods/list 页手动打开（同标签页右侧弹出，可能懒加载较慢，
//   也可能嵌在 iframe 里）。脚本会在浏览器上下文的所有标签页 + 各自 iframe 里轮询检测
//   输入框，不假设它在哪个 page/frame，检测不到就暂停等人工确认后重试。
// - 行结构 tr[data-testid="beast-core-table-body-tr"]：
//   [勾选框, 商品/SKC(可能 rowspan 覆盖同组多行), SKU, 日常价格范围, 同款品市场价参考, 建议零售价]。
//   建议零售价输入框 = 行内 input[data-testid="beast-core-inputNumber-htmlInput"]（单位 人民币元）。
// - 任务：把「日常价格范围」的下限（文本第一个数字，如“34.07元 ~ 34.07元”→34.07）填入同行
//   建议零售价输入框，并勾选该行复选框（label[data-testid="beast-core-checkbox"]，
//   勾选态反映在 data-checked="true"）。
// - 流程（按页提交）：填完当前页所有行并勾选 → 点「提交已选(N项)」按钮 → 必现确认 Modal
//   （beast-core-modal-body：「确认提交？N项商品已补充建议零售价」），点其中「确认」
//   → 等提交成功（成功后 N 归零）→ 表格可能刷新（已提交行可能消失），重扫当前页直到没有新行
//   → 点「下一页」→ 循环直到最后一页。提交结果未确认时暂停等人工处理，不盲目继续。
// - 「日常价格范围」td 相对位置固定：输入框所在 td 往前第 2 个 td（前 1 个是同款品市场价参考），
//   与商品/SKC 列的 rowspan 无关。
// - 分页（实测 DOM）：li[data-testid="beast-core-pagination-next"/"-prev"] 是纯图标按钮（无文本无
//   aria-label），禁用态为 class 含 PGT_disabled；当前页码 li 的 class 含 pagerItemActive。
// - 表格可能虚拟滚动：每页内边滚边填。
// 注意：与 price_check.js 相同，Temu 用 CSS module 哈希类名，一律用 data-testid / 结构定位
//       （class 仅用局部名子串匹配，如 [class*="pagerItemActive"]）。

// 价格文本 → { raw, value }。取文本里第一个数字（范围价下限）：“34.07元 ~ 34.07元”→"34.07"/34.07
function parseFirstPrice(text) {
  const m = String(text || '').match(/[\d.]+/);
  if (!m) return null;
  const value = parseFloat(m[0]);
  return Number.isFinite(value) ? { raw: m[0], value } : null;
}

// 原生点击：dispatchEvent 触发 click，绕过分页/sticky footer 的遮挡与视口检查（同 price_check.js）
async function nativeClick(locator) {
  await locator.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
}

// 在浏览器上下文的所有标签页（含后续新开的）及各自 iframe 内轮询查找建议零售价输入框。
// 返回 { page, frame }；超时未找到返回 null（调用方再次暂停等人工确认后重试，不直接失败退出）。
async function findInputTarget(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pg of context.pages()) {
      for (const frame of pg.frames()) {
        try {
          if (await frame.locator('input[data-testid="beast-core-inputNumber-htmlInput"]').count() > 0) {
            return { page: pg, frame };
          }
        } catch (_) { /* frame 可能正在跳转/销毁，跳过 */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

// 当前激活页码：分页条中 class 含 pagerItemActive 的 li（CSS module 哈希类，用 [class*=] 子串匹配）
async function getActivePage(scope) {
  const active = scope.locator('li[class*="pagerItemActive"]').first();
  if ((await active.count()) === 0) return null;
  const t = ((await active.innerText().catch(() => '')) || '').trim();
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

// 等当前页码变成 expected（点「下一页」后确认翻页生效）。超时返回 null。
async function waitActivePage(scope, expected, timeoutMs, page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await getActivePage(scope);
    if (n === expected) return n;
    await page.waitForTimeout(300);
  }
  return null;
}

// 查找分页 prev/next 按钮。实测 testid：li[data-testid="beast-core-pagination-next"/"-prev"]，
// 纯图标无文本无 aria-label。兜底（防 Temu 改版）：aria-label/title 精确命中、精确文本取最内层。
async function findPagerButton(scope, kind) {
  const exact = scope.locator(`li[data-testid="beast-core-pagination-${kind}"]`);
  if (await exact.count()) return exact.first();
  const label = kind === 'next' ? '下一页' : '上一页';
  const byAttr = scope.locator(`[aria-label="${label}"], [title="${label}"]`);
  if (await byAttr.count()) return byAttr.first();
  const byText = scope
    .locator('[data-testid*="pagination"], li, button, [role="button"]')
    .filter({ hasText: label });
  const n = await byText.count();
  if (n > 0) return byText.last();
  return null;
}

// 分页按钮是否禁用（最后一页时 next 置灰）：检查自身及向上两层祖先的 disabled 属性 /
// aria-disabled="true" / class 含 disabled（PGT_disabled_5-123-0 命中）
async function isPagerDisabled(locator) {
  return locator.evaluate((el) => {
    let cur = el;
    for (let i = 0; cur && i < 3; i += 1) {
      if (cur.disabled) return true;
      if (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true') return true;
      if (/disabled/i.test(String(cur.className || ''))) return true;
      cur = cur.parentElement;
    }
    return false;
  });
}

// scope 内表格滚动：dir='down' 向下滚一屏（虚拟滚动加载更多行），dir='top' 回到顶部（翻页后复位）。
// 返回是否真的滚动了。
async function scrollTableBy(scope, dir) {
  return scope.evaluate((root, direction) => {
    const containers = root.querySelectorAll('[data-testid="beast-core-table-middle-body"] > div');
    let target = null;
    for (const c of containers) {
      const ov = getComputedStyle(c).overflowY;
      if (ov === 'scroll' || ov === 'auto') { target = c; break; }
    }
    if (!target) return false;
    const before = target.scrollTop;
    if (direction === 'top') {
      target.scrollTop = 0;
    } else {
      target.scrollTop += Math.max(target.clientHeight * 0.8, 200);
    }
    return target.scrollTop !== before;
  }, dir);
}

// 勾选行首复选框：label[data-testid="beast-core-checkbox"] 的 data-checked 会翻转为 "true"。
// 常规 click 失败（遮挡）时用原生点击兜底（label → 内部 input 逐级兜底）。
async function checkRowCheckbox(row, key) {
  const cb = row.locator('label[data-testid="beast-core-checkbox"]').first();
  if ((await cb.count()) === 0) {
    console.warn(`[Temu零售价] ${key}：未找到行复选框，无法勾选`);
    return false;
  }
  if ((await cb.getAttribute('data-checked')) === 'true') return true; // 已勾选
  try {
    await cb.click({ timeout: 3000 });
  } catch (_) {
    try { await nativeClick(cb); } catch (_) { /* 继续用 input 兜底 */ }
  }
  await cb.waitFor({ state: 'attached', timeout: 1000 }).catch(() => {});
  if ((await cb.getAttribute('data-checked').catch(() => '')) === 'true') return true;
  try {
    await nativeClick(cb.locator('input[type="checkbox"]').first());
    await new Promise((r) => setTimeout(r, 200));
  } catch (_) { /* 忽略 */ }
  const ok = (await cb.getAttribute('data-checked').catch(() => '')) === 'true';
  if (!ok) console.warn(`[Temu零售价] ${key}：复选框勾选未生效（data-checked 仍为 false）`);
  return ok;
}

// 单个输入框填写：fill → blur 提交 → read-back 校验；失败时键盘逐字输入兜底一次。
// 只会被调用在空输入框上（调用方已过滤非空），无需先清空。返回是否填写成功。
async function fillOnePrice(page, input, rawPrice, key, stats) {
  await input.scrollIntoViewIfNeeded();
  await input.fill(rawPrice);
  // blur 触发 InputNumber 失焦格式化/提交（React onBlur 监听冒泡的 focusout）
  await input.evaluate((el) => el.blur());
  let val = ((await input.inputValue()) || '').trim();
  if (parseFloat(val) === parseFloat(rawPrice)) {
    stats.filled += 1;
    console.log(`[Temu零售价] ${key}：已填 ${rawPrice}（日常价格范围下限）`);
    return true;
  }
  // 兜底：部分组件只认真实键盘事件
  await input.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(rawPrice, { delay: 20 });
  await input.evaluate((el) => el.blur());
  val = ((await input.inputValue()) || '').trim();
  if (parseFloat(val) === parseFloat(rawPrice)) {
    stats.filled += 1;
    console.log(`[Temu零售价] ${key}：已填 ${rawPrice}（键盘兜底）`);
    return true;
  }
  stats.failed += 1;
  console.error(`[Temu零售价] ${key}：read-back 校验失败，期望 ${rawPrice}，实际 "${val}"，跳过勾选，请人工处理`);
  return false;
}

// 填写当前可见的行：空框填入「日常价格范围」下限并勾选该行；已有值的行也勾选（补勾）。
// handled 记录本轮运行已纳入提交的行 key；返回本轮新纳入勾选的行数（0 = 当前可见没有需要处理的行）。
async function fillVisibleRows(scope, page, stats, handled) {
  const rows = scope.locator('tr[data-testid="beast-core-table-body-tr"]');
  const n = await rows.count();
  let newlyHandled = 0;
  for (let i = 0; i < n; i += 1) {
    const row = rows.nth(i);
    try {
      const input = row.locator('input[data-testid="beast-core-inputNumber-htmlInput"]').first();
      if ((await input.count()) === 0) continue; // 无输入框的行

      // 行标识（仅用于日志与统计去重）：优先 form-item 的 id（= SKU ID），兜底行内 “SKU ID：xxx” 文本
      let skuId = '';
      try {
        skuId = (await row.locator('[data-testid="beast-core-form-item"]').first().getAttribute('id')) || '';
      } catch (_) { /* 忽略 */ }
      if (!skuId) {
        const m = (await row.innerText()).match(/SKU\s*ID[：:]\s*(\d+)/);
        if (m) skuId = m[1];
      }
      const key = skuId || `第${i + 1}行`;

      const current = ((await input.inputValue()) || '').trim();
      if (current) {
        stats.skipped.add(key); // 已有值：不覆盖
      } else {
        // 「日常价格范围」td = 输入框所在 td 的前第 2 个 td（前 1 个是同款品市场价参考）
        const priceTd = input.locator('xpath=ancestor::td[1]/preceding-sibling::td[2]');
        const priceText = ((await priceTd.innerText()) || '').trim();
        const price = parseFirstPrice(priceText);
        if (!price) {
          if (!stats.noPrice.has(key)) {
            stats.noPrice.add(key);
            console.warn(`[Temu零售价] ${key}：读取「日常价格范围」失败（${JSON.stringify(priceText)}），跳过`);
          }
          continue;
        }
        const ok = await fillOnePrice(page, input, price.raw, key, stats);
        if (!ok) continue; // 填写失败不勾选，避免提交坏值
      }

      // 填写成功（或本来就有值）→ 勾选该行
      if (handled.has(key)) continue;
      if (await checkRowCheckbox(row, key)) {
        handled.add(key);
        stats.checked += 1;
        newlyHandled += 1;
      }
    } catch (err) {
      stats.failed += 1;
      console.error(`[Temu零售价] 第 ${i + 1} 行处理出错：${err.message || err}`);
    }
  }
  return newlyHandled;
}

// 处理当前页：填可见行 → 向下滚 → 直到连续两轮滚不动（当前页到底）。返回本页新纳入勾选的行数。
async function processCurrentPage(scope, page, stats, handled) {
  let newlyHandled = 0;
  let stuckRounds = 0;
  while (true) {
    newlyHandled += await fillVisibleRows(scope, page, stats, handled);
    const moved = await scrollTableBy(scope, 'down');
    await page.waitForTimeout(500);
    if (!moved) {
      stuckRounds += 1;
      if (stuckRounds >= 2) break;
    } else {
      stuckRounds = 0;
    }
  }
  return newlyHandled;
}

// 点「提交已选(N项)」并等提交成功。成功信号（任一）：页面出现成功文案 toast，
// 或按钮计数归零（勾选被清空）。可能弹二次确认气泡，有则点「确认」。返回 { ok }。
async function submitAndWaitResult(scope, bodyScope, page) {
  const btn = scope.locator('button').filter({ hasText: '提交已选' }).first();
  if ((await btn.count()) === 0) {
    console.error('[Temu零售价] 未找到「提交已选」按钮');
    return { ok: false };
  }
  if (await btn.isDisabled()) {
    console.warn('[Temu零售价] 「提交已选」按钮处于禁用状态（可能没有勾选任何行），跳过提交');
    return { ok: false };
  }
  const label = ((await btn.innerText()) || '').replace(/\s+/g, ' ').trim();
  await nativeClick(btn); // sticky footer 常遮挡，用原生点击
  console.log(`[Temu零售价] 已点击「${label}」，等待提交结果…`);

  // 提交后必现确认 Modal（实测 DOM）：[data-testid="beast-core-modal-body"]，warning 图标 +
  // 「确认提交？N项商品已补充建议零售价，确认提交？」+ 确认/取消。Modal 渲染在 body 级
  // portal（不在 drawer scope 里），所以在 bodyScope 里找；「确认」用精确文本，避免误点「取消」。
  const modal = bodyScope.locator('[data-testid="beast-core-modal-body"]').first();
  try {
    await modal.waitFor({ state: 'visible', timeout: 8000 });
    const modalText = ((await modal.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    console.log(`[Temu零售价] 出现确认弹窗：${modalText}`);
    const confirmBtn = modal.getByText('确认', { exact: true }).first();
    await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
    await nativeClick(confirmBtn);
    console.log('[Temu零售价] 已点击确认弹窗「确认」');
  } catch (e) {
    console.warn('[Temu零售价] 未出现确认弹窗（8 秒超时），继续等待提交结果。');
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    // ① 成功文案 toast
    try {
      const toast = bodyScope.getByText(/提交成功|保存成功|操作成功/).first();
      if (await toast.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[Temu零售价] 提交成功（检测到成功提示）');
        return { ok: true };
      }
    } catch (_) { /* 忽略 */ }
    // ② 勾选被清空：按钮计数归零
    try {
      const txt = ((await btn.innerText()) || '').trim();
      const m = txt.match(/提交已选\s*\(\s*(\d+)\s*项/);
      if (m && Number(m[1]) === 0) {
        console.log('[Temu零售价] 提交成功（勾选已清空）');
        return { ok: true };
      }
    } catch (_) { /* 按钮可能正在重渲染 */ }
    await page.waitForTimeout(500);
  }
  console.error('[Temu零售价] 20 秒内未确认提交结果（无成功提示，勾选也未清空）');
  return { ok: false };
}

async function main() {
  await ensureProjectDirs();
  const config = loadConfig();
  const temu = config.temu || {};
  const url = String(temu.retailPriceUrl || '').trim();
  if (!url) {
    console.error('[Temu零售价] 未配置 temu.retailPriceUrl，请先在配置页填写「Temu 零售价页 URL」。');
    process.exitCode = 1;
    return;
  }

  const statePath = resolveRoot('storage', 'temu_state.json');
  const storageState = fs.existsSync(statePath) ? statePath : undefined;
  if (!storageState) {
    console.warn('[Temu零售价] 未找到 temu_state.json，请先点「登录Temu」。仍会打开页面，但可能需要手动登录。');
  }

  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(
    getBrowserContextOptions(config, storageState ? { storageState } : {})
  );
  await applyAntiDetection(context);
  const startPage = await context.newPage();

  try {
    console.log(`[Temu零售价] 打开页面：${url}`);
    await startPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEnter('[Temu零售价] 请打开右侧含「建议零售价」表格的抽屉，确认表格行已显示后按回车（或点界面“继续”按钮）开始');

    // 轮询等待建议零售价输入框出现：抽屉表格可能懒加载较慢，或嵌在 iframe 里，
    // 因此扫描所有标签页 + iframe。找不到不报错退出，而是再次暂停等回车重试。
    console.log('[Temu零售价] 正在检测建议零售价输入框（所有标签页 + iframe），最多等 15 秒…');
    let target = await findInputTarget(context, 15000);
    while (!target) {
      console.warn('[Temu零售价] 15 秒内未检测到建议零售价输入框（beast-core-inputNumber-htmlInput）。');
      await waitForEnter('[Temu零售价] 请确认抽屉中的表格行已完全显示（可关闭后重新打开抽屉），再按回车（或点界面“继续”按钮）重试');
      console.log('[Temu零售价] 正在重新检测建议零售价输入框，最多等 15 秒…');
      target = await findInputTarget(context, 15000);
    }
    // 后续所有操作（等待/键盘输入/滚动）都切换到表格所在标签页
    const page = target.page;
    console.log('[Temu零售价] 已检测到建议零售价输入框，开始处理。');

    // 工作范围：优先 drawer 容器（该页面若用抽屉组件）；否则退回输入框所在的整个 frame
    const bodyScope = target.frame.locator('body');
    let scope = target.frame.locator('[data-testid="bgb-pc-show-drawer-body"]');
    if ((await scope.count()) === 0) {
      scope = bodyScope;
    }

    const stats = { filled: 0, checked: 0, failed: 0, submits: 0, submitFails: 0, skipped: new Set(), noPrice: new Set(), pages: 0 };
    const handled = new Set(); // 已勾选纳入提交的行 key
    const MAX_PAGES = 300;     // 防御：分页禁用态识别失效时不至于死循环

    // 逐页处理：填当前页 + 勾选 → 提交 → 等成功 → 表格刷新后重扫当前页（已提交行可能消失、
    // 列表前移出现新行），直到当前页没有新行 → 点「下一页」→ 直到最后一页
    let pageNo = (await getActivePage(scope)) || 1;
    while (true) {
      stats.pages += 1;
      console.log(`[Temu零售价] —— 第 ${pageNo} 页 ——`);
      // 提交后表格会刷新，当前页可能出现新行/空框，最多重扫 5 轮
      let rounds = 0;
      while (rounds < 5) {
        rounds += 1;
        const newlyHandled = await processCurrentPage(scope, page, stats, handled);
        if (newlyHandled === 0) break; // 当前页没有需要处理的行了
        const result = await submitAndWaitResult(scope, bodyScope, page);
        if (result.ok) {
          stats.submits += 1;
        } else {
          stats.submitFails += 1;
          // 提交结果未确认：不盲目继续，暂停等人工确认/处理后再走
          await waitForEnter('[Temu零售价] 本次提交结果未能确认。请在浏览器中人工确认是否提交成功（失败请手动处理后），按回车（或点界面“继续”按钮）继续');
        }
        await page.waitForTimeout(1000); // 等表格刷新
        await scrollTableBy(scope, 'top');
        await page.waitForTimeout(300);
      }

      const next = await findPagerButton(scope, 'next');
      if (!next) {
        console.log('[Temu零售价] 未找到「下一页」按钮，视为最后一页。');
        break;
      }
      if (await isPagerDisabled(next)) {
        console.log('[Temu零售价] 「下一页」已禁用，已是最后一页。');
        break;
      }
      if (stats.pages >= MAX_PAGES) {
        console.error(`[Temu零售价] 已处理超过 ${MAX_PAGES} 页，强制停止，请人工检查。`);
        break;
      }
      await nativeClick(next);
      const changed = await waitActivePage(scope, pageNo + 1, 8000, page);
      if (changed == null) {
        console.warn('[Temu零售价] 翻页后未确认页码变化（8 秒超时），按页码 +1 继续处理。');
      }
      pageNo = changed != null ? changed : pageNo + 1;
      await scrollTableBy(scope, 'top');
      await page.waitForTimeout(500);
    }

    console.log(
      `\n[Temu零售价] 全部完成：翻 ${stats.pages} 页，填写 ${stats.filled} 个 SKU，勾选 ${stats.checked} 行，` +
      `成功提交 ${stats.submits} 次${stats.submitFails ? `，未确认提交 ${stats.submitFails} 次（请人工复核）` : ''}。` +
      `已有值未覆盖 ${stats.skipped.size} 个，读价失败 ${stats.noPrice.size} 个，填写失败 ${stats.failed} 个。`
    );
    await waitForEnter('[Temu零售价] 如有未确认/失败的提交请人工处理。全部处理完后，按回车（或点界面“继续”按钮）关闭浏览器');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[Temu零售价] 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
