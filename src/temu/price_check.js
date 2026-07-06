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
// - 「查看并确认申报价格」链接：a[data-testid="beast-core-button-link"]，文本含“查看并确认申报价格”。
// - 点击后右侧弹出 drawer：[data-testid="bgb-pc-show-drawer-body"]，内含单个 SKC 的所有 SKU 明细。
// - drawer 内「操作」下拉是 SKC 级（rowspan 覆盖整组 SKU），默认值“申请调整更新申报价格”，
//   选项之一为“放弃调整申报价格”。决策用组内第一个 SKU 的原价/调整后价。
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

// 处理单个 SKC：点链接开 drawer → 决策操作下拉 → 全选 → 全部提交 → 关 drawer
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
    const select = tbody.locator('[data-testid="beast-core-select"]').first();
    const selectTr = select.locator('xpath=ancestor::tr').first();
    // 风险点：components_bigFont__QyHhb 是 CSS module 固定哈希类
    // 注意：tr 内 bigFont span 不止价格两列——“改价次数”列也是 bigFont（纯数字，如“1”）。
    //       按“文本含 ¥”过滤，只取真正的价格，避免把改价次数误读为原价。
    const allSpans = selectTr.locator('span.components_bigFont__QyHhb');
    const spanCount = await allSpans.count();
    const priceTexts = [];
    for (let i = 0; i < spanCount; i += 1) {
      const t = await allSpans.nth(i).innerText();
      if (t.includes('¥')) priceTexts.push(t);
    }
    const origin = parsePrice(priceTexts[0]);
    const adjusted = parsePrice(priceTexts[1]);
    if (Number.isNaN(origin) || Number.isNaN(adjusted)) {
      log(`读取价格失败（含¥价格 ${JSON.stringify(priceTexts)}），跳过决策（保留默认）`);
    } else {
      const target = origin / multiplier;
      const diff = Math.abs(target - adjusted);
      const verdict = diff < threshold ? '放弃调整' : '接受调整';
      log(`原价 ${origin} / 倍数 ${multiplier} = ${target.toFixed(2)}，调整后 ${adjusted}，差值 ${diff.toFixed(2)}（阈值 ${threshold}）→ ${verdict}`);
      if (diff < threshold) {
        await selectTemuOption(page, select, '放弃调整申报价格');
        // read-back：select 的 input value 应已变为“放弃调整申报价格”
        const val = await select
          .locator('input[data-testid="beast-core-select-htmlInput"]')
          .first()
          .inputValue();
        if (val.includes('放弃调整')) {
          abandoned = 1;
          log('已选择「放弃调整申报价格」');
        } else {
          console.error(`[Temu核价] ${skcKey}：read-back 未确认，当前 select 值="${val}"`);
        }
      }
    }

    // 4. 点「全部提交」。不需要先点表头全选——改过操作下拉的行会自动纳入提交，
    //    手动点全选反而会干扰默认选中状态（实测：点完全部提交后 drawer 会自动关闭）
    const submitBtn = drawer.locator('button').filter({ hasText: '全部提交' }).first();
    // 用原生 click（evaluate）而非 Playwright 鼠标 click：drawer footer 常在视口外，
    // 且会被主表分页 / drawer 自身 footer 遮挡，鼠标 click 会因 hit test 失败而 timeout；
    // 原生 .click() 直接触发组件 onClick，绕过遮挡与视口检查
    await submitBtn.evaluate((b) => b.click());
    log('已点击「全部提交」');

    // 5. 等 drawer 自动关闭。先等 8s 自动关；超时则用原生 click 关闭图标兜底。
    try {
      await page.waitForSelector('[data-testid="bgb-pc-show-drawer-body"]', { state: 'detached', timeout: 8000 });
      log('drawer 已自动关闭');
    } catch (_) {
      try {
        await drawer.locator('[data-testid="beast-core-icon-close"]').first().evaluate((el) => el.click());
        await page.waitForTimeout(500);
        log('drawer 未自动关闭，已手动关闭');
      } catch (e2) {
        log(`drawer 关闭失败：${e2.message || e2}`);
      }
    }
  } catch (err) {
    console.error(`[Temu核价] ${skcKey} 处理出错：${err.message || err}`);
    // 出错时尝试关闭 drawer，避免卡住后续 SKC（同样用原生 click 绕过遮挡）
    try {
      await drawer.locator('[data-testid="beast-core-icon-close"]').first().evaluate((el) => el.click());
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
