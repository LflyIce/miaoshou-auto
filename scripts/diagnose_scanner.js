const fs = require('fs');
const { chromium } = require('playwright');
const { scanRequiredAttributes } = require('../src/attribute_scanner');
const { activateManualPage } = require('../src/page_selector');
const { getBrowserContextOptions, getBrowserLaunchOptions, loadConfig, resolveRoot, waitForEnter } = require('../src/utils');

(async () => {
  const config = loadConfig();
  const statePath = resolveRoot('storage', 'miaoshou_state.json');
  const storageState = fs.existsSync(statePath) ? statePath : undefined;
  const targetUrl = process.argv[2] || config.productEditUrl || config.startUrl;

  const browser = await chromium.launch({
    ...getBrowserLaunchOptions(config),
    headless: true
  });
  const context = await browser.newContext(getBrowserContextOptions(config, storageState ? { storageState } : {}));
  let page = await context.newPage();

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (process.argv.includes('--manual')) {
    await waitForEnter('[诊断] 请在浏览器中打开右侧商品编辑面板并滚动到“类别&属性”，然后按回车采集 DOM');
    page = await activateManualPage(context, page);
  }
  await page.waitForTimeout(3000);

  const domSummary = await page.evaluate(() => {
    function textOf(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const attrItems = Array.from(document.querySelectorAll('.category-attr-item, [class*="category"][class*="attr"], [class*="attr"][class*="item"]'));
    const requiredNames = Array.from(document.querySelectorAll('.category-attr-item-name.required, [class*="attr-item-name"].required, [class*="required"], .required'));
    const controls = Array.from(document.querySelectorAll(
      'textarea, input:not([type="hidden"]), select, .el-select, .ant-select, [role="combobox"], [contenteditable="true"], .el-cascader, .ant-cascader'
    ));
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,label,span,div,.title,[class*="title"],[class*="header"]'))
      .filter((el) => visible(el) && /类别|类目|属性|category|attr/i.test(textOf(el)))
      .slice(0, 20)
      .map((el) => ({
        tag: el.tagName,
        className: String(el.className || ''),
        text: textOf(el).slice(0, 120),
        visible: visible(el)
      }));

    return {
      url: location.href,
      title: document.title,
      bodyTextStart: textOf(document.body).slice(0, 500),
      counts: {
        categoryAttrItem: attrItems.length,
        requiredNames: requiredNames.length,
        controls: controls.length
      },
      sampleAttrItems: attrItems.slice(0, 10).map((el) => ({
        className: String(el.className || ''),
        text: textOf(el).slice(0, 200),
        visible: visible(el),
        hasControl: Boolean(el.querySelector('textarea, input:not([type="hidden"]), select, .el-select, .ant-select, [role="combobox"], [contenteditable="true"], .el-cascader, .ant-cascader'))
      })),
      sampleRequired: requiredNames.slice(0, 20).map((el) => ({
        tag: el.tagName,
        className: String(el.className || ''),
        text: textOf(el).slice(0, 120),
        visible: visible(el),
        parentClass: String(el.parentElement && el.parentElement.className || ''),
        closestWithControl: (() => {
          let current = el.parentElement;
          let depth = 0;
          while (current && current !== document.body && depth < 8) {
            const hasControl = Boolean(current.querySelector('textarea, input:not([type="hidden"]), select, .el-select, .ant-select, [role="combobox"], [contenteditable="true"], .el-cascader, .ant-cascader, [class*="select"]'));
            if (hasControl) {
              return {
                depth,
                tag: current.tagName,
                className: String(current.className || ''),
                text: textOf(current).slice(0, 240)
              };
            }
            current = current.parentElement;
            depth += 1;
          }
          return null;
        })()
      })),
      headings
    };
  });

  const scanned = await scanRequiredAttributes(page);
  console.log(JSON.stringify({ domSummary, scanned }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
