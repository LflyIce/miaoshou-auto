require('dotenv').config();

const fs = require('fs');
const { chromium } = require('playwright');
const { analyzeAttributes, analyzeSaveError, startTitleGeneration, secondChoice, secondChoiceBatch } = require('./ai_analyzer');
const { scanRequiredAttributes, discoverNewRequiredAttributes, readPaneAttributeNames, readOptionsForAttribute, readMaterialTableOptions } = require('./attribute_scanner');
const { fillAttribute } = require('./filler');
const { fillProductTitles } = require('./title_filler');
const { RunLogger } = require('./logger');
const { navigateToModule } = require('./module_navigator');
const { chooseBestOption } = require('./option_matcher');
const { readProductInfo, readProductLink, readTotalProductCount, readCurrentProductIndex, readCurrentProductImageUrl, readCurrentProductOriginalTitle } = require('./page_reader');
const { CategoryKnowledge, readCurrentCategory } = require('./category_knowledge');
const { ProductExporter } = require('./product_export');
const { readSkuTableData, readSpecInputValues } = require('./sku_reader');
const { fillSkuProperties } = require('./sku_filler');
const { cleanDescription } = require('./description_cleaner');
const { sanitizeMaterialValues } = require('./material_policy');
const {
  ensureProjectDirs,
  getBrowserContextOptions,
  getBrowserLaunchOptions,
  loadConfig,
  nowForFile,
  resolveRoot,
  safeFileName,
  sleep,
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
  const exporter = new ProductExporter();
  await exporter.init();

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
    skippedProducts: 0,
    totalProducts: 0,
    saveFailedTitles: []
  };
  const batchConfig = config.batch || {};
  const maxProducts = Number(batchConfig.maxProducts || 0);

  try {
    console.log(`[启动] 打开页面: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (config.behavior.waitForManualPage || !config.productEditUrl) {
      await waitForEnter('[等待] 请在浏览器中打开或确认当前商品编辑页，然后按回车开始扫描');
    }

    // 在批量开始前读取总产品数和当前编辑的商品索引
    const [countResult, indexResult] = await Promise.all([
      readTotalProductCount(page),
      readCurrentProductIndex(page)
    ]);
    if (countResult.total > 0) {
      summary.totalProducts = countResult.total;
      console.log(`[统计] 检测到商品总数: ${countResult.total}（方式: ${countResult.method}）`);
    } else {
      console.log(`[统计] 未能检测到商品总数（${countResult.method}），将以实际处理数量为准`);
    }
    let startProductIndex = indexResult.index || 1;
    if (indexResult.total > 0 && summary.totalProducts === 0) {
      summary.totalProducts = indexResult.total;
    }
    console.log(`[统计] 当前编辑商品索引: ${startProductIndex}${indexResult.total > 0 ? '/' + indexResult.total : ''}（方式: ${indexResult.method}）`);

    while (!maxProducts || summary.products < maxProducts) {
      const productIndex = startProductIndex + summary.products;
      const progressLabel = summary.totalProducts > 0
        ? `[${productIndex}/${summary.totalProducts}]`
        : `第 ${productIndex} 个`;
      console.log(`\n====== 开始处理${progressLabel}商品 ======`);
      const productSummary = createProductSummary();
      let result;
      try {
        result = await processCurrentProduct(page, config, logger, productSummary, { productIndex, categoryKnowledge, exporter });
      } catch (error) {
        console.error(`[${productIndex}] 处理失败: ${error.message}`);
        summary.products += 1;
        summary.saveFailedProducts += 1;
        summary.saveFailedTitles = summary.saveFailedTitles || [];
        summary.saveFailedTitles.push(productSummary.originalTitle || productSummary.productTitle || `(商品${productIndex})`);
        await logger.save();
        await categoryKnowledge.save();
        continue;
      }

      if (result.skipped) {
        summary.products += 1;
        summary.skippedProducts += 1;
        await logger.save();
        await categoryKnowledge.save();
        // 跳过的商品同样要切换到下一个（未保存修改会弹"是否确认离开"，确认即可）
        const movedSkip = await goToNextProduct(page, config, result.productInfo, productIndex);
        if (!movedSkip.success) {
          console.log(`[下一商品] ${movedSkip.reason}`);
          break;
        }
        await waitForNextProductReady(page, result.productInfo, config);
        continue;
      }

      // exportProductData 已在 processCurrentProduct 内部调用，确保 SKU 表格仍可见

      if (config.behavior.saveAfterFill) {
        const saveResult = await saveCurrentProductWithRetry(page, config, logger, result.productInfo, productSummary, productIndex, categoryKnowledge);
        if (saveResult.success) {
          productSummary.savedProducts += 1;
        } else if (saveResult.skipped) {
          productSummary.skippedProducts += 1;
        } else {
          productSummary.saveFailedProducts += 1;
          // 优先使用原始中文标题（从商品列表读取），其次才是改写后的标题
          const failedTitle = productSummary.originalTitle || productSummary.productTitle || result.productInfo.title || '(未知商品)';
          productSummary.saveFailedTitles = productSummary.saveFailedTitles || [];
          productSummary.saveFailedTitles.push(failedTitle);
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
    await exporter.save().catch((error) => console.warn(`[导出] 保存失败: ${error.message}`));
    await categoryKnowledge.save();
    await logger.save();
    printSummary(summary, logger);
    await browser.close();
  }
}

function createProductSummary() {
  return {
    productTitle: '',
    originalTitle: '',
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
  total.originalTitle = productSummary.originalTitle || total.originalTitle || '';
  total.requiredCount += productSummary.requiredCount || 0;
  total.success += productSummary.success || 0;
  total.failed += productSummary.failed || 0;
  total.skipped += productSummary.skipped || 0;
  total.savedProducts += productSummary.savedProducts || 0;
  total.saveFailedProducts += productSummary.saveFailedProducts || 0;
  total.skippedProducts += productSummary.skippedProducts || 0;
  if (productSummary.saveFailedTitles && productSummary.saveFailedTitles.length) {
    total.saveFailedTitles.push(...productSummary.saveFailedTitles);
  }
}

async function processCurrentProduct(page, config, logger, summary, options = {}) {
  const categoryKnowledge = options.categoryKnowledge;
  const productIndexLabel = options.productIndex ? `商品 ${options.productIndex}` : '当前商品';
  const _timers = {};
  const tic = (name) => { _timers[name] = Date.now(); };
  const toc = (name) => { const ms = Date.now() - (_timers[name] || Date.now()); console.log(`[耗时] ${name}: ${ms}ms`); return ms; };

  console.log(`[${productIndexLabel}][1/5] 读取商品标题和图片...`);
  tic('nav1');
  await navigateToModule(page, {
    name: '产品信息',
    aliases: ['商品信息', '基本信息', '基础信息']
  }).catch(() => ({ success: false }));
  toc('nav1');

  tic('readInfo');
  const productInfo = await readProductInfo(page);
  // 死页面防护：会话失效/误跳接口页时，页面"标题"会读成 JSON 配置体，
  // 此时后续 AI/填写全是无效操作，直接中止本商品（2026-10-14 事故：报错文字被填成商品标题）
  if (/^\s*[{[]/.test(productInfo.title || '') || /appName|appChineseName|miaoshou|"host"/i.test(productInfo.title || '')) {
    throw new Error(`页面读取异常，标题疑似接口响应体(会话可能已失效)，跳过该商品: ${String(productInfo.title || '').slice(0, 60)}`);
  }
  summary.productTitle = productInfo.title || '(未读取到标题)';
  console.log(`[页面] 标题: ${summary.productTitle}`);
  console.log(`[页面] 图片数量: ${(productInfo.images || []).length}`);
  toc('readInfo');

  // 提前从左侧商品列表读取当前商品的图片URL和原始标题
  const goodsListImageUrl = await readCurrentProductImageUrl(page);
  if (goodsListImageUrl) {
    console.log(`[图片] 商品列表图片: ${goodsListImageUrl.slice(0, 80)}...`);
  }
  const originalTitle = await readCurrentProductOriginalTitle(page);
  if (originalTitle) {
    console.log(`[原始标题] ${originalTitle.slice(0, 80)}${originalTitle.length > 80 ? '...' : ''}`);
  }
  summary.originalTitle = originalTitle || '';

  console.log(`[${productIndexLabel}][2/5] 优化并填写产品标题...`);
  tic('titleAI');

  // 第一步：立即发起标题 AI 请求（不等待），与随后的 DOM 操作并行
  const titleTask = startTitleGeneration(productInfo, options.corrections || {});
  titleTask.catch(() => {}); // 防止 AI 提前失败触发 unhandledRejection，后续 await 会得到同样的异常

  tic('descSku');
  // 清理产品描述：删除文字模块
  try {
    const cleanResult = await cleanDescription(page);
    if (cleanResult.deleted > 0) {
      console.log(`[描述] 清理完成: ${cleanResult.reason}`);
    } else {
      console.log(`[描述] ${cleanResult.reason}`);
    }
  } catch (e) {
    console.warn(`[描述] 清理失败: ${e.message}`);
  }

  // 在切换到"类别&属性"模块之前，提前读取SKU数据（此时仍在产品信息页面，SKU表格可见）
  let earlySkuData = null;
  try {
    earlySkuData = await readSkuTableData(page);
    if (earlySkuData && (earlySkuData.thumbnailUrl || earlySkuData.declaredPrice || earlySkuData.colors.length)) {
      console.log(`[SKU] 预读取成功: ${earlySkuData.rowCount}行`);
    }
  } catch (e) {
    console.warn(`[SKU] 预读取失败: ${e.message}`);
  }
  const earlyProductLink = await readProductLink(page);

  // 在切换模块前编辑规格（规格一设标题为型号保留3项，规格二保留2项）
  let skuEdited = false;
  try {
    const skuResult = await fillSkuProperties(page);
    if (skuResult.status === 'skip_product') {
      console.warn(`[规格] ${skuResult.reason}`);
      logger.log(baseRecord(productInfo, { name: 'SKU规格', controlType: 'none', options: [] }, {
        status: 'skipped',
        reason: skuResult.reason
      }));
      summary.skipped += 1;
      const exporterSkip = options.exporter;
      if (exporterSkip) {
        try {
          const skuData = earlySkuData || { colors: [], declaredPrice: '', thumbnailUrl: '', rowCount: 0 };
          exporterSkip.addProduct({
            imageUrl: goodsListImageUrl || skuData.thumbnailUrl || (productInfo.images && productInfo.images[0]) || '',
            productUrl: earlyProductLink || productInfo.url || '',
            japaneseTitle: '',
            specifications: '',
            declaredPrice: skuData.declaredPrice
          });
          await exporterSkip.save();
        } catch (e) {
          console.warn(`[导出] 跳过商品导出失败: ${e.message}`);
        }
      }
      return { productInfo, navigationResult: { success: true }, skipped: true };
    }
    if (skuResult.status === 'success' && skuResult.changed) {
      skuEdited = true;
      console.log(`[规格] 编辑完成: 规格一${skuResult.specOneTitleChanged ? '标题已改' : ''}删除${skuResult.specOneTrimmed}项, 规格二${skuResult.specTwoTitleChanged ? `标题${skuResult.specTwoRenamedFrom}改${skuResult.specTwoRenamedTo}、` : ''}删除${skuResult.specTwoTrimmed}项`);
    } else if (skuResult.status === 'skipped') {
      console.log(`[规格] ${skuResult.reason}`);
    }
  } catch (e) {
    console.warn(`[规格] 编辑失败: ${e.message}`);
  }

  // 规格编辑完成后从input读取实际保留的规格值
  let editedSpecs = null;
  if (skuEdited) {
    editedSpecs = await readSpecInputValues(page);
    if (editedSpecs && editedSpecs.length) {
      console.log(`[SKU] 编辑后规格已读取`);
    } else {
      console.log(`[SKU] 编辑后未读取到规格input值，导出时规格列将留空`);
    }
  }
  toc('descSku');

  // DOM 操作（描述清理/SKU/规格）与标题 AI 并行；此时已全部完成，等待 AI 结果并填写标题
  tic('fillTitle');
  const japaneseTitle = await rewriteAndFillTitles(page, logger, productInfo, summary, options.corrections || {}, titleTask);
  toc('fillTitle');
  console.log(`[耗时] 标题阶段总耗时(并行): ${Date.now() - _timers.titleAI}ms`);

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
  tic('scan');
  const attributes = await scanUntilComplete(page, { errorFields: options.errorFields || [] });
  summary.requiredCount += attributes.length;
  console.log(`[扫描] 必填属性数量: ${attributes.length}`);
  toc('scan');
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

  // 尺码类商品（需人工维护尺码表）直接跳过：必填且未填的尺码/サイズ字段，无论有无选项
  const skipAttr = attributes.find((attr) => /尺码|サイズ/i.test(attr.name) && !attr.alreadyFilled);
  if (skipAttr) {
    console.warn(`[跳过] 字段【${skipAttr.name}】无可选选项，跳过当前商品。`);
    logger.log(baseRecord(productInfo, skipAttr, {
      status: 'skipped',
      reason: `字段【${skipAttr.name}】无可选选项，跳过商品`
    }));
    summary.skipped += 1;
    const exporter = options.exporter;
    if (exporter) {
      try {
        const skuData = earlySkuData || { colors: [], declaredPrice: '', thumbnailUrl: '', rowCount: 0 };
        const productUrl = earlyProductLink || productInfo.url || '';
        const imageUrl = goodsListImageUrl || skuData.thumbnailUrl || (productInfo.images && productInfo.images[0]) || '';
        const skipSpecs = (editedSpecs && editedSpecs.length) ? editedSpecs.join(', ') : '';
        exporter.addProduct({
          imageUrl: imageUrl,
          productUrl: productUrl,
          japaneseTitle: '',
          specifications: skipSpecs,
          declaredPrice: skuData.declaredPrice
        });
        await exporter.save();
      } catch (e) {
        console.warn(`[导出] 跳过商品导出失败: ${e.message}`);
      }
    }
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
  tic('knowledge');
  const knowledgeDecisions = await buildKnowledgeDecisions(todoAttributes, knowledgeReference, productInfo);
  const aiAttributes = todoAttributes.filter((attr) => !knowledgeDecisions.has(attr.name));
  if (knowledgeDecisions.size) {
    console.log(`[Knowledge] Reusing ${knowledgeDecisions.size} attribute value(s) from local category history.`);
  }
  toc('knowledge');

  tic('attrAI');
  const aiResult = aiAttributes.length
    ? await analyzeAttributes(productInfo, aiAttributes, knowledgeReference)
    : { attributes: [] };
  const aiByName = new Map((aiResult.attributes || []).map((item) => [item.name, item]));
  toc('attrAI');

  console.log(`[${productIndexLabel}][5/5] 匹配页面真实选项并填写...`);
  tic('matchFill');
  // 预计算 secondChoice 批量结果，避免 N 次串行 AI 调用
  const secondChoiceCache = await precomputeSecondChoice(todoAttributes, aiByName, productInfo);

  // 字段工作队列：某些选择会级联出新必填行（如面料纹理→面料克重），每填完一个字段
  // 探测一次新必填行，发现即补决策（知识库→批量AI→批量二次选择）并入队继续，
  // 不再依赖"全部填完→保存失败→修复"的事后补救
  const queue = [...todoAttributes];
  const knownNameKey = (name) => String(name || '').replace(/\s+/g, '').toLowerCase();
  const handledNames = new Set(todoAttributes.map((attr) => knownNameKey(attr.name)));
  const fieldContext = { knowledgeDecisions, aiByName, secondChoiceCache, categoryKnowledge };
  let cascadeRounds = 0;
  const MAX_CASCADE_ROUNDS = 3;

  const discoverAndEnqueue = async () => {
    if (cascadeRounds >= MAX_CASCADE_ROUNDS) return;
    // 级联行渲染需要一点时间，稍等后再收集
    await sleep(300);
    let fresh = [];
    try {
      fresh = await discoverNewRequiredAttributes(page, {
        knownNames: [...handledNames],
        errorFields: options.errorFields || []
      });
    } catch (_) {
      return;
    }
    if (!fresh.length) return;
    cascadeRounds += 1;
    console.log(`[级联] 发现 ${fresh.length} 个新必填字段: ${fresh.map((a) => a.name).join('、')}`);
    // 新字段补决策来源，与首轮同构：知识库 → 批量 AI → 批量二次选择
    const freshKnowledge = await buildKnowledgeDecisions(fresh, knowledgeReference, productInfo);
    freshKnowledge.forEach((decision, name) => knowledgeDecisions.set(name, decision));
    const freshAiAttrs = fresh.filter((attr) => !freshKnowledge.has(attr.name));
    if (freshAiAttrs.length) {
      const freshAi = await analyzeAttributes(productInfo, freshAiAttrs, knowledgeReference);
      (freshAi.attributes || []).forEach((item) => aiByName.set(item.name, item));
    }
    const extraCache = await precomputeSecondChoice(fresh, aiByName, productInfo);
    extraCache.forEach((value, key) => secondChoiceCache.set(key, value));
    fresh.forEach((attr) => {
      handledNames.add(knownNameKey(attr.name));
      summary.requiredCount += 1;
      queue.push(attr);
    });
  };

  // 初始队列可能为空（全部已填被 skipAlreadyFilled 跳过）：也先探测一轮，
  // 否则 while 循环一次不跑，晚渲染/级联的必填行要等保存失败才暴露
  if (!queue.length) await discoverAndEnqueue();

  while (queue.length) {
    const attr = queue.shift();
    const filled = await processAttributeField(page, config, logger, summary, productInfo, attr, fieldContext);
    // 填写成功后探测级联；队列将空时即使本轮失败也兜底探测一次（部分级联在失焦/校验后才出现）
    if (filled || !queue.length) await discoverAndEnqueue();
  }
  toc('matchFill');

  // 在页面仍可用时立即导出产品数据（使用提前读取的SKU数据）
  tic('export');
  const exporter = options.exporter;
  console.log(`[导出-DEBUG] exporter=${!!exporter}, japaneseTitle=${!!japaneseTitle}, productInfo=${!!productInfo}`);
  if (exporter && (japaneseTitle || productInfo)) {
    try {
      const skuData = earlySkuData || { colors: [], declaredPrice: '', thumbnailUrl: '', rowCount: 0 };
      const productUrl = earlyProductLink || productInfo.url || '';
      const imageUrl = goodsListImageUrl || skuData.thumbnailUrl || (productInfo.images && productInfo.images[0]) || '';
      const specifications = (editedSpecs && editedSpecs.length) ? editedSpecs.join(', ') : '';
      console.log(`[导出-DEBUG] 准备写入: imageUrl=${imageUrl.slice(0, 60)}, productUrl=${productUrl.slice(0, 60)}, japaneseTitle=${(japaneseTitle || '').slice(0, 40)}, specs=${specifications}`);
      exporter.addProduct({
        imageUrl: imageUrl,
        productUrl: productUrl,
        japaneseTitle: japaneseTitle || '',
        specifications: specifications,
        declaredPrice: skuData.declaredPrice
      });
      await exporter.save();
      console.log(`[导出] 已写入商品数据: ${japaneseTitle || productInfo.title || ''}`);
    } catch (error) {
      console.warn(`[导出] 产品数据导出失败: ${error.message}\n${error.stack}`);
    }
  } else {
    console.log(`[导出-DEBUG] 跳过导出: exporter=${!!exporter}, hasTitle=${!!japaneseTitle}, hasInfo=${!!productInfo}`);
  }
  toc('export');

  console.log(`[耗时] ===== 商品处理总耗时: ${Date.now() - _timers.titleAI}ms =====`);

  return { productInfo, navigationResult, japaneseTitle };
}

/** 单字段处理（[5/5] 队列与保存修复共用）：弹窗清理 → 决策（纹理短路→知识库→AI/兜底）→ 填写
 *  → 日志/知识库回写。返回是否填写成功（供调用方决定是否探测级联新必填行） */
async function processAttributeField(page, config, logger, summary, productInfo, attr, context) {
  // 填写前处理可能意外弹出的弹窗（如"是否确认离开"），避免挡住下拉点击
  await dismissBlockingDialogs(page);
  const knowledgeDecision = context.knowledgeDecisions.get(attr.name);
  const ai = knowledgeDecision ? {
    value: knowledgeDecision.sourceValue,
    confidence: knowledgeDecision.confidence,
    reason: knowledgeDecision.reason,
    need_manual: false
  } : context.aiByName.get(attr.name) || {
    value: null,
    confidence: 0,
    reason: 'AI 未返回该字段',
    need_manual: true
  };

  try {
    const finalDecision = textureSafeDecision(attr) || knowledgeDecision
      || await decideFinalValue(attr, ai, productInfo, context.secondChoiceCache);
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
      return false;
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
    if (context.categoryKnowledge && productInfo.categoryName) {
      context.categoryKnowledge.recordFillResult(productInfo.categoryName, attr, finalDecision.value, productInfo);
    }
    return true;
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
    return false;
  }
}

/** 从保存错误信息提取字段名：兼容"产品属性【xx】必填"和"制造地点需必填/xx不能为空"两种格式 */
function extractRequiredFieldNames(message) {
  const text = String(message || '');
  const names = [];
  const push = (raw) => {
    const n = String(raw || '').replace(/\s+/g, '').replace(/(需|要|还|缺|应)$/, '').trim();
    if (n && n.length >= 2 && !names.includes(n)) names.push(n);
  };
  let m;
  const bracket = /【([^】]+)】/g;
  while ((m = bracket.exec(text)) !== null) push(m[1]);
  const suffix = /([^|，。、；\s【】]{2,15}?)(?:需?必填|不能为空|未填写|有误)/g;
  while ((m = suffix.exec(text)) !== null) push(m[1]);
  return names;
}

/** 通用点击式选择（readonly 输入框的级联/地区等控件）：点开输入框，页面可见选项中匹配建议值点选，
 *  检测到展开二级面板（选项数增加）自动续选一级，最后回读行文本/输入框值校验。
 *  选项渲染可能有延迟：轮询等待（约 2s），中途无选项再重点一次触发器 */
async function fillPickerByClick(page, row, value) {
  // 点击载体优先用外层容器：readonly input 常有 pointer-events:none / tabindex=-1，直接点会超时
  const trigger = row.locator('.jx-cascader, .jx-input__wrapper, .jx-select__wrapper, .ant-select-selector, input[readonly], input').first();
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  let opened = true;
  try {
    await trigger.click({ timeout: 3000 });
  } catch (_) {
    try {
      await trigger.click({ timeout: 2000, force: true });
    } catch (_e) {
      opened = false;
    }
  }
  if (!opened) return [];

  const OPT = '.jx-select-dropdown__item, .el-select-dropdown__item, .jx-cascader-node, .el-cascader-node, .ant-cascader-menu-item, [role="option"], [class*="cascader-node"]';
  const visibleOptionTexts = () => page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }).map((el) => String(el.innerText || '').replace(/\s+/g, ''));
  }, OPT).catch(() => []);
  const clickVisibleOption = (idx) => page.evaluate(({ sel, i }) => {
    const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (nodes[i]) nodes[i].click();
  }, { sel: OPT, i: idx }).catch(() => {});

  // 选项轮询：懒渲染的面板首次读取常为空，等待期间再重点一次触发器兜底
  let before = [];
  for (let attempt = 0; attempt < 6 && !before.length; attempt += 1) {
    await sleep(350);
    before = await visibleOptionTexts();
    if (!before.length && attempt === 2) {
      await trigger.click({ timeout: 1500 }).catch(() => {});
    }
  }
  if (!before.length) {
    console.warn('[点击选择] 下拉面板已点击但选项始终未出现（渲染过慢或面板类名未覆盖）');
    return [];
  }

  const norm = (t) => String(t || '').replace(/\s+/g, '');
  const matchIdx = value ? before.findIndex((t) => t && t.includes(norm(value))) : -1;
  const firstIdx = matchIdx >= 0 ? matchIdx : 0;

  const picked = [before[firstIdx] || ''];
  await clickVisibleOption(firstIdx);
  await sleep(400);

  // 二级面板（级联）：可见选项数增加则续选（匹配建议值或第一个新选项）
  const after = await visibleOptionTexts();
  if (after.length > before.length) {
    let secondIdx = value ? after.findIndex((t) => t && t.includes(norm(value)) && !before.includes(t)) : -1;
    if (secondIdx < 0) secondIdx = before.length;
    picked.push(after[secondIdx] || '');
    await clickVisibleOption(secondIdx);
    await sleep(400);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
  // 回读校验：行文本或行内输入框 value 任一包含即算已填（jx 选中值可能只落在 input.value，innerText 读不到）
  const committed = await row.evaluate((el, texts) => {
    const rowText = String(el.innerText || el.textContent || '');
    if (texts.some((t) => t && rowText.includes(t))) return true;
    return Array.from(el.querySelectorAll('input, textarea')).some((input) => {
      const v = String(input.value || '');
      return texts.some((t) => t && v.includes(t));
    });
  }, picked).catch(() => false);
  if (!committed) {
    console.warn(`[点击选择] 已点选 ${picked.join('/')} 但行内未检测到已填值`);
    return [];
  }
  return picked;
}

/** 全页面定位字段行；当前视图找不到时逐个切换模块查找（错误提示未指明字段所在模块时，每个模块都要看） */
async function locateFieldAcrossModules(page, fieldName) {
  const locateOnce = () => page.evaluate((name) => {
    const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[:：]/g, '').split(/[(（]/)[0];
    const target = norm(name);
    if (!target) return false;
    const rows = Array.from(document.querySelectorAll('.jx-form-item, .el-form-item, .ant-form-item'))
      .filter((el) => String(el.className || '').split(/\s+/).some((t) => /form-item$/.test(t)));
    const hit = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const label = row.querySelector('.jx-form-item__label, .el-form-item__label, label');
      const text = norm(label && (label.innerText || label.textContent));
      return text && (text === target || text.includes(target) || target.includes(text));
    });
    if (!hit) return false;
    hit.setAttribute('data-ms-fix-row', '1');
    return true;
  }, fieldName).catch(() => false);

  if (await locateOnce()) return true;

  // 非当前模块的字段（如制造地点在"产品信息"）：切换各模块逐个查找
  const navLabels = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.scroll-menu-nav__item'))
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ''))
      .filter(Boolean);
  }).catch(() => []);
  for (const label of navLabels) {
    await page.locator('.scroll-menu-nav__item').filter({ hasText: label }).first().click({ timeout: 2000 }).catch(() => {});
    await sleep(700);
    if (await locateOnce()) {
      console.log(`[保存修复] 字段【${fieldName}】在「${label}」模块中找到`);
      return true;
    }
  }
  return false;
}

/** data-ms-fix-row 行是否为空值（无已选 tag、输入框全空或占位符）。无法判定时按空处理（宁填勿漏） */
async function isFixRowEmpty(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-ms-fix-row="1"]');
    if (!row) return true;
    const placeholder = /请选择|请输入|请填写|选择地区|Select|Input/i;
    const selected = Array.from(row.querySelectorAll(
      '.el-tag, .jx-tag, .ant-select-selection-item, [class*="selection-item"], .el-cascader__selection, [class*="__selection"]'
    )).map((el) => String(el.innerText || el.textContent || '').trim())
      .filter((text) => text && !placeholder.test(text));
    if (selected.length) return false;
    const inputs = Array.from(row.querySelectorAll('input:not([type="hidden"]), textarea'));
    const filled = inputs.some((el) => {
      const value = String(el.value || '').trim();
      return value && !placeholder.test(value);
    });
    return !filled;
  }).catch(() => true);
}

/** 保存前预填"面板外"的确定性必填字段（如 制造地点 在产品信息模块，属性扫描/级联发现都看不到）。
 *  按 config.preSave.outsideFields 配置全页面定位，已有值则跳过——
 *  不再等首次保存失败报错才发现，省掉一整轮"失败→反馈→重扫→修复→再保存"循环 */
async function prefillOutsideRequiredFields(page, config, logger, summary, productInfo, trackFailed = null) {
  const entries = (config.preSave && Array.isArray(config.preSave.outsideFields)) ? config.preSave.outsideFields : [];
  for (const entry of entries) {
    const name = String((entry && entry.name) || '').trim();
    const value = String((entry && entry.value) || '').trim();
    if (!name || !value) continue;
    try {
      const found = await locateFieldAcrossModules(page, name);
      if (!found) {
        console.log(`[保存预填] 未找到字段【${name}】的输入行，跳过`);
        continue;
      }
      if (!(await isFixRowEmpty(page))) {
        console.log(`[保存预填] 字段【${name}】已有值，跳过`);
        continue;
      }
      console.log(`[保存预填] 面板外必填字段【${name}】，预填 ${value}`);
      await fixFieldByErrorName(page, config, logger, summary, productInfo, name, value, null, 'presave', trackFailed);
    } catch (error) {
      console.warn(`[保存预填] 字段【${name}】预填失败: ${error.message}`);
    }
  }
}

/** 按错误提示全页面定位字段行并直接填写（字段可能在"产品信息/其他信息"等非属性面板，如制造地点）。
 *  tag=presave 时日志标记为保存预填；trackFailed 传入 Set 时记录修复失败的字段名（供保存循环早停判断）。返回是否填写成功 */
async function fixFieldByErrorName(page, config, logger, summary, productInfo, fieldName, suggestedValue, knowledgeRef = null, tag = 'correction', trackFailed = null) {
  const logTag = tag === 'presave' ? '保存预填' : '保存修复';
  const reasonText = tag === 'presave' ? '保存前预填面板外必填字段' : '按保存错误提示定向填写';
  const fixKey = String(fieldName || '').replace(/\s+/g, '').toLowerCase();
  const markFix = (ok) => {
    if (!trackFailed) return;
    if (ok) trackFailed.delete(fixKey);
    else trackFailed.add(fixKey);
  };
  const found = await locateFieldAcrossModules(page, fieldName);
  if (!found) {
    console.warn(`[${logTag}] 各模块均未找到字段【${fieldName}】的输入行`);
    markFix(false);
    return false;
  }

  const row = page.locator('[data-ms-fix-row="1"]').first();
  const controlType = await row.evaluate((el) => {
    if (el.querySelector('.el-table, .jx-pro-table, table')) return 'material_ratio_table';
    if (el.querySelector('.jx-cascader, .el-cascader, .ant-cascader')) return 'picker';
    if (el.querySelector('.jx-select__selection.is-multiple, .ant-select-multiple, .el-select__tags, [aria-multiselectable="true"]')) return 'multi_select';
    if (el.querySelector('.jx-select, .el-select, .ant-select, [role="combobox"], select')) return 'select';
    if (el.querySelector('input[readonly]:not([type="hidden"])')) return 'picker';
    if (el.querySelector('textarea, input:not([type="hidden"])')) return 'input';
    return 'unknown';
  }).catch(() => 'unknown');

  // 点击式选择控件（级联/地区等，readonly input 不可 fill）：点开面板匹配建议值点选
  if (controlType === 'picker') {
    await dismissBlockingDialogs(page);
    let ok = false;
    try {
      const applied = await fillPickerByClick(page, row, String(suggestedValue || ''));
      if (!applied.length) throw new Error('选择后未检测到已填写值');
      summary.success += 1;
      summary.requiredCount += 1;
      logger.log(baseRecord(productInfo, { name: fieldName, controlType: 'picker', options: [] }, {
        aiValue: suggestedValue,
        finalValue: applied.join('/'),
        matchMethod: `picker_${tag}`,
        confidence: 0.9,
        status: 'success',
        reason: reasonText
      }));
      console.log(`[${logTag}] [OK] ${fieldName} -> ${applied.join('/')}`);
      ok = true;
    } catch (error) {
      summary.failed += 1;
      const screenshot = await maybeScreenshot(page, config, fieldName);
      logger.fail(baseRecord(productInfo, { name: fieldName, controlType: 'picker', options: [] }, {
        aiValue: suggestedValue,
        matchMethod: 'failed',
        confidence: 0.9,
        reason: '',
        screenshot,
        error: error.message
      }));
      console.warn(`[${logTag}] ${fieldName} 选择填写失败: ${error.message}`);
    }
    await row.evaluate((el) => el.removeAttribute('data-ms-fix-row')).catch(() => {});
    markFix(ok);
    return ok;
  }

  const attr = { name: fieldName, controlType, _rowSelector: '[data-ms-fix-row="1"]', options: [] };
  if (controlType === 'select' || controlType === 'multi_select') {
    attr.options = await readOptionsForAttribute(page, attr).catch(() => []);
  } else if (controlType === 'material_ratio_table') {
    attr.options = await readMaterialTableOptions(page, attr).catch(() => []);
  }

  let finalValue = suggestedValue || '';
  let method = suggestedValue ? 'ai_correction' : '';
  let confidence = suggestedValue ? 0.9 : 0;
  // 无建议值时纹理字段用安全值兜底（如扫描漏掉的里料纹理 → 无里料/无内衬）
  if (!finalValue) {
    const texSafe = textureSafeDecision(attr);
    if (texSafe) {
      finalValue = texSafe.value;
      method = texSafe.method;
      confidence = texSafe.confidence;
    }
  }
  // 仍无值：走常规决策链（知识库 → 单字段 AI），漏扫字段一次性全补上，不留给下一轮保存报错
  if (!finalValue && (controlType === 'select' || controlType === 'multi_select' || controlType === 'input')) {
    const kd = (await buildKnowledgeDecisions([attr], knowledgeRef, productInfo).catch(() => new Map())).get(attr.name);
    if (kd) {
      finalValue = kd.value;
      method = kd.method;
      confidence = kd.confidence;
    } else {
      const aiRes = await analyzeAttributes(productInfo, [attr], knowledgeRef).catch(() => ({ attributes: [] }));
      const aiItem = (aiRes.attributes || [])[0];
      if (aiItem && aiItem.value) {
        finalValue = String(aiItem.value);
        method = 'ai_direct';
        confidence = aiItem.confidence || 0;
      }
    }
  }
  // 成分/材质约束：建议值或 AI 直出值可能是多值串，材质只选一种、涤纶与聚酯不同时选
  if (controlType === 'multi_select' && finalValue) {
    const sanitized = sanitizeMaterialValues(fieldName, finalValue);
    if (sanitized.note) {
      console.log(`[${logTag}][成分] ${fieldName}: ${sanitized.note}`);
      finalValue = sanitized.values.join(',');
    }
  }
  if ((controlType === 'select' || controlType === 'multi_select') && attr.options.length && finalValue) {
    const matched = await chooseBestOption({
      attrName: fieldName,
      inferredValue: finalValue,
      availableOptions: attr.options,
      productTitle: productInfo.title
    });
    if (matched && matched.value) {
      finalValue = matched.value;
      method = `${tag}_${matched.method}`;
      confidence = matched.confidence;
    } else if (!attr.options.includes(finalValue)) {
      summary.failed += 1;
      logger.fail(baseRecord(productInfo, attr, {
        aiValue: suggestedValue,
        matchMethod: 'no_match',
        confidence: 0,
        reason: `建议值 ${suggestedValue} 不在页面选项中`,
        error: '建议值与页面选项不匹配'
      }));
      await row.evaluate((el) => el.removeAttribute('data-ms-fix-row')).catch(() => {});
      markFix(false);
      return false;
    }
  }
  if (!finalValue) {
    console.warn(`[${logTag}] 字段【${fieldName}】无建议值，跳过`);
    await row.evaluate((el) => el.removeAttribute('data-ms-fix-row')).catch(() => {});
    markFix(false);
    return false;
  }

  await dismissBlockingDialogs(page);
  let filled = false;
  try {
    await fillAttribute(page, attr, finalValue);
    summary.success += 1;
    summary.requiredCount += 1;
    logger.log(baseRecord(productInfo, attr, {
      aiValue: suggestedValue,
      finalValue,
      matchMethod: method,
      confidence,
      status: 'success',
      reason: reasonText
    }));
    console.log(`[${logTag}] [OK] ${fieldName} -> ${String(finalValue).slice(0, 24)}`);
    filled = true;
  } catch (error) {
    summary.failed += 1;
    const screenshot = await maybeScreenshot(page, config, fieldName);
    logger.fail(baseRecord(productInfo, attr, {
      aiValue: suggestedValue,
      matchMethod: 'failed',
      confidence,
      reason: '',
      screenshot,
      error: error.message
    }));
    console.warn(`[${logTag}] ${fieldName} 填写失败: ${error.message}`);
  }
  await row.evaluate((el) => el.removeAttribute('data-ms-fix-row')).catch(() => {});
  markFix(filled);
  return filled;
}

/** 扫描直到覆盖 pane 全部必填属性：扫描不稳定时可能只返回部分行，
 *  与 pane 实际必填属性名（仅必填，可选不算）对比，有遗漏就等待重扫，最多3次 */
async function scanUntilComplete(page, options = {}) {
  let attributes = await scanRequiredAttributes(page, options);
  let missed = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const paneNames = await readPaneAttributeNames(page);
    const scannedNames = attributes.map((a) => String(a.name || '').replace(/\s+/g, ''));
    missed = [...new Set(paneNames)].filter((name) => {
      const n = String(name || '').replace(/\s+/g, '');
      return n && !scannedNames.some((s) => s === n || s.includes(n) || n.includes(s));
    });
    if (!missed.length) return attributes;
    console.warn(`[扫描] 有 ${missed.length} 个必填属性未被扫到: ${missed.join('、')}，等待后重扫(${attempt + 1}/3)`);
    await sleep(1000);
    attributes = await scanRequiredAttributes(page, options);
  }

  // 重扫后仍漏：逐字段输出过滤判定，定位是哪个环节丢的行
  if (missed.length) {
    const diag = await page.evaluate((names) => {
      const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[:：]/g, '').split(/[(（]/)[0];
      const pane = Array.from(document.querySelectorAll('.scroll-menu-pane')).find((el) => {
        const label = el.querySelector('.scroll-menu-pane__label');
        if (!label) return false;
        const r = label.getBoundingClientRect();
        const t = String(label.innerText || label.textContent || '').replace(/\s+/g, '');
        return r.width > 0 && r.height > 0 && /类别&属性|类目&属性|分类&属性|类别属性|类目属性/.test(t);
      });
      if (!pane) return names.map((n) => `${n}: pane未找到`);
      return names.map((name) => {
        const target = norm(name);
        const hit = Array.from(pane.querySelectorAll('.product-attribute-item')).find((el) => {
          const label = el.querySelector('.jx-form-item__label, label');
          const t = norm(label && (label.innerText || label.textContent));
          return t && (t === target || t.includes(target) || target.includes(t));
        });
        if (!hit) return `${name}: pane内无该行`;
        const r = hit.getBoundingClientRect();
        const cls = String(hit.className || '');
        const col = hit.closest('.jx-col') || hit.parentElement;
        return `${name}[可见${r.width > 0 && r.height > 0 ? '√' : '×'} ${Math.round(r.width)}x${Math.round(r.height)} 必填${cls.includes('is-required') ? '√' : '×'} 父display=${col ? window.getComputedStyle(col).display : '?'} 输入${hit.querySelector('input,textarea,select') ? '√' : '×'} 类名=${cls.slice(0, 60)}]`;
      });
    }, missed).catch(() => []);
    if (diag.length) console.warn(`[扫描] 漏扫诊断: ${diag.join(' | ')}`);

    // 丢弃原因：collectRequiredRows 在页面里记录的"必填但被过滤链丢掉"日志，按漏打名字匹配输出
    const dropDiag = await page.evaluate((names) => {
      const log = Array.isArray(window.__msAttrScanDropped) ? window.__msAttrScanDropped.slice(-60) : [];
      return names.map((name) => {
        const n = String(name || '').replace(/\s+/g, '');
        const hits = log.filter((item) => {
          const d = String(item.name || '').replace(/\s+/g, '');
          return d && (d === n || d.includes(n) || n.includes(d));
        }).map((item) => item.reason);
        return hits.length ? `${name} <- ${[...new Set(hits)].join(';')}` : '';
      }).filter(Boolean);
    }, missed).catch(() => []);
    if (dropDiag.length) console.warn(`[扫描] 丢弃原因: ${dropDiag.join(' | ')}`);
  }
  return attributes;
}

/**
 * 保存失败的定向修复：重新走一遍属性流程——全量扫描，补填"必填且未填"的字段
 * （含级联新出现的，如填完材料后新增的制作工艺），不重跑标题/描述/SKU/导出。
 * 由保存重试循环驱动：修复一次 → 再保存一次。
 */
async function fixAttributesForRetry(page, config, logger, summary, productInfo, options = {}) {
  const categoryKnowledge = options.categoryKnowledge;
  const attributesModule = config.modules && config.modules.attributes
    ? config.modules.attributes
    : { name: '类别&属性', aliases: ['类目&属性', '分类&属性', '商品属性', '产品属性'], autoNavigate: true };
  if (attributesModule.autoNavigate !== false) {
    const navigationResult = await navigateToModule(page, attributesModule);
    if (!navigationResult.success) console.warn(`[模块] ${navigationResult.reason}`);
  }

  const categoryInfo = await readCurrentCategory(page).catch(() => ({ name: '' }));
  productInfo.categoryName = categoryInfo.name || productInfo.categoryName || '';
  const knowledgeReference = categoryKnowledge
    ? categoryKnowledge.getReference(productInfo.categoryName, [])
    : null;

  const attributes = await scanUntilComplete(page, { errorFields: options.errorFields || [] });
  // 补填"必填且未填"的全部字段，已填的一律不重填——
  // 保存提示每次常只报一个字段，只填点名的会陷入"补一个→保存报下一个"的挤牙膏循环
  const todo = attributes.filter((attr) => !attr.alreadyFilled);

  if (todo.length) {
    console.log(`[保存修复] 补填 ${todo.length} 个未填必填属性: ${todo.map((a) => a.name).join('、')}`);
    summary.requiredCount += todo.length;
  } else {
    console.log('[保存修复] 属性面板未发现未填的必填属性');
  }

  const knowledgeDecisions = await buildKnowledgeDecisions(todo, knowledgeReference, productInfo);
  const aiAttributes = todo.filter((attr) => !knowledgeDecisions.has(attr.name));
  const aiResult = aiAttributes.length
    ? await analyzeAttributes(productInfo, aiAttributes, knowledgeReference)
    : { attributes: [] };
  const aiByName = new Map((aiResult.attributes || []).map((item) => [item.name, item]));
  const secondChoiceCache = await precomputeSecondChoice(todo, aiByName, productInfo);

  for (const attr of todo) {
    await processAttributeField(page, config, logger, summary, productInfo, attr, {
      knowledgeDecisions,
      aiByName,
      secondChoiceCache,
      categoryKnowledge
    });
  }

  // 扫描漏掉的面板必填字段（扫描不稳定的已知问题）：改用全页面按 label 定位兜底填写
  const scannedNames = attributes.map((a) => String(a.name || '').replace(/\s+/g, ''));
  const paneRequiredNames = await readPaneAttributeNames(page);
  const paneMissed = [...new Set(paneRequiredNames)].filter((name) => {
    const n = String(name || '').replace(/\s+/g, '');
    return n && !scannedNames.some((s) => s === n || s.includes(n) || n.includes(s));
  });
  const handledByLocate = new Set(paneMissed.map((n) => String(n || '').replace(/\s+/g, '')));
  if (paneMissed.length) {
    console.warn(`[保存修复] 扫描漏掉 ${paneMissed.length} 个面板字段，改用全页面定位填写: ${paneMissed.join('、')}`);
    for (const fieldName of paneMissed) {
      const suggested = (options.corrections || {})[fieldName] || '';
      await fixFieldByErrorName(page, config, logger, summary, productInfo, fieldName, suggested, knowledgeReference, 'correction', options.failedFixFields || null);
    }
  }

  // 错误提示的字段若不在"类别&属性"面板（如制造地点在"产品信息"），全页面定位并按建议值直接填写
  const outsideFields = (options.errorFields || []).filter((f) => {
    const n = String(f || '').replace(/\s+/g, '');
    return n && !handledByLocate.has(n) && !scannedNames.some((s) => s === n || s.includes(n) || n.includes(s));
  });
  if (outsideFields.length) {
    console.log(`[保存修复] 面板外字段，全页面定位填写: ${outsideFields.join('、')}`);
    for (const fieldName of outsideFields) {
      const suggested = (options.corrections || {})[fieldName] || '';
      await fixFieldByErrorName(page, config, logger, summary, productInfo, fieldName, suggested, knowledgeReference, 'correction', options.failedFixFields || null);
    }
  }
}

async function buildKnowledgeDecisions(attributes, knowledgeReference, productInfo) {
  const decisions = new Map();
  if (!knowledgeReference || !Array.isArray(knowledgeReference.knownAttributes)) return decisions;

  const knownByName = new Map(
    knowledgeReference.knownAttributes.map((item) => [normalizeKnowledgeName(item.name), item])
  );

  for (const attr of attributes || []) {
    const known = knownByName.get(normalizeKnowledgeName(attr.name));
    if (!known || !Array.isArray(known.commonValues) || !known.commonValues.length) continue;

    const decision = await decideFromKnowledge(attr, known, productInfo);
    if (decision && decision.value) decisions.set(attr.name, decision);
  }

  return decisions;
}

async function decideFromKnowledge(attr, known, productInfo) {
  const commonValues = known.commonValues
    .map((item) => ({
      value: String(item.value || '').trim(),
      count: Number(item.count || 0)
    }))
    .filter((item) => item.value);
  if (!commonValues.length) return null;

  if (attr.controlType === 'input') {
    const item = commonValues[0];
    return knowledgeDecision(item.value, item, 'knowledge_text', confidenceFromHistory(item), '命中本地类目知识库文本值');
  }

  if (attr.controlType === 'material_ratio_table') {
    const item = commonValues[0];
    return knowledgeDecision(item.value, item, 'knowledge_material', confidenceFromHistory(item), '命中本地类目知识库材质值');
  }

  if (attr.controlType === 'select') {
    if (!Array.isArray(attr.options) || !attr.options.length) return null;
    for (const item of commonValues) {
      const matched = await chooseBestOption({
        attrName: attr.name,
        inferredValue: item.value,
        availableOptions: attr.options,
        productTitle: productInfo.title,
        images: productInfo.images
      });
      if (!isReliableKnowledgeMatch(matched)) continue;
      return knowledgeDecision(
        matched.value,
        item,
        `knowledge_${matched.method}`,
        Math.min(Number(matched.confidence || 0), confidenceFromHistory(item)),
        `命中本地类目知识库：${item.value} -> ${matched.value}`
      );
    }
  }

  if (attr.controlType === 'multi_select') {
    if (!Array.isArray(attr.options) || !attr.options.length) return null;
    // 成分/材质约束同样作用于知识库历史值：材质只选一种，涤纶与聚酯不同时选
    const sanitized = sanitizeMaterialValues(attr.name, commonValues.map((item) => item.value));
    if (sanitized.note) console.log(`[成分] ${attr.name}: ${sanitized.note}`);
    const keptValues = new Set(sanitized.values);
    const matchedValues = [];
    const reasons = [];
    let confidence = 1;

    for (const item of commonValues.filter((item) => keptValues.has(item.value)).slice(0, 5)) {
      const matched = await chooseBestOption({
        attrName: attr.name,
        inferredValue: item.value,
        availableOptions: attr.options,
        productTitle: productInfo.title,
        images: productInfo.images
      });
      if (!isReliableKnowledgeMatch(matched) || matchedValues.includes(matched.value)) continue;
      matchedValues.push(matched.value);
      confidence = Math.min(confidence, Number(matched.confidence || 0), confidenceFromHistory(item));
      reasons.push(`${item.value}->${matched.value}`);
    }

    if (matchedValues.length) {
      return knowledgeDecision(
        matchedValues,
        { value: matchedValues.join(','), count: matchedValues.length },
        'knowledge_multi_match',
        confidence,
        `命中本地类目知识库：${reasons.join('; ')}${sanitized.note ? `；${sanitized.note}` : ''}`
      );
    }
  }

  return null;
}

function knowledgeDecision(value, source, method, confidence, reason) {
  return {
    value,
    sourceValue: source.value,
    method,
    confidence,
    reason
  };
}

function confidenceFromHistory(item) {
  return Math.min(0.96, 0.78 + Math.min(Number(item.count || 1), 6) * 0.03);
}

function isReliableKnowledgeMatch(decision) {
  return decision && decision.value && [
    'exact',
    'normalized',
    'synonym',
    'contains',
    'included_by',
    'fuzzy'
  ].includes(decision.method);
}

function normalizeKnowledgeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\\/:*?"<>|,.;'"`~!@#$%^&()[\]{}+=_-]/g, '')
    .trim();
}

/**
 * 批量预计算 secondChoice 结果，返回 Map(attrName -> result)。
 * 第一遍扫描时先调本地 matcher 收集需要 AI 二次选择的字段，一次性批量调用，
 * 第二遍用缓存结果完成匹配，避免 N 次串行网络请求。
 */
async function precomputeSecondChoice(attributes, aiByName, productInfo) {
  const t0 = Date.now();
  const needBatch = attributes.filter((attr) => {
    if (attr.controlType !== 'select' && attr.controlType !== 'multi_select') return false;
    const ai = aiByName.get(attr.name);
    if (!ai || !ai.value) return false;
    // 快速本地匹配测试：如果本地能精确匹配就不需要 AI
    const value = String(ai.value || '').trim();
    const options = (attr.options || []).map((o) => String(o || '').trim()).filter(Boolean);
    if (!value || !options.length) return false;
    if (options.includes(value)) return false;
    return true;
  });

  if (!needBatch.length) {
    console.log(`[耗时] precomputeSecondChoice: 无需AI ${Date.now() - t0}ms`);
    return new Map();
  }

  const inputs = needBatch.map((attr) => ({
    attrName: attr.name,
    inferredValue: aiByName.get(attr.name)?.value || '',
    availableOptions: attr.options || [],
    productTitle: productInfo.title || ''
  }));

  console.log(`[AI] 批量二次选择: ${needBatch.length} 个字段需 AI 判断`);
  const tAi = Date.now();
  const results = await secondChoiceBatch(inputs);
  console.log(`[耗时] secondChoiceBatch AI调用: ${Date.now() - tAi}ms`);
  const cache = new Map();
  needBatch.forEach((attr, i) => {
    if (results[i]) cache.set(attr.name, results[i]);
  });
  console.log(`[耗时] precomputeSecondChoice 总耗时: ${Date.now() - t0}ms, 缓存${cache.size}个`);
  return cache;
}

/** 纹理类字段（面料纹理/里料纹理）：优先选不会触发子属性的值，
 *  如 光面 会级联出"面料克重1"子必填，绒面/PU 和 无里料/无内衬 不会 */
const TEXTURE_FIELD_RE = /面料纹理|里料纹理/;
const TEXTURE_SAFE_VALUES = ['绒面/PU', '无里料/无内衬', '绒面'];

function textureSafeDecision(attr) {
  if (!TEXTURE_FIELD_RE.test(attr.name) || !Array.isArray(attr.options)) return null;
  // 按字段区分安全值：里料纹理设"无里料"才不触发子属性；面料纹理设"绒面/PU"不触发面料克重
  const isLining = /里料纹理/.test(attr.name);
  const preferred = isLining
    ? ['无里料/无内衬', '无里料', '无内衬', '无']
    : ['绒面/PU', '绒面'];
  const safe = preferred.find((v) => attr.options.includes(v));
  if (!safe) return null;
  return {
    value: safe,
    method: 'texture_no_child',
    confidence: 1,
    reason: `纹理字段优先选择无子属性的值（${safe}），避免级联出子必填`
  };
}

async function decideFinalValue(attr, ai, productInfo, secondChoiceCache = null) {
  const textureDecision = textureSafeDecision(attr);
  if (textureDecision) return textureDecision;

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
      aiAnalyzer: { secondChoice },
      secondChoiceCache
    });
  }

  if (attr.controlType === 'multi_select') {
    // 成分/材质约束：材质只选一种，涤纶与聚酯不同时选（先裁剪再匹配，省掉多余的二次 AI 调用）
    const sanitized = sanitizeMaterialValues(attr.name, ai.value);
    if (sanitized.note) console.log(`[成分] ${attr.name}: ${sanitized.note}`);
    const values = sanitized.values;
    if (!values.length) {
      return chooseBestOption({
        attrName: attr.name,
        inferredValue: ai.value,
        availableOptions: attr.options,
        productTitle: productInfo.title,
        images: productInfo.images,
        aiAnalyzer: { secondChoice },
        secondChoiceCache
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
        aiAnalyzer: { secondChoice },
        secondChoiceCache
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
      reason: `${reasons.join('; ')}${sanitized.note ? `；${sanitized.note}` : ''}`
    };
  }

  if (attr.controlType === 'material_ratio_table') {
    const materialValue = ai.value ? String(ai.value).trim() : null;
    if (!materialValue) {
      return {
        value: null,
        method: 'manual_required',
        confidence: 0,
        reason: 'AI 未给出材质值'
      };
    }
    return {
      value: materialValue,
      method: 'ai_material',
      confidence: Number(ai.confidence || 0),
      reason: ai.reason || 'AI 推断材质'
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
  if (/重量|克重|g\/|g㎡|密度|含量|比例|浓度|pH|PH|长|宽|高|尺寸|长度|宽度|高度/i.test(text)) return '40';
  return '不适用';
}

async function rewriteAndFillTitles(page, logger, productInfo, summary, corrections = {}, titleTask = null) {
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
    return '';
  }

  // titleTask 由流程开头提前发起（AI 与 DOM 操作并行）；未传入时在此现场生成
  let titles;
  try {
    titles = await (titleTask || startTitleGeneration(productInfo, corrections));
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
    return '';
  }
  if (!titles) return '';

  // corrections 命中时直接使用修正值（避免再次生成同样的错误标题）
  const isCorrection = Boolean(titles.__corrected);
  if (isCorrection) {
    console.log(`[标题] 使用 AI 修正值：产品标题=${(titles.japaneseTitle || '').slice(0, 30)}... 英文标题=${(titles.englishTitle || '').slice(0, 30)}...`);
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
      matchMethod: isCorrection ? 'ai_correction' : 'title_rewrite',
      confidence: 1,
      status: 'success',
      reason: isCorrection ? '使用 AI 修正值填写产品标题' : '已按日本搜索习惯扩写并填写日语标题'
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
      matchMethod: isCorrection ? 'ai_correction' : 'title_rewrite',
      confidence: 1,
      status: 'success',
      reason: isCorrection ? '使用 AI 修正值填写英文标题' : '已按日本搜索习惯扩写并填写英文标题'
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

  return (titles && titles.japaneseTitle) || '';
}

async function exportProductData(page, exporter, productInfo, japaneseTitle) {
  try {
    const [productUrl, skuData] = await Promise.all([
      readProductLink(page),
      readSkuTableData(page)
    ]);

    exporter.addProduct({
      imageUrl: skuData.thumbnailUrl || (productInfo.images && productInfo.images[0]) || '',
      productUrl: productUrl || productInfo.url || '',
      japaneseTitle: japaneseTitle || '',
      specifications: skuData.colors.join(', '),
      declaredPrice: skuData.declaredPrice
    });
  } catch (error) {
    console.warn(`[导出] 产品数据导出失败: ${error.message}`);
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

  // 面板外确定性必填字段（如 制造地点）预填：不等保存报错才发现，省一轮保存-修复循环
  // failedFixFields 记录修复尝试失败的字段名，供"同错复现且字段已修不动"时提前止损
  const failedFixFields = new Set();
  await prefillOutsideRequiredFields(page, config, logger, summary, productInfo, failedFixFields);

  // 保存次数上限 6：给"报错在变化=有进展"的链路留余地；
  // 同一报错连续 3 次修复无效则提前跳过该商品，不再空转
  const maxAttempts = 6;
  let lastResult = null;
  let lastMessage = '';
  let sameErrorCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await tryClickSave(page, config, attempt);
    if (lastResult.success) return lastResult;

    // 按钮缺失属于选择器/页面结构问题，AI 修正与重扫无意义，直接失败
    if (lastResult.buttonNotFound) {
      console.error('[保存] 页面上没有可见的保存按钮，跳过 AI 分析与重试。');
      break;
    }

    const message = lastResult.message || lastResult.reason || '未读取到保存失败原因';

    // 同一报错连续 3 次 → 修复无效，跳过该商品
    if (message === lastMessage) {
      sameErrorCount += 1;
    } else {
      sameErrorCount = 1;
      lastMessage = message;
    }
    if (sameErrorCount >= 3) {
      console.error(`[保存] 同一错误连续${sameErrorCount}次未修复，跳过该商品。原因：${message}`);
      break;
    }
    // 同错复现且本轮报错字段上一轮修复就已失败：再保存必然同样失败，提前止损（不烧满 3 轮熔断）
    const repeatedFields = extractRequiredFieldNames(message);
    if (sameErrorCount >= 2 && repeatedFields.length
      && repeatedFields.every((f) => failedFixFields.has(String(f).replace(/\s+/g, '').toLowerCase()))) {
      console.error(`[保存] 错误字段 ${repeatedFields.join('、')} 上轮修复已失败且本轮无进展，跳过该商品。原因：${message}`);
      break;
    }

    // SKU 规格值超长等无法通过重填属性修复的错误，重试也必然同样失败，直接跳过
    if (/SKU信息规格选项.*长度应不大于/.test(message)) {
      console.error('[保存] SKU规格值超长，无法自动修复，跳过重试。');
      break;
    }
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
    await closeFeedbackOverlays(page);

    // 校验类错误（"产品属性【xx】必填"或"制造地点需必填/xx不能为空"等）：
    // 按提示定位模块定向修复，不重跑标题/描述/SKU/导出
    const validationFields = extractRequiredFieldNames(message);
    if (validationFields.length && !/标题|SKU信息|价格|图片|重量|类目/.test(message)) {
      console.log(`[保存] 校验类错误，提取字段: ${validationFields.join('、')}`);
      // AI 建议修正值（如 制造地点=中国），供面板外字段直接填写；失败不阻断
      const corrections = {};
      try {
        const aiAnalysis = await analyzeSaveError(message, productInfo);
        if (aiAnalysis.corrections && aiAnalysis.corrections.length) {
          console.log(`[保存] AI 分析建议修正：${aiAnalysis.corrections.map((c) => `${c.fieldName}=${c.suggestedValue}`).join(', ')}`);
          for (const c of aiAnalysis.corrections) {
            const fn = String(c.fieldName || c.name || '').replace(/\s+/g, '').replace(/(需|要|还|缺|应)$/, '');
            if (fn && c.suggestedValue) corrections[fn] = c.suggestedValue;
          }
        }
      } catch (e) {
        console.warn(`[保存] AI 错误分析异常: ${e.message}`);
      }
      const fixSummary = createProductSummary();
      await fixAttributesForRetry(page, config, logger, fixSummary, productInfo, {
        categoryKnowledge,
        errorFields: validationFields,
        corrections,
        failedFixFields
      });
      mergeProductSummary(summary, fixSummary);
    } else {
      console.log('[保存] 关闭失败弹窗，调用 AI 分析错误原因...');
      const errorFields = parseErrorFields(message);
      console.log(`[保存] 从错误信息中提取到字段：${errorFields.join(', ') || '(无)'}`);

      // 构建修正值映射（传递给重试时使用）
      const corrections = {};
      try {
        const aiAnalysis = await analyzeSaveError(message, productInfo);
        if (aiAnalysis.corrections && aiAnalysis.corrections.length) {
          console.log(`[保存] AI 分析建议修正：${aiAnalysis.corrections.map((c) => `${c.fieldName}=${c.suggestedValue}`).join(', ')}`);
          for (const c of aiAnalysis.corrections) {
            const fn = c.fieldName || c.name || '';
            if (fn && !errorFields.includes(fn)) errorFields.push(fn);
            // 保存修正值供重试使用
            if (fn && c.suggestedValue) corrections[fn] = c.suggestedValue;
          }
        }
      } catch (e) {
        console.warn(`[保存] AI 错误分析异常: ${e.message}`);
      }

      console.log('[保存] 重新处理当前商品（包含错误字段），尝试更正后再次保存...');
      const retrySummary = createProductSummary();
      await processCurrentProduct(page, config, logger, retrySummary, {
        productIndex: `${productIndex} 重试${attempt}`,
        categoryKnowledge,
        errorFields,
        corrections
      });
      mergeProductSummary(summary, retrySummary);
    }
  }

  await closeFeedbackOverlays(page);
  const finalMessage = lastResult && (lastResult.message || lastResult.reason)
    ? lastResult.message || lastResult.reason
    : '保存失败';
  console.error(`[保存] 第 ${productIndex} 个商品保存失败，已跳过。原因：${finalMessage}`);
  return { success: false, skipped: false, message: finalMessage };
}

async function tryClickSave(page, config, attempt = 1) {
  console.log(`[保存] 第 ${attempt} 次尝试点击【保存修改】按钮...`);

  // 先关闭可能遮挡保存按钮的弹窗/对话框（如"图片翻译"等）
  await closeBlockingOverlays(page);

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
  // 页面上可能同时存在多个"保存修改"按钮（隐藏弹窗的 footer 在 DOM 前部，真实按钮在页面底部），
  // 必须遍历所有匹配取第一个可见可用的，不能只看 .first()
  for (const selector of candidates) {
    const buttons = page.locator(selector);
    const total = await buttons.count().catch(() => 0);
    for (let i = 0; i < Math.min(total, 8); i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      if (await isLocatorDisabled(button)) continue;
      await button.scrollIntoViewIfNeeded().catch(() => {});
      // 强制点击，绕过确认对话框的 pointer-events 拦截
      await button.click({ timeout: 5000, force: true });

      // 点击后等待 2s，让校验错误提示有机会渲染
      await page.waitForTimeout(2000);

      // 检测是否有校验错误提示（.el-message--error）
      const validationError = await getValidationError(page);
      if (validationError) {
        // 有错误 → 点击取消，返回错误信息供修正
        await clickSaveConfirmCancel(page);
        console.warn(`[保存] 校验不通过，取消保存：${validationError}`);
        return { success: false, reason: validationError, validationError: true };
      }

      // 无错误 → 点击确定确认保存
      await clickSaveConfirmOk(page);

      const feedback = await waitForSaveFeedback(page, config, selector);
      if (feedback.success) {
        console.log(`[保存] 保存成功：${feedback.message || feedback.reason}`);
      } else {
        console.warn(`[保存] 保存失败：${feedback.message || feedback.reason}`);
      }
      return feedback;
    }
  }
  console.warn('[保存] 没有找到可见的【保存修改】按钮。');
  return { success: false, reason: '没有找到可见的【保存修改】按钮', buttonNotFound: true };
}

/**
 * 获取校验错误提示文本（.el-message--error）
 * @returns {string|null} 错误文本，无错误返回 null
 */
async function getValidationError(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('.el-message--error .el-message__content, .el-message--error p, .jx-message--error .jx-message__content, .jx-message--error p');
    return el ? (el.innerText || el.textContent || '').trim() || null : null;
  }).catch(() => null);
}

/**
 * 点击保存确认对话框的"确定"按钮
 */
async function clickSaveConfirmOk(page) {
  // 可能有多个同名确认框（含隐藏残留），遍历取第一个可见的
  const okBtns = page.locator('.el-message-box__btns .el-button--primary, .el-message-box__btns button:has-text("确定"), .jx-message-box__btns .jx-button--primary, .jx-message-box__btns button:has-text("确定")');
  const total = await okBtns.count().catch(() => 0);
  for (let i = 0; i < Math.min(total, 4); i += 1) {
    const button = okBtns.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    return true;
  }
  return false;
}

/**
 * 点击保存确认对话框的"取消"按钮
 */
async function clickSaveConfirmCancel(page) {
  const cancelBtns = page.locator('.el-message-box__btns button:not(.el-button--primary), .el-message-box__btns button:has-text("取消"), .jx-message-box__btns button:not(.jx-button--primary), .jx-message-box__btns button:has-text("取消")');
  const total = await cancelBtns.count().catch(() => 0);
  for (let i = 0; i < Math.min(total, 4); i += 1) {
    const button = cancelBtns.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
    return true;
  }
  return false;
}

async function waitForSaveFeedback(page, config, saveSelector) {
  const timeout = Number(config.batch && config.batch.saveFeedbackTimeoutMs) || 6000;
  const started = Date.now();

  while (Date.now() - started < timeout) {
    await page.waitForTimeout(500).catch(() => {});
    // 保存过程中可能弹出"信息未填写完整，是否继续保存"确认框，自动点确定后继续等结果；
    // 若意外出现"是否确认离开"框则点取消留在当前商品
    await dismissBlockingDialogs(page);
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
      '.jx-message',
      '.jx-message__content',
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

async function closeBlockingOverlays(page) {
  await page.evaluate(() => {
    // 编辑对话框内的关键按钮选择器，包含这些按钮的对话框不应被关闭
    const editDialogButtons = '.J_collectBoxEditDialogCreateSave, .J_collectBoxEditDialogNext';
    const overlays = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], .jx-overlay-dialog, .el-dialog__wrapper, .el-dialog'));
    for (const overlay of overlays) {
      // 跳过包含编辑操作按钮的主编辑对话框
      if (overlay.querySelector(editDialogButtons)) continue;
      const closeBtn = overlay.querySelector('.el-dialog__close, .el-dialog__headerbtn, [class*="close"], [aria-label="Close"]');
      if (closeBtn) {
        closeBtn.click();
      }
    }
  }).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
  await closeFeedbackOverlays(page);
}

/**
 * 处理当前可见的 message-box 弹窗（jx/el/ant 通用）：
 * - "是否确认离开"类（离开后将不会保存）→ 点【取消】留在当前商品——填写/保存中途点确定会丢弃进度
 * - 其他提示框（是否继续保存、保存失败、系统提示）→ 点【确定】/【关闭】
 * 返回是否处理了一个弹窗。
 */
async function dismissBlockingDialogs(page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.jx-message-box, .el-message-box, .ant-modal-confirm'))
      .filter((box) => box.offsetWidth > 0 && box.offsetHeight > 0);
    if (!boxes.length) return false;

    const box = boxes[0];
    const text = String(box.innerText || '').replace(/\s+/g, '');
    const buttons = Array.from(box.querySelectorAll('button'))
      .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0);
    const norm = (b) => String(b.innerText || '').replace(/\s+/g, '');

    if (/确认离开/.test(text)) {
      const cancel = buttons.find((b) => /取消/.test(norm(b)));
      if (cancel) { cancel.click(); return true; }
    } else {
      const ok = buttons.find((b) => /确定|继续|知道了|保存/.test(norm(b)));
      if (ok) { ok.click(); return true; }
    }
    const closeIcon = box.querySelector('.jx-message-box__headerbtn, .el-message-box__headerbtn, [class*="close"]');
    if (closeIcon) { closeIcon.click(); return true; }
    return false;
  }).catch(() => false);
}

async function closeFeedbackOverlays(page) {
  let closed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await dismissBlockingDialogs(page))) break;
    closed = true;
    await page.waitForTimeout(300).catch(() => {});
  }
  if (!closed) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
  }
  return closed;
}

// 当前页最后一项已处理时：点击分页"下一页"（.pro-pagination .btn-next），再点新页第一个商品
async function clickNextPageAndFirstItem(page) {
  const pageClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.pro-pagination .btn-next'));
    const btn = btns.find((b) => !(b.disabled || b.getAttribute('aria-disabled') === 'true' || /disabled/i.test(b.className || '')));
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center', inline: 'nearest' });
    btn.click();
    return true;
  }).catch(() => false);
  if (!pageClicked) {
    console.warn('[下一商品] 没有可用的下一页按钮（可能已在最后一页）');
    return null;
  }
  console.log('[下一商品] 当前页已到最后一项，已点击下一页，等待列表刷新...');
  await page.waitForTimeout(1200).catch(() => {});

  // 点击新页第一个商品
  const first = await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    const items = Array.from(document.querySelectorAll('.goods-list-box .goods-item, .goods-item')).filter(visible);
    const item = items[0];
    if (!item) return { ok: false, reason: '翻页后未找到商品项' };
    const clickTarget = item.querySelector('.list-goods-item, .item-title, .goods-info, .goods-img-box') || item;
    const titleNode = item.querySelector('.item-title, [title]');
    const title = titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
    clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
    clickTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    clickTarget.click();
    return { ok: true, title };
  }).catch((error) => ({ ok: false, reason: error.message }));
  if (!first.ok) {
    console.warn(`[下一商品] ${first.reason}`);
    return null;
  }
  console.log(`[下一商品] 已点击新页第一个商品${first.title ? `：${first.title}` : ''}`);
  return first;
}

async function goToNextProduct(page, config, productInfo, productIndex) {
  console.log(`[下一商品] 第 ${productIndex} 个商品处理结束，尝试进入下一个商品...`);

  // 清理可能残留的提示弹窗，避免吞掉商品列表点击
  await closeFeedbackOverlays(page);

  const beforeUrl = page.url();
  const beforeTitle = await page.evaluate(() => {
    const active = document.querySelector('.goods-item.is-active, .goods-item.active, .goods-item.selected, .goods-item.current');
    const titleNode = active && active.querySelector('.item-title, [title]');
    return titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
  }).catch(() => '');

  const clickedGoodsList = await clickNextInGoodsList(page);
  if (clickedGoodsList) {
    await confirmLeaveIfPrompted(page);
    const goodsUrlChanged = page.url() !== beforeUrl;
    // 确认切换后商品加载需要时间，轮询等待 active 标题变化（最多约8秒）
    let goodsTitleChanged = false;
    for (let t = 0; t < 10 && !goodsTitleChanged; t += 1) {
      goodsTitleChanged = await page.evaluate((oldTitle) => {
        const active = document.querySelector('.goods-item.is-active, .goods-item.active, .goods-item.selected, .goods-item.current');
        const titleNode = active && active.querySelector('.item-title, [title]');
        const newTitle = titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
        return Boolean(newTitle) && newTitle !== oldTitle;
      }, beforeTitle).catch(() => false);
      if (!goodsTitleChanged) await page.waitForTimeout(800).catch(() => {});
    }
    if (goodsUrlChanged || goodsTitleChanged) {
      return { success: true, method: 'goods_list', title: clickedGoodsList.title || '' };
    }
    console.warn('[下一商品] 商品列表点击后页面和标题均未变化，视为停留在当前商品');
  }

  // 列表内已无下一项（当前页最后一项）→ 翻到下一页并点新页第一个商品
  const paged = await clickNextPageAndFirstItem(page);
  if (paged) {
    await confirmLeaveIfPrompted(page);
    let pagedTitleChanged = false;
    for (let t = 0; t < 12 && !pagedTitleChanged; t += 1) {
      await page.waitForTimeout(500).catch(() => {});
      // 处理"是否切换商品"弹窗
      await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.el-message-box, .jx-message-box'))
          .filter((box) => box.offsetWidth > 0 && box.offsetHeight > 0);
        const popup = boxes.find((box) => /切换|保存修改|确认离开/.test(box.innerText || ''));
        if (!popup) return false;
        const btn = popup.querySelector('.el-button--primary, .jx-button--primary');
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      pagedTitleChanged = await page.evaluate((oldTitle) => {
        const active = document.querySelector('.goods-item.is-active, .goods-item.active, .goods-item.selected, .goods-item.current');
        const titleNode = active && active.querySelector('.item-title, [title]');
        const title = titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
        return Boolean(title) && (!oldTitle || title !== oldTitle);
      }, beforeTitle).catch(() => false);
    }
    if (pagedTitleChanged) {
      console.log('[下一商品] 已翻页并切换到新页第一个商品');
      return { success: true, method: 'goods_pagination', title: paged.title || '' };
    }
    console.warn('[下一商品] 翻页点击后未检测到商品切换');
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
  const tryClickNext = () => page.evaluate(() => {
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

  const result = await tryClickNext();
  if (result.success) {
    console.log(`[下一商品] 已点击商品列表下一项${result.title ? `：${result.title}` : ''}`);
    const started = Date.now();
    let activeChanged = false;
    let reclicked = false;
    while (Date.now() - started < 12000) {
      await page.waitForTimeout(400).catch(() => {});

      const dismissed = await page.evaluate(() => {
        // 页面可能残留隐藏的 el-message-box，必须遍历找"可见"的那个（jx 或 el）
        const boxes = Array.from(document.querySelectorAll('.el-message-box, .jx-message-box'))
          .filter((box) => box.offsetWidth > 0 && box.offsetHeight > 0);
        if (!boxes.length) return false;
        const popup = boxes[0];
        const text = String(popup.innerText || '');
        if (!text.includes('切换') && !text.includes('保存修改') && !text.includes('确认离开')) return false;
        const btn = popup.querySelector('.el-button--primary, .jx-button--primary');
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (dismissed) {
        console.log('[下一商品] 检测到"是否切换商品"弹窗，已点击确定');
        await page.waitForTimeout(500).catch(() => {});
      }

      activeChanged = await page.evaluate((clickedTitle) => {
        const active = document.querySelector('.goods-list-box .goods-item.is-active, .goods-item.is-active, .goods-list-box .goods-item.active, .goods-item.active');
        const titleNode = active && active.querySelector('.item-title, [title]');
        const title = titleNode ? (titleNode.getAttribute('title') || titleNode.textContent || '').trim() : '';
        return clickedTitle ? Boolean(title) && (title.includes(clickedTitle) || clickedTitle.includes(title)) : Boolean(active);
      }, result.title || '').catch(() => false);
      if (activeChanged) break;

      // 首次点击可能被残留弹层吞掉：过半程 active 仍未变化时，清弹层后补点一次
      if (!reclicked && Date.now() - started > 6000) {
        reclicked = true;
        console.warn('[下一商品] active 未变化，清理弹层后重试点击下一项');
        await closeFeedbackOverlays(page);
        const again = await tryClickNext();
        if (again.success) {
          console.log(`[下一商品] 已重新点击下一项${again.title ? `：${again.title}` : ''}`);
        }
      }
    }

    if (!activeChanged) {
      const state = await page.evaluate(() => {
        const active = document.querySelector('.goods-item.is-active, .goods-item.active');
        const titleNode = active && active.querySelector('.item-title, [title]');
        return {
          有激活项: Boolean(active),
          当前标题: titleNode ? String(titleNode.getAttribute('title') || titleNode.textContent || '').trim().slice(0, 40) : ''
        };
      }).catch(() => ({}));
      console.warn(`[下一商品] 已触发点击，但没有检测到商品列表 active 状态变化。当前列表状态: ${JSON.stringify(state)}`);
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
  // 切商品上下文：可见的确认弹窗一律点"确定/继续/不保存"离开（jx/el/ant 通用，遍历避开隐藏残留）
  const clicked = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.el-message-box, .jx-message-box, .ant-modal-confirm'))
      .filter((box) => box.offsetWidth > 0 && box.offsetHeight > 0);
    if (!boxes.length) return false;
    const box = boxes[0];
    const buttons = Array.from(box.querySelectorAll('button'))
      .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0);
    const norm = (b) => String(b.innerText || '').replace(/\s+/g, '');
    const target = buttons.find((b) => /确定|继续|不保存|保存并切换/.test(norm(b)));
    if (target) { target.click(); return true; }
    return false;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(500).catch(() => {});
  return clicked;
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

function parseErrorFields(errorMessage) {
  const text = String(errorMessage || '');
  const fields = [];
  // 匹配【字段名】模式
  const bracketPattern = /【([^】]+)】/g;
  let match;
  while ((match = bracketPattern.exec(text)) !== null) {
    const field = match[1].trim();
    if (field && !fields.includes(field)) fields.push(field);
  }
  // 兜底：匹配字段名+错误描述模式
  const patterns = [
    /([^|，。、\s]{2,15})(?:不能为空|不能没|必填|请选择|未填写|有误)/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const field = m[1].trim();
      if (field && !fields.includes(field)) fields.push(field);
    }
  }

  // 中文错误信息 → 字段名映射（兜底）
  const errorFieldMap = [
    { patterns: [/英文标题/, /英文.*字符/, /英语标题/, /english/i], field: '英文标题' },
    { patterns: [/产品标题/, /商品标题/, /日语标题/], field: '产品标题' },
    { patterns: [/价格/, /申报价/], field: '价格' },
    { patterns: [/重量/], field: '重量' },
    { patterns: [/SKU/], field: 'SKU' },
    { patterns: [/类目/, /类别/], field: '类目' },
    { patterns: [/品牌/], field: '品牌' },
    { patterns: [/材质/], field: '材质' },
    { patterns: [/图片/], field: '图片' },
  ];
  for (const { patterns: reList, field } of errorFieldMap) {
    if (reList.some((re) => re.test(text)) && !fields.includes(field)) {
      fields.push(field);
    }
  }

  return fields;
}

function printSummary(summary, logger) {
  console.log('\n====== 本次处理汇总 ======');
  // 优先展示原始中文标题，便于人工识别
  const displayTitle = summary.originalTitle || summary.productTitle || '(未知)';
  console.log(`本次最后处理商品：${displayTitle}`);
  if (summary.totalProducts > 0) {
    console.log(`商品总数：${summary.totalProducts}`);
  }
  console.log(`处理商品数：${summary.products}`);
  console.log(`保存成功商品数：${summary.savedProducts}`);
  console.log(`保存失败跳过商品数：${summary.saveFailedProducts}`);
  if (summary.saveFailedTitles.length) {
    console.log(`保存失败商品（原始标题）：`);
    summary.saveFailedTitles.forEach((title, i) => console.log(`  ${i + 1}. ${title}`));
  }
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
