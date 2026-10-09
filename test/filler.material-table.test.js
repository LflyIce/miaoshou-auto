const assert = require('node:assert/strict');

const { fillAttribute } = require('../src/filler');

class FakePage {
  constructor() {
    this.row = new FakeRow(this);
    this.dropdownOpen = false;
    this.optionTexts = ['\u5851\u6599', '\u91d1\u5c5e'];
    this.selectedMaterial = '';
    this.ratio = '';
    this.keyboard = { press: async () => {} };
  }

  locator(selector) {
    if (selector === '#material-row') return new FakeLocator([this.row]);
    return new FakeLocator([]);
  }

  // \u5355\u6b21 evaluate \u7248\u539f\u8bed\u7684\u6a21\u62df\uff1a\u6536\u96c6\uff08\u9009\u62e9\u5668\u6570\u7ec4\uff09/\u70b9\u9009\uff08{value,exact}\uff09/\u515c\u5e95\u70b9\u9009\uff08{selectors}\uff09
  async evaluate(fn, arg) {
    if (Array.isArray(arg)) {
      return this.dropdownOpen ? [...this.optionTexts] : [];
    }
    if (arg && 'value' in arg) {
      if (!this.dropdownOpen) return false;
      const target = this.optionTexts.find((text) => arg.exact
        ? text === arg.value
        : text.includes(arg.value) || arg.value.includes(text));
      if (!target) return false;
      this.selectedMaterial = target;
      this.dropdownOpen = false;
      return true;
    }
    if (arg && Array.isArray(arg.selectors)) {
      if (!this.dropdownOpen) return '';
      const text = this.optionTexts.find((t) => t);
      this.selectedMaterial = text;
      this.dropdownOpen = false;
      return text;
    }
    return undefined;
  }
}

class FakeRow {
  constructor(page) {
    this.page = page;
    this.hasMaterialRow = false;
  }

  locator(selector) {
    if (selector.includes('button')) return new FakeLocator([new FakeAddButton(this)]);
    if (selector.includes('.el-select')) return new FakeLocator(this.hasMaterialRow ? [new FakeSelect(this.page)] : []);
    if (selector.includes('input')) {
      return new FakeLocator(this.hasMaterialRow ? [
        new FakeMaterialInput(this.page),
        new FakeRatioInput(this.page)
      ] : []);
    }
    if (selector.includes('tbody tr')) return new FakeLocator(this.hasMaterialRow ? [new FakeTableRow(this)] : []);
    return new FakeLocator([]);
  }

  async count() {
    return 1;
  }

  async innerText() {
    return ['\u6750\u6599', this.page.selectedMaterial, this.page.ratio].filter(Boolean).join(' ');
  }

  async evaluate(fn, value) {
    const text = ['\u6750\u6599', this.page.selectedMaterial, this.page.ratio].filter(Boolean).join(' ');
    return text.includes(value);
  }

  async scrollIntoViewIfNeeded() {}
}

class FakeLocator {
  constructor(items) {
    this.items = items;
  }

  first() {
    return new FakeLocator(this.items.slice(0, 1));
  }

  nth(index) {
    return new FakeLocator(this.items.slice(index, index + 1));
  }

  locator(selector) {
    return this.items[0].locator(selector);
  }

  async count() {
    return this.items.length;
  }

  async isVisible() {
    return Boolean(this.items[0]);
  }

  async scrollIntoViewIfNeeded() {}

  async click() {
    return this.items[0].click();
  }

  async fill(value) {
    return this.items[0].fill(value);
  }

  async inputValue() {
    return this.items[0].inputValue();
  }

  async innerText() {
    return this.items[0].innerText();
  }

  async evaluate(fn, arg) {
    return this.items[0].evaluate(fn, arg);
  }
}

class FakeAddButton {
  constructor(row) {
    this.row = row;
  }

  async innerText() {
    return '\u6dfb\u52a0';
  }

  async click() {
    this.row.hasMaterialRow = true;
  }
}

class FakeTableRow {
  constructor(row) {
    this.row = row;
  }

  locator(selector) {
    return this.row.locator(selector);
  }
}

class FakeSelect {
  constructor(page) {
    this.page = page;
  }

  async click() {
    this.page.dropdownOpen = true;
  }
}

class FakeMaterialInput {
  constructor(page) {
    this.page = page;
  }

  async inputValue() {
    return this.page.selectedMaterial;
  }

  async evaluate(fn) {
    return fn({
      readOnly: true,
      closest: (selector) => selector.includes('.el-select') ? {} : null
    });
  }
}

class FakeRatioInput {
  constructor(page) {
    this.page = page;
  }

  async fill(value) {
    this.page.ratio = value;
  }

  async inputValue() {
    return this.page.ratio;
  }

  async evaluate(fn) {
    return fn({
      readOnly: false,
      closest: () => null
    });
  }
}

async function main() {
  const page = new FakePage();

  await fillAttribute(page, {
    name: '\u6750\u6599',
    controlType: 'material_ratio_table',
    _rowSelector: '#material-row'
  }, '\u91d1\u5c5e');

  assert.equal(page.row.hasMaterialRow, true);
  assert.equal(page.selectedMaterial, '\u91d1\u5c5e');
  assert.equal(page.ratio, '100');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
