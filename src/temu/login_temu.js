require('dotenv').config();

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

// Temu 商家后台登录入口：复刻 src/login.js，把会话存到独立的 temu_state.json，
// 与妙手的 miaoshou_state.json 完全隔离。登录起始页直接用核价列表页（config.temu.priceCheckUrl）。
async function main() {
  await ensureProjectDirs();
  const config = loadConfig();
  const temu = config.temu || {};
  const loginUrl = String(temu.loginUrl || '').trim();
  if (!loginUrl) {
    console.error('[Temu登录] 未配置 temu.loginUrl，请在 config.json 填写 Temu 登录地址。');
    process.exitCode = 1;
    return;
  }
  const statePath = resolveRoot('storage', 'temu_state.json');

  console.log('[Temu登录] 正在打开 Temu 登录页...');
  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(getBrowserContextOptions(config));
  await applyAntiDetection(context);
  const page = await context.newPage();

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[Temu登录] 请在打开的浏览器中手动登录 Temu 商家后台。');
  console.log('[Temu登录] 登录后请手动进入核价页确认会话已建立（两个域名 cookie 都要拿到），再点继续。');
  await waitForEnter('[Temu登录] 登录完成并确认可访问核价页后，点击继续保存登录态');

  await context.storageState({ path: statePath });
  console.log(`[Temu登录] 登录态已保存到 ${statePath}`);
  await browser.close();
}

main().catch((error) => {
  console.error(`[Temu登录] 失败: ${error.stack || error.message}`);
  process.exitCode = 1;
});
