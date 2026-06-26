require('dotenv').config();

const { chromium } = require('playwright');
const { ensureProjectDirs, getBrowserContextOptions, getBrowserLaunchOptions, loadConfig, resolveRoot, waitForEnter } = require('./utils');

async function main() {
  await ensureProjectDirs();
  const config = loadConfig();
  const statePath = resolveRoot('storage', 'miaoshou_state.json');

  console.log('[登录] 正在打开妙手ERP登录页...');
  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(getBrowserContextOptions(config));
  const page = await context.newPage();

  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[登录] 请在打开的浏览器中手动登录妙手ERP。');
  await waitForEnter('[登录] 登录完成并确认页面可用后，点击继续保存登录态');

  await context.storageState({ path: statePath });
  console.log(`[登录] 登录态已保存到 ${statePath}`);
  await browser.close();
}

main().catch((error) => {
  console.error(`[登录] 失败: ${error.stack || error.message}`);
  process.exitCode = 1;
});
