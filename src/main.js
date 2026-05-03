require('dotenv').config();

const fs = require('fs');
const { chromium } = require('playwright');
const { analyzeAttributes, rewriteProductTitles, secondChoice } = require('./ai_analyzer');
const { scanRequiredAttributes } = require('./attribute_scanner');
const { fillAttribute } = require('./filler');
const { fillProductTitles } = require('./title_filler');
const { RunLogger } = require('./logger');
const { navigateToModule } = require('./module_navigator');
const { chooseBestOption } = require('./option_matcher');
const { readProductInfo } = require('./page_reader');
const { CategoryKnowledge, readCurrentCategory } = require('./category_knowledge');
const {
  ensureProjectDirs,
  getBrowserContextOptions,
  getBrowserLaunchOptions,
  loadConfig,
  nowForFile,
  resolveRoot,
  safeFileName,
  toArrayValue,
  waitForEnter
} = require('./utils');

async function main() {
  await ensureProjectDirs();
  const config = loadConfig();
  const logger = new RunLogger();
  await logger.init();
  const categoryKnowledge = CategoryKnowledge.fromConfig(config);
  await categoryKnowledge.load();

  const statePath = resolveRoot('storage', 'miaoshou_state.json');
  const storageState = fs.existsSync(statePath) ? statePath : undefined;
  if (!storageState) console.warn('[启动] 未找到登录态，请先运行 npm run login。仍会打开页面，但可能需要手动登录。');

  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(getBrowserContextOptions(config, storageState ? { storageState } : {}));
  const page = await context.newPage();

  const targetUrl = config.productEditUrl || config.startUrl;
  const summary = {
    productTitle: '',
    requiredCount: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    products: 0,
    savedProducts: 0,
    saveFailedProducts: 0,
    skippedProducts: 0
  };
  const batchConfig = config.batch || {};
  const maxProducts = Number(batchConfig.maxProducts || 0);

  try {
    console.log(`[启动] 打开页面: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (config.behavior.waitForManualPage || !config.productEditUrl) {
      await waitForEnter('[等待] 请在浏览器中打开或确认当前商品编辑页，然后按回车开始扫描');
    }

    while (!maxProducts || summary.products < maxProducts) {
      const productIndex = summary.products + 1;
      const productSummary = createProductSummary();
      console.log(`\n====== 开始处理第 ${productIndex} 个商品 ======`);
      const result = await processCurrentProduct(page, config, logger, productSummary, { productIndex, categoryKnowledge });

      if (result.skipped) {
        summary.products += 1;
        summary.skippedProducts += 1;
        await logger.save();
        await categoryKnowledge.save();
        continue;
      }

      if (config.behavior.saveAfterFill) {
        const saveResult = await saveCurrentProductWithRetry(page, config, logger, result.productInfo, productSummary, productIndex, categoryKnowledge);
        if (saveResult.success) {
          productSummary.savedProducts += 1;
        } else if (saveResult.skipped) {
          productSummary.skippedProducts += 1;
        } else {
          productSummary.saveFailedProducts += 1;
        }
      } else {
        console.log('[保存] saveAfterFill=false，本次只填写，不自动保存，也不会自动进入下一个商品。');
        productSummary.skippedProducts += 1;
      }

      summary.products += 1;
      mergeProductSummary(summary, productSummary);
      await logger.save();
      await categoryKnowledge.save();

      if (!config.behavior.saveAfterFill) break;
      if (maxProducts && summary.products >= maxProducts) break;

      const moved = await goToNextProduct(page, config, result.productInfo, productIndex);
      if (!moved.success) {
        console.log(`[下一商品] ${moved.reason}`);
        break;
      }
      await waitForNextProductReady(page, result.productInfo, config);
    }
  } finally {
    await categoryKnowledge.save();
    await logger.save();
    printSummary(summary, logger);
    await browser.close();
  }
}

function createProductSummary() {
  return {
    productTitle: '',
    requiredCount: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    savedProducts: 0,
    saveFailedProducts: 0,
    skippedProducts: 0
  };
}

function mergeProductSummary(total, productSummary) {
  total.productTitle = productSummary.productTitle || total.productTitle;
  total.requiredCount += productSummary.requiredCount || 0;
  total.success += productSummary.success || 0;
  total.failed += productSummary.failed || 0;
  total.skipped += productSummary.skipped || 0;
  total.savedProducts += productSummary.savedProducts || 0;
  total.saveFailedProducts += productSummary.saveFailedProducts || 0;
  total.skippedProducts += productSummary.skippedProducts || 0;
}

async function processCurrentProduct(page, config, logger, summary, options = {}) {
  const categoryKnowledge = options.categoryKnowledge;
  const productIndexLabel = options.productIndex ? `商品 ${options.productIndex}` : '当前商品';

  console.log(`[${productIndexLabel}][1/5] 读取商品标题和图片...`);
  await navigateToModule(page, {
    name: '产品信息',
    aliases: ['商品信息', '基本信息', '基础信息']
  }).catch(() => ({ success: false }));

  const productInfo = await readProductInfo(page);
  summary.productTitle = productInfo.title || '(未读取到标题)';
  console.log(`[页面] 标题: ${summary.productTitle}`);
  console.log(`[页面] 图片数量: ${(productInfo.images || []).length}`);

  console.log(`[${productIndexLabel}][2/5] 优化并填写产品标题...`);
  await rewriteAndFillTitles(page, logger, productInfo, summary);

  const attributesModule = config.modules && config.modules.attributes
    ? config.modules.attributes
    : { name: '类别&属性', aliases: ['类目&属性', '分类&属性', '商品属性', '产品属性'], autoNavigate: true };
  let navigationResult = { success: true };
  if (attributesModule.autoNavigate !== false) {
    navigationResult = await navigateToModule(page, attributesModule);
    if (!navigationResult.success) {
      console.warn(`[模块] ${navigationResult.reason}`);
    } else {
      console.log(`[模块] 已通过 ${navigationResult.method} 定位到 ${navigationResult.label}`);
    }
  }

  console.log(`[${productIndexLabel}][3/5] 扫描产品属性必填项...`);
  const attributes = await scanRequiredAttributes(page);
  summary.requiredCount += attributes.length;
  console.log(`[扫描] 必填属性数量: ${attributes.length}`);
  attributes.forEach((attr, index) => {
    const errorText = attr.errorMessage ? ` | 提示 ${attr.errorMessage}` : '';
    console.log(`  ${index + 1}. ${attr.name} | ${attr.controlType} | 选项 ${attr.options.length} | 已填 ${attr.alreadyFilled ? '是' : '否'}${errorText}`);
  });
  const categoryInfo = await readCurrentCategory(page).catch(() => ({ name: '', candidates: [] }));
  productInfo.categoryName = categoryInfo.name || '';
  if (productInfo.categoryName) {
    console.log(`[Knowledge] Current category: ${productInfo.categoryName}`);
  } else {
    console.log('[Knowledge] Current category was not detected; knowledge lookup skipped.');
  }
  const knowledgeReference = categoryKnowledge
    ? categoryKnowledge.getReference(productInfo.categoryName, attributes)
    : null;
  if (knowledgeReference) {
    console.log(`[Knowledge] Loaded reference for ${knowledgeReference.categoryName}, seen ${knowledgeReference.timesSeen} times.`);
  }
  if (categoryKnowledge && productInfo.categoryName && attributes.length) {
    categoryKnowledge.recordCategoryAttributes(productInfo.categoryName, attributes, productInfo);
  }

  if (!attributes.length) {
    summary.failed += 1;
    const screenshot = await maybeScreenshot(page, config, 'scan_empty');
    logger.fail(baseRecord(productInfo, {
      name: '类别&属性',
      controlType: 'none',
      options: []
    }, {
      matchMethod: 'scan_empty',
      confidence: 0,
      screenshot,
      reason: navigationResult.success
        ? '已自动定位模块，但未在”类别&属性”区域找到带星号且为空值的属性'
        : navigationResult.reason,
      error: navigationResult.success
        ? '已自动定位模块，但未在”类别&属性”区域找到带星号且为空值的属性'
        : navigationResult.reason
    }));
  }

  const skipAttr = attributes.find((attr) => /尺码|サイズ/i.test(attr.name) && !attr.alreadyFilled && !attr.options.length);
  if (skipAttr) {
    console.warn(`[跳过] 字段【${skipAttr.name}】无可选选项，跳过当前商品。`);
    logger.log(baseRecord(productInfo, skipAttr, {
      status: 'skipped',
      reason: `字段【${skipAttr.name}】无可选选项，跳过商品`
    }));
    summary.skipped += 1;
    return { productInfo, navigationResult, skipped: true };
  }

  const todoAttributes = [];
  for (const attr of attributes) {
    if (config.behavior.skipAlreadyFilled && attr.alreadyFilled && !attr.errorMessage) {
      summary.skipped += 1;
      logger.log(baseRecord(productInfo, attr, {
        status: 'skipped',
        reason: '配置 skipAlreadyFilled=true，字段已填写'
      }));
    } else {
      todoAttributes.push(attr);
    }
  }

  console.log(`[${productIndexLabel}][4/5] 调用 AI 分析属性值...`);
  const aiResult = todoAttributes.length
    ? await analyzeAttributes(productInfo, todoAttributes, knowledgeReference)
    : { attributes: [] };
  const aiByName = new Map((aiResult.attributes || []).map((item) => [item.name, item]));

  console.log(`[${productIndexLabel}][5/5] 匹配页面真实选项并填写...`);
  for (const attr of todoAttributes) {
    const ai = aiByName.get(attr.name) || {
      value: null,
      confidence: 0,
      reason: 'AI 未返回该字段',
      need_manual: true
    };

    try {
      const finalDecision = await decideFinalValue(attr, ai, productInfo);
      if (!finalDecision.value || finalDecision.method === 'manual_required') {
        summary.failed += 1;
        logger.fail(baseRecord(productInfo, attr, {
          aiValue: ai.value,
          finalValue: finalDecision.value,
          matchMethod: finalDecision.method,
          confidence: finalDecision.confidence,
          reason: finalDecision.reason,
          error: finalDecision.reason
        }));
        continue;
      }

      await fillAttribute(page, attr, finalDecision.value);
      summary.success += 1;
      logger.log(baseRecord(productInfo, attr, {
        aiValue: ai.value,
        finalValue: finalDecision.value,
        matchMethod: finalDecision.method,
        confidence: finalDecision.confidence,
        status: 'success',
        reason: `${ai.reason || ''} ${finalDecision.reason || ''}`.trim()
      }));
      if (categoryKnowledge && productInfo.categoryName) {
        categoryKnowledge.recordFillResult(productInfo.categoryName, attr, finalDecision.value, productInfo);
      }
    } catch (error) {
      summary.failed += 1;
      const feedback = await collectFeedbackText(page);
      if (feedback) await closeFeedbackOverlays(page);
      const screenshot = await maybeScreenshot(page, config, attr.name);
      const errorMessage = feedback ? `${error.message}; 页面提示: ${feedback}` : error.message;
      logger.fail(baseRecord(productInfo, attr, {
        aiValue: ai.value,
        finalValue: '',
        matchMethod: 'failed',
        confidence: ai.confidence || 0,
        reason: ai.reason || '',
        screenshot,
        error: errorMessage
      }));
    }
  }

  return { productInfo, navigationResult };
}

async function decideFinalValue(attr, ai, productInfo) {
  if (attr.controlType === 'input') {
    if (ai.value == null || ai.value === '') {
      return {
        value: neutralInputValue(attr.name),
        method: 'neutral_text_fallback',
        confidence: 0.35,
        reason: ai.reason || 'AI 未给出输入值，已填写中性兜底文本'
      };
    }
    return {
      value: String(ai.value),
      method: 'ai_text',
      confidence: Number(ai.confidence || 0),
      reason: ai.reason || 'AI 生成文本输入值'
    };
  }

  if (attr.controlType === 'select') {
    return chooseBestOption({
      attrName: attr.name,
      inferredValue: ai.value,
      availableOptions: attr.options,
      productTitle: productInfo.title,
      images: productInfo.images,
      aiAnalyzer: { secondChoice }
    });
  }

  if (attr.controlType === 'multi_select') {
    const values = toArrayValue(ai.value);
    if (!values.length) {
      return chooseBestOption({
        attrName: attr.name,
        inferredValue: ai.value,
        availableOptions: attr.options,
        productTitle: productInfo.title,
        images: productInfo.images,
        aiAnalyzer: { secondChoice }
      });
    }

    const matched = [];
    const reasons = [];
    let confidence = 1;
    for (const value of values) {
      const decision = await chooseBestOption({
        attrName: attr.name,
        inferredValue: value,
        availableOptions: attr.options,
        productTitle: productInfo.title,
        images: productInfo.images,
        aiAnalyzer: { secondChoice }
      });
      if (!decision.value) continue;
      if (!matched.includes(decision.value)) matched.push(decision.value);
      confidence = Math.min(confidence, Number(decision.confidence || 0));
      reasons.push(`${value}->${decision.value}(${decision.method})`);
    }

    if (!matched.length) {
      return {
        value: null,
        method: 'manual_required',
        confidence: 0,
        reason: '多选字段没有匹配到任何页面选项'
      };
    }
    return {
      value: matched,
      method: 'multi_match',
      confidence,
      reason: reasons.join('; ')
    };
  }

  return {
    value: null,
    method: 'manual_required',
    confidence: 0,
    reason: `未知控件类型 ${attr.controlType}`
  };
}

function neutralInputValue(attrName) {
  const text = String(attrName || '');
  if (/数量|数目|个数|件数/i.test(text)) return '1';
  if (/重量|长|宽|高|尺寸|长度|宽度|高度/i.test(text)) return '0';
  return '不适用';
}

async function rewriteAndFillTitles(page, logger, productInfo, summary) {
  if (!productInfo.title) {
    logger.fail(baseRecord(productInfo, {
      name: '产品标题',
      controlType: 'input',
      options: []
    }, {
      matchMethod: 'title_rewrite',
      confidence: 0,
      reason: '未读取到原始标题，跳过标题优化',
      error: '未读取到原始标题，跳过标题优化'
    }));
    return;
  }

  let titles;
  try {
    titles = await rewriteProductTitles(productInfo);
  } catch (error) {
    logger.fail(baseRecord(productInfo, {
      name: '产品标题/英文标题',
      controlType: 'input',
      options: []
    }, {
      matchMethod: 'title_rewrite',
      confidence: 0,
      reason: `标题优化失败: ${error.message}`,
      error: error.message
    }));
    return;
  }

  const fillResult = await fillProductTitles(page, titles);

  if (fillResult.productTitleFilled) {
    summary.success += 1;
    logger.log(baseRecord(productInfo, {
      name: '产品标题',
      controlType: 'input',
      options: []
    }, {
      aiValue: titles.japaneseTitle,
      finalValue: titles.japaneseTitle,
      matchMethod: 'title_rewrite',
      confidence: 1,
      status: 'success',
      reason: '已按日本搜索习惯扩写并填写日语标题'
    }));
  } else if (titles.japaneseTitle) {
    summary.failed += 1;
    logger.fail(baseRecord(productInfo, {
      name: '产品标题',
      controlType: 'input',
      options: []
    }, {
      aiValue: titles.japaneseTitle,
      matchMethod: 'title_rewrite',
      confidence: 0,
      reason: fillResult.productTitleError || '产品标题填写失败',
      error: fillResult.productTitleError || '产品标题填写失败'
    }));
  }

  if (fillResult.englishTitleFilled) {
    summary.success += 1;
    logger.log(baseRecord(productInfo, {
      name: '英文标题',
      controlType: 'input',
      options: []
    }, {
      aiValue: titles.englishTitle,
      finalValue: titles.englishTitle,
      matchMethod: 'title_rewrite',
      confidence: 1,
      status: 'success',
      reason: '已按日本搜索习惯扩写并填写英文标题'
    }));
  } else if (titles.englishTitle) {
    summary.failed += 1;
    logger.fail(baseRecord(productInfo, {
      name: '英文标题',
      controlType: 'input',
      options: []
    }, {
      aiValue: titles.englishTitle,
      matchMethod: 'title_rewrite',
      confidence: 0,
      reason: fillResult.englishTitleError || '英文标题填写失败',
      error: fillResult.englishTitleError || '英文标题填写失败'
    }));
  }
}

function baseRecord(productInfo, attr, extra) {
  return {
    pageUrl: productInfo.url,
    productTitle: productInfo.title,
    attributeName: attr.name,
    controlType: attr.controlType,
    options: attr.options || [],
    aiValue: '',
    finalValue: '',
    matchMethod: '',
    confidence: '',
    status: '',
    reason: '',
    ...extra
  };
}

async function maybeScreenshot(page, config, attrName) {
  if (!config.behavior.screenshotOnError) return '';
  const file = resolveRoot('data', 'screenshots', `${nowForFile()}_${safeFileName(attrName, 'attribute')}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (error) {
    console.warn(`[截图] 保存失败: ${error.message}`);
    return '';
  }
}

async function saveCurrentProductWithRetry(page, config, logger, productInfo, summary, productIndex, categoryKnowledge) {
  if (summary.success <= 0) {
    console.log('[保存] 没有成功填写字段，本次不点击【保存修改】。');
    return { success: false, skipped: true, reason: '没有成功填写字段' };
  }

  const retryLimit = Number(config.batch && config.batch.saveRetryLimit);
  const maxAttempts = 1 + (Number.isFinite(retryLimit) && retryLimit >= 0 ? retryLimit : 1);
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await tryClickSave(page, config, attempt);
    if (lastResult.success) return lastResult;

    const message = lastResult.message || lastResult.reason || '未读取到保存失败原因';
    const screenshot = await maybeScreenshot(page, config, `save_failed_${productIndex}_${attempt}`);
    logger.fail(baseRecord(productInfo, {
      name: `保存修改(第${attempt}次)`,
      controlType: 'button',
      options: []
    }, {
      matchMethod: 'save_feedback',
      confidence: 0,
      screenshot,
      reason: message,
      error: message
    }));

    if (attempt >= maxAttempts) break;

    console.warn(`[保存] 保存失败提示：${message}`);
    console.log('[保存] 关闭失败弹窗，重新扫描当前商品，尝试更正后再次保存...');
    await closeFeedbackOverlays(page);
    const retrySummary = createProductSummary();
    await processCurrentProduct(page, config, logger, retrySummary, {
      productIndex: `${productIndex} 重试${attempt}`,
      categoryKnowledge
    });
    mergeProductSummary(summary, retrySummary);
  }

  const finalMessage = lastResult && (lastResult.message || lastResult.reason)
    ? lastResult.message || lastResult.reason
    : '保存失败';
  console.error(`[保存] 第 ${productIndex} 个商品保存失败，已跳过。原因：${finalMessage}`);
  return { success: false, skipped: false, message: finalMessage };
}

async function tryClickSave(page, config, attempt = 1) {
  console.log(`[保存] 第 ${attempt} 次尝试点击【保存修改】按钮...`);
  const candidates = [
    ...asArray((config.batch || {}).saveButtonSelectors),
    '.J_collectBoxEditDialogCreateSave',
    'button.J_collectBoxEditDialogCreateSave',
    'button:has-text("保存修改")',
    '.el-button:has-text("保存修改")',
    '.ant-btn:has-text("保存修改")',
    'text="保存修改"',
    'button:has-text("保存")',
    '.el-button:has-text("保存")',
    '.ant-btn:has-text("保存")',
    'button:has-text("提交")'
  ];
  for (const selector of candidates) {
    const button = page.locator(selector).first();
    if (!(await button.count().catch(() => 0))) continue;
    if (!(await button.isVisible().catch(() => false))) continue;
    if (await isLocatorDisabled(button)) continue;
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 5000 });
    const feedback = await waitForSaveFeedback(page, config, selector);
    if (feedback.success) {
      console.log(`[保存] 保存成功：${feedback.message || feedback.reason}`);
    } else {
      console.warn(`[保存] 保存失败：${feedback.message || feedback.reason}`);
    }
    return feedback;
  }
  console.warn('[保存] 没有找到【保存修改】按钮。');
  return { success: false, reason: '没有找到【保存修改】按钮' };
}

async function waitForSaveFeedback(page, config, saveSelector) {
  const timeout = Number(config.batch && config.batch.saveFeedbackTimeoutMs) || 6000;
  const started = Date.now();

  while (Date.now() - started < timeout) {
    await page.waitForTimeout(500).catch(() => {});
    const message = await collectFeedbackText(page);
    if (message) {
      const result = classifySaveFeedback(message);
      if (result) return { ...result, message };
    }

    const saveButton = page.locator(saveSelector).first();
    const visible = await saveButton.isVisible().catch(() => false);
    if (!visible) return { success: true, reason: '保存后编辑窗口已关闭' };
  }

  return { success: true, reason: '未检测到失败提示，按保存成功继续' };
}

function classifySaveFeedback(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/失败|错误|异常|有误|请检查|必填|不能为空|请选择|未填写|不允许|无权限|超限|重复|无效|校验|验证|保存失败|提交失败|error|failed|fail/i.test(text)) {
    return { success: false };
  }
  if (/保存成功|修改成功|提交成功|操作成功|成功保存|已保存|success/i.test(text)) {
    return { success: true };
  }
  return null;
}

async function collectFeedbackText(page) {
  const messages = await page.evaluate(() => {
    const selectors = [
      '.el-message',
      '.el-message-box',
      '.el-message-box__message',
      '.el-notification',
      '.ant-message',
      '.ant-notification',
      '.ant-modal-confirm',
      '.ant-modal-confirm-content',
      '.ant-alert',
      '.el-form-item__error',
      '.ant-form-item-explain-error',
      '.invalid-feedback',
      '[role="alert"]',
      '[role="alertdialog"]',
      '.toast',
      '.message',
      '.notification'
    ];
    const seen = new Set();

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((node) => !seen.has(node) && seen.add(node))
      .filter(visible)
      .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((text) => /成功|失败|错误|异常|有误|请检查|必填|不能为空|请选择|未填写|不允许|无权限|超限|重复|无效|校验|验证|保存|提交|success|error|failed|fail/i.test(text))
      .filter((text) => text.length <= 800);
  }).catch(() => []);

  return Array.from(new Set(messages)).join(' | ').trim();
}

async function closeFeedbackOverlays(page) {
  const closeSelectors = [
    '.el-message-box__btns button:has-text("确定")',
    '.el-message-box__btns button:has-text("关闭")',
    '.ant-modal-confirm-btns button:has-text("确定")',
    '.ant-modal-confirm-btns button:has-text("关闭")',
    '.ant-modal-confirm .ant-modal-footer button:has-text("确定")',
    '.ant-modal-confirm .ant-modal-footer button:has-text("关闭")',
    'button:has-text("知道了")',
    '.el-message-box__close',
    '.ant-modal-confirm .ant-modal-close',
    '[role="alertdialog"] button:has-text("确定")',
    '[role="alertdialog"] button:has-text("关闭")'
  ];

  for (const selector of closeSelectors) {
    const item = page.locator(selector).first();
    if (!(await item.count().catch(() => 0))) continue;
    if (!(await item.isVisible().catch(() => false))) continue;
    await item.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
    return true;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
  return false;
}

async function goToNextProduct(page, config, productInfo, productIndex) {
  console.log(`[下一商品] 第 ${productIndex} 个商品处理结束，尝试进入下一个商品...`);

  const beforeUrl = page.url();
  const beforeTitle = await page.evaluate(() => {
    const active = document.querySelector('.goods-item.active, .goods-item.selected, .goods-item.current');
    const titleNode = active && active.querySelector('.item-title, [title]');
    return titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
  }).catch(() => '');

  const clickedGoodsList = await clickNextInGoodsList(page);
  if (clickedGoodsList) {
    await confirmLeaveIfPrompted(page);
    const goodsUrlChanged = page.url() !== beforeUrl;
    const goodsTitleChanged = await page.evaluate((oldTitle) => {
      const active = document.querySelector('.goods-item.active, .goods-item.selected, .goods-item.current');
      const titleNode = active && active.querySelector('.item-title, [title]');
      const newTitle = titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
      return newTitle && newTitle !== oldTitle;
    }, beforeTitle).catch(() => false);
    if (goodsUrlChanged || goodsTitleChanged) {
      return { success: true, method: 'goods_list', title: clickedGoodsList.title || '' };
    }
    console.warn('[下一商品] 商品列表点击后页面和标题均未变化，视为停留在当前商品');
  }

  const selectors = [
    ...asArray((config.batch || {}).nextProductSelectors),
    '.J_collectBoxEditDialogNext',
    'button.J_collectBoxEditDialogNext',
    'button:has-text("下一个商品")',
    'button:has-text("下一个产品")',
    'button:has-text("下一商品")',
    'button:has-text("下一产品")',
    'button:has-text("下一个")',
    'a:has-text("下一个")',
    'text="下一个商品"',
    'text="下一个产品"',
    'text="下一商品"',
    'text="下一产品"',
    'text="下一个"'
  ];

  for (const selector of selectors) {
    const item = page.locator(selector).first();
    if (!(await item.count().catch(() => 0))) continue;
    if (!(await item.isVisible().catch(() => false))) continue;
    if (await isLocatorDisabled(item)) continue;
    await item.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await item.click({ timeout: 4000 });
    } catch (error) {
      console.warn(`[下一商品] 点击候选入口失败 ${selector}: ${error.message}`);
      continue;
    }
    await confirmLeaveIfPrompted(page);
    const urlChanged = page.url() !== beforeUrl;
    if (!urlChanged) {
      console.warn(`[下一商品] 点击 ${selector} 后页面未跳转，可能不是正确的下一商品按钮`);
      continue;
    }
    return { success: true, method: 'selector', selector };
  }

  const clickedLeftList = await clickNextInLeftProductList(page);
  if (clickedLeftList) {
    await confirmLeaveIfPrompted(page);
    const leftUrlChanged = page.url() !== beforeUrl;
    if (!leftUrlChanged) {
      console.warn('[下一商品] 左侧列表点击后页面未跳转，视为无下一商品');
    } else {
      return { success: true, method: 'left_list' };
    }
  }

  return {
    success: false,
    method: 'not_found',
    reason: `没有找到下一个商品入口，已完成最后一个可识别商品：${productInfo.title || '(未读取到标题)'}`
  };
}

async function clickNextInGoodsList(page) {
  const result = await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function textOf(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    const roots = Array.from(document.querySelectorAll('.goods-list-box, .goods-list, .pro-scrollbar.goods-list'))
      .filter(visible);

    for (const root of roots) {
      const items = Array.from(root.querySelectorAll('.goods-item')).filter(visible);
      if (items.length <= 1) continue;

      const activeIndex = items.findIndex((item) => /\bactive\b|\bselected\b|\bcurrent\b|\bis-active\b/.test(`${item.className || ''}`));
      if (activeIndex < 0 || activeIndex + 1 >= items.length) continue;

      const nextItem = items[activeIndex + 1];
      const clickTarget = nextItem.querySelector('.list-goods-item, .item-title, .goods-info, .goods-img-box') || nextItem;
      const titleNode = nextItem.querySelector('.item-title, [title]');
      const title = titleNode ? (titleNode.getAttribute('title') || textOf(titleNode)) : textOf(nextItem).slice(0, 120);
      nextItem.scrollIntoView({ block: 'center', inline: 'nearest' });
      clickTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      clickTarget.click();
      return { success: true, title };
    }

    const active = document.querySelector('.goods-item.active, .goods-item.selected, .goods-item.current, .goods-item.is-active');
    const sibling = active && active.nextElementSibling && active.nextElementSibling.matches('.goods-item')
      ? active.nextElementSibling
      : null;
    if (sibling && visible(sibling)) {
      const clickTarget = sibling.querySelector('.list-goods-item, .item-title, .goods-info, .goods-img-box') || sibling;
      const titleNode = sibling.querySelector('.item-title, [title]');
      const title = titleNode ? (titleNode.getAttribute('title') || textOf(titleNode)) : textOf(sibling).slice(0, 120);
      sibling.scrollIntoView({ block: 'center', inline: 'nearest' });
      clickTarget.click();
      return { success: true, title };
    }

    return { success: false, reason: '没有找到 .goods-item.active 的下一个商品' };
  }).catch((error) => ({ success: false, reason: error.message }));

  if (result.success) {
    console.log(`[下一商品] 已点击商品列表下一项${result.title ? `：${result.title}` : ''}`);
    const started = Date.now();
    let activeChanged = false;
    while (Date.now() - started < 4000) {
      await page.waitForTimeout(400).catch(() => {});
      activeChanged = await page.evaluate((clickedTitle) => {
        const active = document.querySelector('.goods-list-box .goods-item.active, .goods-item.active');
        const titleNode = active && active.querySelector('.item-title, [title]');
        const title = titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
        return clickedTitle ? Boolean(title) && (title.includes(clickedTitle) || clickedTitle.includes(title)) : Boolean(active);
      }, result.title || '').catch(() => false);
      if (activeChanged) break;
    }

    if (!activeChanged) {
      console.warn('[下一商品] 已触发点击，但没有检测到商品列表 active 状态变化。');
      return false;
    }

    return result;
  }

  console.warn(`[下一商品] 商品列表切换失败：${result.reason}`);
  return false;
}

async function clickNextInLeftProductList(page) {
  return page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function clickable(el) {
      return el && visible(el) && !/disabled|is-disabled/i.test(`${el.className || ''}`);
    }

    const activeSelector = '.active,.selected,.current,.is-active,[aria-selected="true"]';
    const containerSelector = [
      '[class*="left"]',
      '[class*="side"]',
      '[class*="product"]',
      '[class*="goods"]',
      '[class*="collect"]',
      '[class*="list"]',
      '[role="listbox"]',
      'ul',
      'ol'
    ].join(',');

    const activeNodes = Array.from(document.querySelectorAll(activeSelector))
      .filter(clickable)
      .filter((node) => node.getBoundingClientRect().left < window.innerWidth * 0.55);

    for (const active of activeNodes) {
      let container = active.parentElement;
      for (let depth = 0; container && container !== document.body && depth < 6; depth += 1) {
        if (!container.matches(containerSelector)) {
          container = container.parentElement;
          continue;
        }

        const children = Array.from(container.children).filter(clickable);
        const index = children.findIndex((child) => child === active || child.contains(active));
        if (index >= 0 && index + 1 < children.length) {
          children[index + 1].scrollIntoView({ block: 'center', inline: 'center' });
          children[index + 1].click();
          return true;
        }
        container = container.parentElement;
      }
    }

    return false;
  }).catch(() => false);
}

async function confirmLeaveIfPrompted(page) {
  await page.waitForTimeout(500).catch(() => {});
  const confirmSelectors = [
    '.el-message-box__btns button:has-text("不保存")',
    '.el-message-box__btns button:has-text("继续")',
    '.el-message-box__btns button:has-text("确定")',
    '.ant-modal-footer button:has-text("不保存")',
    '.ant-modal-footer button:has-text("继续")',
    '.ant-modal-footer button:has-text("确定")',
    'button:has-text("不保存")',
    'button:has-text("继续")',
    'button:has-text("确定")'
  ];
  for (const selector of confirmSelectors) {
    const button = page.locator(selector).first();
    if (!(await button.count().catch(() => 0))) continue;
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    return true;
  }
  return false;
}

async function waitForNextProductReady(page, previousProductInfo, config) {
  const timeout = Number(config.batch && config.batch.nextProductWaitMs) || 4000;
  const oldUrl = previousProductInfo.url || page.url();
  const oldTitle = previousProductInfo.title || '';
  const started = Date.now();

  while (Date.now() - started < timeout) {
    await page.waitForTimeout(500).catch(() => {});
    const currentUrl = page.url();
    if (currentUrl !== oldUrl) return true;
    const currentInfo = await readProductInfo(page).catch(() => ({ title: '' }));
    if (currentInfo.title && currentInfo.title !== oldTitle) return true;
  }
  return false;
}

async function isLocatorDisabled(locator) {
  return locator.evaluate((node) => {
    const disabled = node.disabled || node.getAttribute('disabled') != null || node.getAttribute('aria-disabled') === 'true';
    return Boolean(disabled || /disabled|is-disabled/i.test(`${node.className || ''}`));
  }).catch(() => false);
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value) return [value];
  return [];
}

function printSummary(summary, logger) {
  console.log('\n====== 本次处理汇总 ======');
  console.log(`本次最后处理商品：${summary.productTitle}`);
  console.log(`处理商品数：${summary.products}`);
  console.log(`保存成功商品数：${summary.savedProducts}`);
  console.log(`保存失败跳过商品数：${summary.saveFailedProducts}`);
  console.log(`未保存跳过商品数：${summary.skippedProducts}`);
  console.log(`必填属性数量：${summary.requiredCount}`);
  console.log(`成功填写：${summary.success}`);
  console.log(`失败：${summary.failed}`);
  console.log(`跳过：${summary.skipped}`);
  console.log(`日志文件：${logger.logFile}`);
  console.log(`失败文件：${logger.failedFile}`);
  console.log('========================\n');
}

main().catch((error) => {
  console.error(`[主流程] 失败: ${error.stack || error.message}`);
  process.exitCode = 1;
});
