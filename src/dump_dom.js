/**
 * DOM 导出工具：复用已保存的登录态打开页面，手动确认后导出指定选择器的 HTML。
 *
 * 用法:
 *   node src/dump_dom.js [url] [css选择器] [--wait-ms 毫秒]
 *   url 缺省用 config.productEditUrl || startUrl；选择器缺省导出整个 body
 *
 * 示例:
 *   node src/dump_dom.js                                     # 打开默认页，回车后导出整个 body
 *   node src/dump_dom.js "" ".jx-dialog__headerbtn"          # 打开默认页，回车后导出匹配元素
 *   node src/dump_dom.js "https://..." "button" --wait-ms 6000   # 免回车，加载后等 6s 自动导出
 *
 * 输出: data/doms/dom-<时间戳>.html
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  loadConfig,
  resolveRoot,
  ensureProjectDirs,
  getBrowserLaunchOptions,
  getBrowserContextOptions,
  waitForEnter,
  nowForFile
} = require('./utils');

async function main() {
  await ensureProjectDirs();
  const config = loadConfig();

  const args = process.argv.slice(2);
  const waitIdx = args.indexOf('--wait-ms');
  let waitMs = 0;
  if (waitIdx >= 0) {
    waitMs = Number(args[waitIdx + 1]) || 0;
    args.splice(waitIdx, 2);
  }
  const targetUrl = args[0] || config.productEditUrl || config.startUrl;
  let selector = args[1] || 'body';

  const statePath = resolveRoot('storage', 'miaoshou_state.json');
  const storageState = fs.existsSync(statePath) ? statePath : undefined;
  if (!storageState) console.warn('[DOM] 未找到登录态，如页面跳到登录页请先 npm run login');

  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(getBrowserContextOptions(config, storageState ? { storageState } : {}));
  const page = await context.newPage();

  console.log(`[DOM] 打开页面: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  } else {
    await waitForEnter('[DOM] 请在浏览器中把页面调整到目标状态（切换模块/展开下拉/打开弹窗等），然后按回车导出');
  }

  const count = await page.locator(selector).count().catch(() => 0);
  if (!count) {
    console.warn(`[DOM] 未匹配到元素: ${selector}，改为导出整个 body`);
    selector = 'body';
  }
  const html = await page.locator(selector).evaluateAll((nodes) =>
    nodes.map((n, i) => `<!-- ===== 匹配 ${i + 1} ===== -->\n${n.outerHTML}`).join('\n\n')
  );

  const outDir = resolveRoot('data', 'doms');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `dom-${nowForFile()}.html`);
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`[DOM] 已导出 ${html ? count || 1 : 0} 个匹配 → ${outFile} (${html.length} 字符)`);
  await browser.close();
}

main().catch((e) => {
  console.error(`[DOM] 失败: ${e.message}`);
  process.exit(1);
});
