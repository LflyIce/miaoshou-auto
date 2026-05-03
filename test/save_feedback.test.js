const assert = require('node:assert/strict');

const { classifySaveFeedback, extractValidationIssues, shouldPauseAt } = require('../src/save_feedback');

async function main() {
  assert.deepEqual(classifySaveFeedback('\u4fdd\u5b58\u6210\u529f'), {
    success: true,
    shouldCorrect: false,
    category: 'success'
  });

  assert.deepEqual(classifySaveFeedback('\u4fdd\u5b58\u5931\u8d25\uff1aSKU\u4ef7\u683c\u4e0d\u80fd\u4e3a\u7a7a\uff0c\u8bf7\u68c0\u67e5'), {
    success: false,
    shouldCorrect: true,
    category: 'validation_error'
  });

  assert.deepEqual(classifySaveFeedback('\u4ea7\u54c1\u5c5e\u6027\u3010\u6570\u91cf\u3011\u5fc5\u987b\u8f93\u5165\u6570\u5b57'), {
    success: false,
    shouldCorrect: true,
    category: 'validation_error'
  });

  assert.deepEqual(extractValidationIssues('\u4ea7\u54c1\u5c5e\u6027\u3010\u6570\u91cf\u3011\u5fc5\u987b\u8f93\u5165\u6570\u5b57'), [
    { attributeName: '\u6570\u91cf', correction: 'number' }
  ]);

  assert.deepEqual(classifySaveFeedback('\u64cd\u4f5c\u5f02\u5e38\uff1a\u65e0\u6743\u9650'), {
    success: false,
    shouldCorrect: false,
    category: 'system_error'
  });

  assert.equal(shouldPauseAt({ behavior: { pauseOnSaveError: true } }, 'save_error'), true);
  assert.equal(shouldPauseAt({ behavior: { pauseBeforeSave: true } }, 'before_save'), true);
  assert.equal(shouldPauseAt({ behavior: { pauseAfterEachProduct: true } }, 'after_product'), true);
  assert.equal(shouldPauseAt({ behavior: {} }, 'save_error'), false);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
