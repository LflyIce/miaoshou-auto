function classifySaveFeedback(message) {
  const text = normalizeFeedbackText(message);
  if (!text) return null;

  if (/保存成功|修改成功|提交成功|操作成功|成功保存|已保存|success/i.test(text)) {
    return { success: true, shouldCorrect: false, category: 'success' };
  }

  if (isValidationError(text)) {
    return { success: false, shouldCorrect: true, category: 'validation_error' };
  }

  if (/失败|错误|异常|有误|无权限|超限|不允许|无效|保存失败|提交失败|error|failed|fail/i.test(text)) {
    return { success: false, shouldCorrect: false, category: 'system_error' };
  }

  return null;
}

function shouldPauseAt(config, phase) {
  const behavior = (config && config.behavior) || {};
  const pauseMap = {
    before_save: 'pauseBeforeSave',
    save_error: 'pauseOnSaveError',
    after_product: 'pauseAfterEachProduct'
  };
  const key = pauseMap[phase];
  return Boolean(key && behavior[key]);
}

function normalizeFeedbackText(message) {
  return String(message || '').replace(/\s+/g, ' ').trim();
}

function isValidationError(text) {
  return /请检查|必填|不能为空|请选择|未填写|请完善|必须|请输入|输入数字|校验|验证|重复|SKU|规格|属性|价格|库存|标题|类目|分类|图片|物流|运费|发货|仓库/i.test(text) &&
    /失败|错误|异常|有误|请检查|必填|不能为空|请选择|未填写|请完善|必须|请输入|输入数字|校验|验证|重复|无效|error|failed|fail/i.test(text);
}

function extractValidationIssues(message) {
  const text = normalizeFeedbackText(message);
  if (!text) return [];

  const issues = [];
  const attrRegex = /(?:产品属性|商品属性|属性|字段|参数)[【\[]([^】\]]+)[】\]]/g;
  let match;
  while ((match = attrRegex.exec(text))) {
    const attributeName = String(match[1] || '').trim();
    if (!attributeName) continue;
    issues.push({
      attributeName,
      correction: /数字|数值|整数|金额|价格|库存|数量/.test(text) ? 'number' : 'required'
    });
  }

  return issues.filter((item, index) =>
    issues.findIndex((other) => other.attributeName === item.attributeName && other.correction === item.correction) === index
  );
}

module.exports = {
  classifySaveFeedback,
  extractValidationIssues,
  shouldPauseAt
};
