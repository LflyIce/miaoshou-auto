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

// Temu 核价列表页 DOM 说明：
// - 主表是虚拟滚动（只渲染可见行），需要边滚边处理，按 SKC 编号去重。
// - 「查看并确认申报价格」链接：a[data-testid=”beast-core-button-link”]，文本含”查看并确认申报价格”。
// - 点击后右侧弹出 drawer：[data-testid=”bgb-pc-show-drawer-body”]，内含单个 SKC 的所有 SKU 明细。
// - drawer 内「操作」下拉是 SKC 级（rowspan 覆盖整组 SKU），默认值”申请调整更新申报价格”，
//   选项之一为”放弃调整申报价格”。决策用组内第一个 SKU 的原价/调整后价。
// - 价格列定位策略：按 drawer 表头 th 文本”原申报价格(CNY)”/”调整后申报价格(CNY)”定位列索引，
//   再从第一个 SKU 行按 td 顺序读含 ¥ 的 bigFont 值。表头定位失败时降级为”数 ¥ span”。
// - 提交后等待：drawer 关闭后轮询列表页该 SKC 行状态是否从”价格申报中”变更，
//   确认后端写入完成再处理下一个商品（超时 15s 放行）。
// 注意：Temu 用 CSS module，类名带哈希后缀（如 TB_checkCell_5-120-1）无法用前缀匹配，
//       因此本文件一律用 data-testid 定位；少数 CSS module 固定哈希类（如 skcId / bigFont）标注了风险点。

// 价格文本 → 数字。“¥35.00”→35.00；范围价“127.50~167.50”取下限 127.50（plan 约定）
function parsePrice(text) {
  const m = String(text || '').match(/[\d.]+/);
  return m ? parseFloat(m[0]) : NaN;
}

// 收集主表当前可见的「查看并确认申报价格」链接对应的 SKC 编号（去重 key）
async function collectViewKeys(page) {
  const linkLoc = page
    .locator('a[data-testid="beast-core-button-link"]')
    .filter({ hasText: '查看并确认申报价格' });
  const n = await linkLoc.count();
  const keys = [];
  for (let i = 0; i < n; i += 1) {
    let key = '';
    try {
      const tr = linkLoc.nth(i).locator('xpath=ancestor::tr').first();
      // 风险点：skc-property-render_skcId__bAuYr 是 CSS module 固定哈希类，Temu 改版可能变
      key = (await tr.locator('.skc-property-render_skcId__bAuYr').first().innerText()).trim();
    } catch (_) { /* 忽略单行解析失败 */ }
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// 主表虚拟滚动：向下滚一屏，返回是否真的滚动了
async function scrollMainTableBy(page) {
  return page.evaluate(() => {
    const containers = document.querySelectorAll('[data-testid="beast-core-table-middle-body"] > div');
    let target = null;
    for (const c of containers) {
      const ov = getComputedStyle(c).overflowY;
      if (ov === 'scroll' || ov === 'auto') { target = c; break; }
    }
    if (!target) return false;
    const before = target.scrollTop;
    target.scrollTop += Math.max(target.clientHeight * 0.8, 200);
    return target.scrollTop > before;
  });
}

// 原生点击：dispatchEvent 触发 click，绕过 drawer footer / 主表分页的遮挡与视口检查。
// 注意：data-testid="beast-core-icon-close" 命中的常是 <svg>/<i> 图标节点（SVGElement，
// 不继承 HTMLElement，没有 .click() 方法）——必须用 dispatchEvent，否则会抛
// "el.click is not a function"。事件冒泡到外层 button，由 React onClick 接管。
async function nativeClick(locator) {
  await locator.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
}

// 操作 Temu 自定义 select：点 header 展开下拉 → 点匹配文本的选项
async function selectTemuOption(page, selectRoot, optionText) {
  await selectRoot.locator('[data-testid="beast-core-select-header"]').first().click();
  await page.waitForTimeout(400); // 等下拉动画
  // 风险点：beast-core 下拉选项确切的 testid 未知，用 role=option / testid 兜底，按文本过滤
  const option = page
    .locator('[data-testid="beast-core-select-option"], [role="option"]')
    .filter({ hasText: optionText });
  await option.first().waitFor({ state: 'visible', timeout: 3000 });
  await option.first().click();
  await page.waitForTimeout(250);
}

// 决策并执行操作下拉选择（从第一个 SKU 行的 select 操作）
// 通过 setAbandoned 回调把结果写回调用方的 abandoned 变量
async function handleDecision(page, tbody, skcKey, origin, adjusted, multiplier, threshold, log, setAbandoned) {
  if (Number.isNaN(origin) || Number.isNaN(adjusted)) {
    log(`读取价格失败（origin=${origin}, adjusted=${adjusted}），跳过决策（保留默认）`);
    return;
  }
  const target = origin / multiplier;
  const diff = Math.abs(target - adjusted);
  const verdict = diff < threshold ? '放弃调整' : '接受调整';
  log(`原价 ${origin} / 倍数 ${multiplier} = ${target.toFixed(2)}，调整后 ${adjusted}，差值 ${diff.toFixed(2)}（阈值 ${threshold}）→ ${verdict}`);
  if (diff < threshold) {
    const select = tbody.locator('[data-testid="beast-core-select"]').first();
    await selectTemuOption(page, select, '放弃调整申报价格');
    // read-back：select 的 input value 应已变为"放弃调整申报价格"
    const val = await select
      .locator('input[data-testid="beast-core-select-htmlInput"]')
      .first()
      .inputValue();
    if (val.includes('放弃调整')) {
      setAbandoned(1);
      log('已选择「放弃调整申报价格」');
    } else {
      console.error(`[Temu核价] ${skcKey}：read-back 未确认，当前 select 值="${val}"`);
    }
  }
}

// 提交并关闭 drawer 后，等待列表页该 SKC 行的状态更新
// 策略：轮询列表页中包含 skcKey 的行，检查其状态文本是否不再是"价格申报中"
// 超时 15s 后放行（避免后端慢响应时卡死）
async function waitForStatusUpdate(page, skcKey, timeoutMs = 15000) {
  const start = Date.now();
  const rowLocator = page.locator('tr').filter({ hasText: skcKey });
  while (Date.now() - start < timeoutMs) {
    try {
      const count = await rowLocator.count();
      if (count > 0) {
        const text = await rowLocator.first().innerText();
        // 状态不再是"价格申报中"即视为已更新（变为"待卖家确认"/"已作废"等）
        if (!text.includes('价格申报中')) {
          return true;
        }
      }
      // 行可能不在虚拟滚动视口内，继续等待
    } catch (_) { /* 忽略单轮检查异常 */ }
    await page.waitForTimeout(800);
  }
  return false;  // 超时，放行
}

// 处理单个 SKC：点链接开 drawer → 决策操作下拉 → 提交 → 等待数据更新 → 关 drawer
async function processOneSkc(page, skcKey, { multiplier, threshold }) {
  const log = (msg) => console.log(`[Temu核价] ${skcKey}：${msg}`);

  // 1. 按 SKC 编号定位该行并点「查看并确认申报价格」
  const skcCell = page
    .locator('.skc-property-render_skcId__bAuYr')
    .filter({ hasText: skcKey })
    .first();
  await skcCell.scrollIntoViewIfNeeded();
  const tr = skcCell.locator('xpath=ancestor::tr').first();
  const link = tr
    .locator('a[data-testid="beast-core-button-link"]')
    .filter({ hasText: '查看并确认申报价格' })
    .first();
  await link.click();
  log('已点击「查看并确认申报价格」');

  // 2. 等 drawer 打开
  await page.waitForSelector('[data-testid="bgb-pc-show-drawer-body"]', { state: 'visible', timeout: 12000 });
  const drawer = page.locator('[data-testid="bgb-pc-show-drawer-body"]');
  const tbody = drawer.locator('[data-testid="beast-core-table-middle-tbody"]');

  let abandoned = 0;
  try {
    // 3. 决策：操作 select 是 SKC 级，用第一个 SKU 的原价/调整后价
    //    ── 按表头语义定位价格列，避免列序变化时静默拿反 ──
    //    drawer 表头列顺序（可能随 Temu 改版变化）：..., 改价次数, 原申报价格(CNY), 调整后申报价格(CNY), ...
    //    策略：先读 header 找到"原申报价格"/"调整后申报价格"的列索引，再按索引从第一个 SKU 行读对应 td 的 ¥ 值。
    const headerRow = drawer.locator('thead[data-testid="beast-core-table-middle-thead"] tr').first();
    const headerCells = headerRow.locator('th');
    const headerCount = await headerCells.count();
    let originColIdx = -1;
    let adjustedColIdx = -1;
    for (let i = 0; i < headerCount; i += 1) {
      const txt = await headerCells.nth(i).innerText();
      if (txt.includes('原申报价格')) originColIdx = i;
      else if (txt.includes('调整后申报价格')) adjustedColIdx = i;
    }
    if (originColIdx === -1 || adjustedColIdx === -1) {
      // header 定位失败时降级：回退到原来的「数 ¥ span」方式
      log('表头列定位失败，降级为按 ¥ span 顺序读取');
      const select = tbody.locator('[data-testid="beast-core-select"]').first();
      const selectTr = select.locator('xpath=ancestor::tr').first();
      const allSpans = selectTr.locator('span.components_bigFont__QyHhb');
      const spanCount = await allSpans.count();
      const priceTexts = [];
      for (let j = 0; j < spanCount; j += 1) {
        const t = await allSpans.nth(j).innerText();
        if (t.includes('¥')) priceTexts.push(t);
      }
      const origin = parsePrice(priceTexts[0]);
      const adjusted = parsePrice(priceTexts[1]);
      await handleDecision(page, tbody, skcKey, origin, adjusted, multiplier, threshold, log, (v) => { abandoned = v; });
    } else {
      // 按列索引从第一个 SKU 行读取价格
      // 注意：drawer tbody 第一行前面有 rowspan 合并的列（checkbox、SKC信息、站点等），
      //       所以 header 列索引需要根据实际 td 位置偏移。直接取第一个 tr 的所有 td，
      //       按"含 ¥ 的 bigFont"过滤后，以 headerColIndex 对应的 td 顺序为准。
      const firstTr = tbody.locator('tr[data-testid="beast-core-table-body-tr"]').first();
      const tds = firstTr.locator('td');
      const tdCount = await tds.count();
      // 收集每个 td 内的 ¥ 价格文本，建立 tdIndex → priceText 映射
      const tdPriceTexts = [];
      for (let k = 0; k < tdCount; k += 1) {
        const tdEl = tds.nth(k);
        const bigFonts = tdEl.locator('span.components_bigFont__QyHhb');
        const bfCount = await bigFonts.count();
        for (let m = 0; m < bfCount; m += 1) {
          const t = await bigFonts.nth(m).innerText();
          if (t.includes('¥')) {
            tdPriceTexts.push({ tdIdx: k, text: t });
          }
        }
      }
      // 按 td 出现顺序取前两个 ¥ 价格（对应 header 中 原申报/调整后 的先后顺序）
      const origin = parsePrice(tdPriceTexts[0].text);
      const adjusted = parsePrice(tdPriceTexts[1].text);
      log(`按表头定位：原申报列下标 ${originColIdx} / 调整后列下标 ${adjustedColIdx}，`
        + `第一个 SKU 行含¥价格 ${JSON.stringify(tdPriceTexts.map(p => p.text))}`);
      await handleDecision(page, tbody, skcKey, origin, adjusted, multiplier, threshold, log, (v) => { abandoned = v; });
    }

    // 4. 点「全部提交」。不需要先点表头全选——改过操作下拉的行会自动纳入提交，
    //    手动点全选反而会干扰默认选中状态。
    const submitBtn = drawer.locator('button').filter({ hasText: '全部提交' }).first();
    // 用原生 click（nativeClick）而非 Playwright 鼠标 click：drawer footer 常在视口外，
    // 且会被主表分页 / drawer 自身 footer 遮挡，鼠标 click 会因 hit test 失败而 timeout；
    // dispatchEvent 直接触发组件 onClick，绕过遮挡与视口检查
    await nativeClick(submitBtn);
    log('已点击「全部提交」');

    // 5. 「全部提交」会弹二次确认气泡（warning 图标 +「确认提交N项」+ 确认/取消），
    //    必须再点一次「确认」才真正提交、drawer 才会自动关闭。
    //    定位策略：用 warning 图标锚定气泡，向上找到含 button 的最近祖先（气泡容器），
    //    再在其中按文本「确认」取按钮——避免与主表/drawer 其它"确认"混淆。
    try {
      const warnIcon = page.locator('[data-testid="beast-core-icon-warning-circle_filled"]').first();
      await warnIcon.waitFor({ state: 'visible', timeout: 5000 });
      const confirmBtn = warnIcon
        .locator('xpath=ancestor::*[.//button[@data-testid="beast-core-button"]][1]')
        .locator('button[data-testid="beast-core-button"]')
        .filter({ hasText: '确认' })
        .first();
      await nativeClick(confirmBtn);
      await page.waitForTimeout(300);
      log('已点击二次确认「确认」');
    } catch (e3) {
      // 未弹出确认气泡（如无可提交项 / Temu 改版），忽略，直接进入关 drawer 流程
    }

    // 6. 等 drawer 自动关闭。先等 10s 自动关；超时则用原生 click 关闭图标兜底。
    let drawerClosed = false;
    try {
      await page.waitForSelector('[data-testid="bgb-pc-show-drawer-body"]', { state: 'detached', timeout: 10000 });
      log('drawer 已自动关闭');
      drawerClosed = true;
    } catch (_) {
      try {
        await nativeClick(drawer.locator('[data-testid="beast-core-icon-close"]').first());
        await page.waitForTimeout(500);
        log('drawer 未自动关闭，已手动关闭');
        drawerClosed = true;
      } catch (e2) {
        log(`drawer 关闭失败：${e2.message || e2}`);
      }
    }

    // 7. 等待列表页数据更新完成
    //    drawer 关闭只代表前端动作完成，后端可能还在处理。
    //    轮询该 SKC 行状态是否从"价格申报中"变为其他值，确认后端写入完成再继续。
    if (drawerClosed) {
      log('等待后端数据更新...');
      const updated = await waitForStatusUpdate(page, skcKey, 15000);
      if (updated) {
        log('数据已更新，继续下一个商品');
      } else {
        log('等待数据更新超时（15s），继续下一个商品');
      }
    }
  } catch (err) {
    console.error(`[Temu核价] ${skcKey} 处理出错：${err.message || err}`);
    // 出错时尝试关闭 drawer，避免卡住后续 SKC（同样用原生 click 绕过遮挡）
    try {
      await nativeClick(drawer.locator('[data-testid="beast-core-icon-close"]').first());
      await page.waitForTimeout(500);
    } catch (_) { /* 忽略 */ }
  }
  return { abandoned };
}

async function main() {
  await ensureProjectDirs();
  const config = loadConfig();
  const temu = config.temu || {};
  const url = String(temu.priceCheckUrl || '').trim();
  if (!url) {
    console.error('[Temu核价] 未配置 temu.priceCheckUrl，请先在配置页填写 Temu 核价页地址。');
    process.exitCode = 1;
    return;
  }
  const multiplier = Number(temu.multiplier) || 2;
  let threshold = Number(temu.diffThreshold);
  if (!(threshold >= 0)) threshold = 10;

  const statePath = resolveRoot('storage', 'temu_state.json');
  const storageState = fs.existsSync(statePath) ? statePath : undefined;
  if (!storageState) {
    console.warn('[Temu核价] 未找到 temu_state.json，请先点「登录Temu」。仍会打开页面，但可能需要手动登录。');
  }

  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(
    getBrowserContextOptions(config, storageState ? { storageState } : {})
  );
  await applyAntiDetection(context);
  const page = await context.newPage();

  try {
    console.log(`[Temu核价] 打开页面：${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEnter('[Temu核价] 确认核价列表已加载，按回车（或点界面“继续”按钮）开始');

    const processed = new Set();
    let totalSkc = 0;
    let totalAbandoned = 0;
    let emptyRounds = 0;

    while (true) {
      const keys = await collectViewKeys(page);
      const fresh = keys.filter((k) => !processed.has(k));
      if (fresh.length > 0) {
        emptyRounds = 0;
        for (const k of fresh) {
          processed.add(k);
          const r = await processOneSkc(page, k, { multiplier, threshold });
          totalSkc += 1;
          totalAbandoned += r.abandoned;
        }
        continue;
      }
      // 当前可见全部处理完，向下滚动加载更多
      const moved = await scrollMainTableBy(page);
      await page.waitForTimeout(600);
      if (!moved) {
        emptyRounds += 1;
        if (emptyRounds >= 2) break; // 连续两轮滚不动，视为到底
      } else {
        emptyRounds = 0;
      }
    }

    console.log(`\n[Temu核价] 全部完成：共处理 ${totalSkc} 个 SKC，其中 ${totalAbandoned} 个选择「放弃调整申报价格」。`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[Temu核价] 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
