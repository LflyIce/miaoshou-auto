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
  assert.equal(result.specTwoTrimmed, 1);
  assert.equal(result.changed, true);
}

class FakePage {
  constructor() {
    this.specOne = new FakeSpecRow(this, 'spec-one', '\u89c4\u683c\u4e00', '\u989c\u8272', ['A', 'B', 'C', 'D', 'E']);
    this.specTwo = new FakeSpecRow(this, 'spec-two', '\u89c4\u683c\u4e8c', '\u989c\u8272', ['red', 'blue', 'green']);
    this.activeRow = null;
    this.dropdownOpen = false;
    this.keyboard = { press: async () => { this.dropdownOpen = false; } };
  }

  async evaluate(fn, labels) {
    assert.deepEqual(labels, ['\u89c4\u683c\u4e00', '\u89c4\u683c\u4e8c']);
    return {
      '\u89c4\u683c\u4e00': '[data-ms-sku-property="spec-one"]',
      '\u89c4\u683c\u4e8c': '[data-ms-sku-property="spec-two"]'
    };
  }

  locator(selector) {
    if (selector === '[data-ms-sku-property="spec-one"]') {
      return new FakeLocator(() => [this.specOne]);
    }
    if (selector === '[data-ms-sku-property="spec-two"]') {
      return new FakeLocator(() => [this.specTwo]);
    }
    if (selector.includes('el-select-dropdown__item')) {
      return new FakeLocator(() => this.dropdownOpen
        ? [new FakeOption(this, '\u989c\u8272'), new FakeOption(this, '\u578b\u53f7')]
        : []);
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

class FakeOption {
  constructor(page, text) {
    this.page = page;
    this.innerText = text;
    this.textContent = text;
    this.className = 'el-select-dropdown__item';
  }

  getBoundingClientRect() {
    return { width: 100, height: 24 };
  }

  async evaluate(fn, args) {
    const oldWindow = global.window;
    global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    try {
      return fn(this, args);
    } finally {
      global.window = oldWindow;
    }
  }

  async click() {
    if (this.page.activeRow) this.page.activeRow.title = this.innerText;
    this.page.dropdownOpen = false;
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

  async elementHandles() {
    return this.getItems();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
