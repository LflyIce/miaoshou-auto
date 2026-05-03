const assert = require('node:assert/strict');

const { chooseBestOption } = require('../src/option_matcher');

async function main() {
  const decision = await chooseBestOption({
    attrName: '\u6750\u6599',
    inferredValue: '',
    availableOptions: [],
    productTitle: '',
    images: []
  });

  assert.notEqual(decision.value, '\u5426');
  assert.equal(decision.value, '\u94a2');
  assert.equal(decision.method, 'fallback_unverified');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
