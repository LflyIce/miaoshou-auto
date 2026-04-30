require('dotenv').config();

const fs = require('fs');
const { chromium } = require('playwright');
const { analyzeAttributes, secondChoice } = require('./ai_analyzer');
const { scanRequiredAttributes } = require('./attribute_scanner');
const { fillAttribute } = require('./filler');
const { RunLogger } = require('./logger');
const { navigateToModule } = require('./module_navigator');
const { chooseBestOption } = require('./option_matcher');
const { activateManualPage } = require('./page_selector');
const { readProductInfo } = require('./page_reader');
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

  const statePath = resolveRoot('storage', 'miaoshou_state.json');
  const storageState = fs.existsSync(statePath) ? statePath : undefined;
  if (!storageState) console.warn('[启动] 未找到登录态，请先运行 npm run login。仍会打开页面，但可能需要手动登录。');

  const browser = await chromium.launch(getBrowserLaunchOptions(config));
  const context = await browser.newContext(getBrowserContextOptions(config, storageState ? { storageState } : {}));
  let page = await context.newPage();

  const targetUrl = config.productEditUrl || config.startUrl;
  let summary = {
    productTitle: '',
    requiredCount: 0,
    success: 0,
    failed: 0,
    skipped: 0
  };

  try {
    console.log(`[启动] 打开页面: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (config.behavior.waitForManualPage || !config.productEditUrl) {
      await waitForEnter('[等待] 请在浏览器中打开或确认当前商品编辑页，然后按回车开始扫描');
      page = await activateManualPage(context, page);
    }

    console.log('[1/5] 读取商品标题和图片...');
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

    const productInfo = await readProductInfo(page);
    summary.productTitle = productInfo.title || '(未读取到标题)';
    console.log(`[页面] 标题: ${summary.productTitle}`);
    console.log(`[页面] 图片数量: ${(productInfo.images || []).length}`);

    console.log('[2/5] 扫描产品属性必填项...');
    const attributes = await scanRequiredAttributes(page);
    summary.requiredCount = attributes.length;
    console.log(`[扫描] 必填属性数量: ${attributes.length}`);
    attributes.forEach((attr, index) => {
      console.log(`  ${index + 1}. ${attr.name} | ${attr.controlType} | 选项 ${attr.options.length} | 已填 ${attr.alreadyFilled ? '是' : '否'}`);
    });
    if (!attributes.length) {
      summary.failed += 1;
      logger.fail(baseRecord(productInfo, {
        name: '类别&属性',
        controlType: 'none',
        options: []
      }, {
        matchMethod: 'scan_empty',
        confidence: 0,
        reason: navigationResult.success
          ? '已自动定位模块，但未在“类别&属性”区域找到带星号且为空值的属性'
          : navigationResult.reason,
        error: navigationResult.success
          ? '已自动定位模块，但未在“类别&属性”区域找到带星号且为空值的属性'
          : navigationResult.reason
      }));
    }

    const todoAttributes = [];
    for (const attr of attributes) {
      if (config.behavior.skipAlreadyFilled && attr.alreadyFilled) {
        summary.skipped += 1;
        logger.log(baseRecord(productInfo, attr, {
          status: 'skipped',
          reason: '配置 skipAlreadyFilled=true，字段已填写'
        }));
      } else {
        todoAttributes.push(attr);
      }
    }

    console.log('[3/5] 调用 AI 分析属性值...');
    const aiResult = todoAttributes.length
      ? await analyzeAttributes(productInfo, todoAttributes)
      : { attributes: [] };
    const aiByName = new Map((aiResult.attributes || []).map((item) => [item.name, item]));

    console.log('[4/5] 匹配页面真实选项并填写...');
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
      } catch (error) {
        summary.failed += 1;
        const screenshot = await maybeScreenshot(page, config, attr.name);
        logger.fail(baseRecord(productInfo, attr, {
          aiValue: ai.value,
          finalValue: '',
          matchMethod: 'failed',
          confidence: ai.confidence || 0,
          reason: ai.reason || '',
          screenshot,
          error: error.message
        }));
      }
    }

    console.log('[5/5] 收尾...');
    if (config.behavior.saveAfterFill) {
      if (summary.success > 0) {
        await tryClickSave(page);
      } else {
        console.log('[保存] 没有成功填写字段，本次不点击【保存修改】。');
      }
    } else {
      console.log('[保存] saveAfterFill=false，本次只填写，不自动保存。请人工检查页面。');
    }
  } finally {
    await logger.save();
    printSummary(summary, logger);
    await browser.close();
  }
}

async function decideFinalValue(attr, ai, productInfo) {
  if (attr.controlType === 'input') {
    if (ai.value == null || ai.value === '') {
      return {
        value: null,
        method: 'manual_required',
        confidence: 0,
        reason: ai.reason || 'AI 未给出输入值'
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

async function tryClickSave(page) {
  console.log('[保存] saveAfterFill=true，尝试点击【保存修改】按钮...');
  const candidates = [
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
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 5000 });
    await page.waitForTimeout(1000).catch(() => {});
    console.log('[保存] 已点击【保存修改】，请留意页面反馈。');
    return;
  }
  console.warn('[保存] 没有找到【保存修改】按钮。');
}

function printSummary(summary, logger) {
  console.log('\n====== 本次处理汇总 ======');
  console.log(`本次处理商品：${summary.productTitle}`);
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
