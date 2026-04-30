const assert = require('assert');
const { chromium } = require('playwright');
const { scanRequiredAttributes } = require('../src/attribute_scanner');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.setContent(`
    <section>
      <h3>类别&属性</h3>
      <div class="category-attr-item">
        <div class="category-attr-item-name required">安装类型</div>
        <div class="category-attr-item-value">
          <div class="custom-select" role="combobox">
            <input readonly placeholder="请选择">
          </div>
        </div>
      </div>
    </section>
  `);

  const attrs = await scanRequiredAttributes(page);
  await browser.close();

  assert.deepStrictEqual(attrs.map((attr) => attr.name), ['安装类型']);
  assert.strictEqual(attrs[0].controlType, 'select');
  console.log('scanner custom required attr OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
