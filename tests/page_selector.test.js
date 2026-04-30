const assert = require('assert');
const { chooseManualPage } = require('../src/page_selector');

function page(url, closed = false) {
  return {
    url: () => url,
    isClosed: () => closed
  };
}

const listPage = page('https://erp.91miaoshou.com/pddkj_choice/collect_box/items');
const editPage = page('https://erp.91miaoshou.com/product/edit/123');
const blankPage = page('about:blank');

assert.strictEqual(chooseManualPage([listPage], listPage), listPage);
assert.strictEqual(chooseManualPage([listPage, editPage], listPage), editPage);
assert.strictEqual(chooseManualPage([listPage, blankPage], listPage), listPage);
assert.strictEqual(chooseManualPage([listPage, page('https://example.com', true)], listPage), listPage);

console.log('page selector OK');
