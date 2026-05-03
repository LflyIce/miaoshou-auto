const assert = require('node:assert/strict');

const { decideNextProductTransition } = require('../src/batch_flow');

async function main() {
  const stalled = decideNextProductTransition({
    moved: { success: true, method: 'selector' },
    ready: false,
    productInfo: { title: 'last product' }
  });

  assert.equal(stalled.continueBatch, false);
  assert.match(stalled.reason, /last product/);

  const loaded = decideNextProductTransition({
    moved: { success: true, method: 'selector' },
    ready: true,
    productInfo: { title: 'first product' }
  });

  assert.equal(loaded.continueBatch, true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
