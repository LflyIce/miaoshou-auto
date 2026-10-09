const assert = require('node:assert/strict');

const { fillSkuProperties } = require('../src/sku_filler');

async function main() {
  const page = new FakePage();

  const result = await fillSkuProperties(page);

  assert.equal(page.specOne.title, '\u578b\u53f7');
  assert.equal(page.specTwo.title, '\u989c\u8272');
  assert.deepEqual(page.specOne.items, ['A', 'B', 'C']);
  assert.deepEqual(page.specTwo.items, ['red', 'blue']);
  assert.equal(result.specOneFound, true);
  assert.equal(result.specTwoFound, true);
  assert.equal(result.specOneTitleChanged, true);
  assert.equal(result.specOneTrimmed, 2);
  assert.equal(result.specTwoTitleChanged, false);
  assert.equal(result.specTwoTrimmed, 1);
  assert.equal(result.changed, true);

  // \u89c4\u683c\u4e8c\u540d\u79f0\u4e3a \u5c3a\u7801\uff1a\u6539\u9009\u5176\u4ed6\u540d\u79f0\uff08\u6392\u9664 \u5c3a\u7801 \u4e0e\u89c4\u683c\u4e00\u91cd\u540d\u7684 \u578b\u53f7\uff0c\u504f\u597d \u989c\u8272\uff09
  const page2 = new FakePage({ specTwoTitle: '\u5c3a\u7801', options: ['\u5c3a\u7801', '\u989c\u8272', '\u578b\u53f7'] });
  const result2 = await fillSkuProperties(page2);
  assert.equal(page2.specTwo.title, '\u989c\u8272');
  assert.equal(result2.specTwoTitleChanged, true);
  assert.equal(result2.specTwoRenamedFrom, '\u5c3a\u7801');
  assert.equal(result2.specTwoRenamedTo, '\u989c\u8272');
  assert.equal(result2.changed, true);

  // \u504f\u597d\u987a\u5e8f\uff1a\u4e0b\u62c9\u540c\u65f6\u6709 \u989c\u8272 \u548c \u5c3a\u5bf8 \u65f6\u4f18\u5148\u8bed\u4e49\u66f4\u63a5\u8fd1\u7684 \u5c3a\u5bf8
  const page3 = new FakePage({ specTwoTitle: '\u5c3a\u7801', options: ['\u5c3a\u7801', '\u989c\u8272', '\u5c3a\u5bf8', '\u578b\u53f7'] });
  const result3 = await fillSkuProperties(page3);
  assert.equal(page3.specTwo.title, '\u5c3a\u5bf8');
  assert.equal(result3.specTwoRenamedTo, '\u5c3a\u5bf8');
}

class FakePage {
  constructor({ specTwoTitle = '\u989c\u8272', options = ['\u989c\u8272', '\u578b\u53f7'] } = {}) {
    this.specOne = new FakeSpecRow(this, 'spec-one', '\u89c4\u683c\u4e00', '\u989c\u8272', ['A', 'B', 'C', 'D', 'E']);
    this.specTwo = new FakeSpecRow(this, 'spec-two', '\u89c4\u683c\u4e8c', specTwoTitle, ['red', 'blue', 'green']);
    this.options = options;
    this.activeRow = null;
    this.dropdownOpen = false;
    this.keyboard = { press: async () => { this.dropdownOpen = false; } };
  }

  async evaluate(fn, arg) {
    // \u89c4\u683c\u884c\u5b9a\u4f4d\uff08labels \u4e3a\u4e2d\u6587\uff09\u4e0e\u9009\u9879\u6536\u96c6/\u70b9\u51fb\uff08CSS \u9009\u62e9\u5668\uff09\u5206\u6d41\u6a21\u62df
    if (Array.isArray(arg) && arg.some((item) => item.includes('\u89c4\u683c'))) {
      assert.deepEqual(arg, ['\u89c4\u683c\u4e00', '\u89c4\u683c\u4e8c']);
      return {
        '\u89c4\u683c\u4e00': '[data-ms-sku-property="spec-one"]',
        '\u89c4\u683c\u4e8c': '[data-ms-sku-property="spec-two"]'
      };
    }
    // collectVisibleOptionTexts\uff1a\u5355\u6b21 evaluate \u8fd4\u56de\u53ef\u89c1\u9009\u9879\u6587\u672c
    if (Array.isArray(arg)) {
      return this.dropdownOpen ? [...this.options] : [];
    }
    // clickVisibleOption\uff1a\u5355\u6b21 evaluate \u70b9\u51fb\u7cbe\u786e\u5339\u914d\u6587\u672c\u7684\u9009\u9879
    if (arg && typeof arg === 'object' && 'target' in arg) {
      if (!this.dropdownOpen || !this.options.includes(arg.target)) return false;
      if (this.activeRow) this.activeRow.title = arg.target;
      this.dropdownOpen = false;
      return true;
    }
    return undefined;
  }

  locator(selector) {
    if (selector === '[data-ms-sku-property="spec-one"]') {
      return new FakeLocator(() => [this.specOne]);
    }
    if (selector === '[data-ms-sku-property="spec-two"]') {
      return new FakeLocator(() => [this.specTwo]);
    }
    return new FakeLocator(() => []);
  }
}

class FakeSpecRow {
  constructor(page, key, label, title, items) {
    this.page = page;
    this.key = key;
    this.label = label;
    this.title = title;
    this.items = items;
  }

  locator(selector) {
    if (selector.includes('.el-select') || selector.includes('[role="combobox"]') || selector.includes('.el-input')) {
      return new FakeLocator(() => [new FakeTitleSelect(this)]);
    }
    if (selector.includes('.sku-property-title input') || selector.includes('.sku-property-title textarea')) {
      return new FakeLocator(() => [new FakeTitleInput(this)]);
    }
    if (selector.includes('.spec-box-container .spec-item')) {
      return new FakeLocator(() => this.items.map((_, index) => new FakeSpecItem(this, index)));
    }
    return new FakeLocator(() => []);
  }
}

class FakeSpecItem {
  constructor(row, index) {
    this.row = row;
    this.index = index;
  }

  locator(selector) {
    if (selector.includes('delete')) {
      return new FakeLocator(() => [new FakeDeleteIcon(this.row, this.index)]);
    }
    return new FakeLocator(() => []);
  }
}

class FakeTitleInput {
  constructor(row) {
    this.row = row;
  }

  async inputValue() {
    return this.row.title;
  }
}

class FakeTitleSelect {
  constructor(row) {
    this.row = row;
  }

  async click() {
    this.row.page.activeRow = this.row;
    this.row.page.dropdownOpen = true;
  }
}

class FakeDeleteIcon {
  constructor(row, index) {
    this.row = row;
    this.index = index;
  }

  async click() {
    this.row.items.splice(this.index, 1);
  }
}

class FakeLocator {
  constructor(getItems) {
    this.getItems = getItems;
  }

  first() {
    return new FakeLocator(() => this.getItems().slice(0, 1));
  }

  nth(index) {
    return new FakeLocator(() => this.getItems().slice(index, index + 1));
  }

  locator(selector) {
    const item = this.getItems()[0];
    return item ? item.locator(selector) : new FakeLocator(() => []);
  }

  async count() {
    return this.getItems().length;
  }

  async scrollIntoViewIfNeeded() {}

  async click() {
    const item = this.getItems()[0];
    if (!item) throw new Error('No fake element to click');
    return item.click();
  }

  async inputValue() {
    const item = this.getItems()[0];
    if (!item) return '';
    return item.inputValue();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
