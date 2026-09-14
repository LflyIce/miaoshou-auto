/**
 * 产品描述编辑器：删除文字模块
 * 新版界面（pddkj-description-editor-dialog，jx-overlay/jx-dialog + h5-editor）：
 * 点击"编辑描述" → 弹窗内"使用中模块"列表找到"文字"模块 → hover 后点击垃圾桶图标删除
 * →（如有确认框点确定）→ 点击保存。兼容旧版 collect-box-editor-dialog-V2 / h5-editor-dialog。
 *
 * 注意：商品编辑页本身也是弹窗容器（类名与旧版描述弹窗相同），绝不能当成描述弹窗去关闭——
 * 描述编辑弹窗内部必含 .h5-editor，以此判别；
 * V2 的图标对页面内 JS 合成点击不响应，必须用 Playwright 原生 click（真实鼠标事件）。
 */

// 弹窗选择器，按优先级排列（新版 pddkj → V2 → 旧版）
const DIALOG_SELECTORS = ['.pddkj-description-editor-dialog', '.collect-box-editor-dialog-V2', '.h5-editor-dialog'];

/** 按优先级取当前可见且内部含 .h5-editor 的描述编辑弹窗；不存在返回 null */
async function resolveEditorDialog(page) {
  for (const sel of DIALOG_SELECTORS) {
    const loc = page.locator(`${sel}:visible`).filter({ has: page.locator('.h5-editor') }).first();
    if (await loc.count().catch(() => 0)) return loc;
  }
  return null;
}

/** 文字模块项（新旧版结构一致：.active-module-item + .active-module-name"文字"），按名称 span 精确匹配 */
function textModuleLocator(page, dialog) {
  return dialog.locator('.active-module-item')
    .filter({ has: page.locator('.active-module-name', { hasText: /^文字/ }) });
}

/**
 * 诊断：列出页面当前可见的弹窗/抽屉类元素，用于弹窗选择器失效时定位真实类名。
 */
async function describeVisibleDialogs(page) {
  try {
    return await page.evaluate(() => {
      const found = [];
      document.querySelectorAll('.el-dialog, .el-drawer, .ant-modal, .ant-drawer, [class*="dialog"], [class*="editor"]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100 && found.length < 6) {
          found.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().slice(0, 80)}`);
        }
      });
      return found.join(' | ') || '';
    });
  } catch (_) {
    return '';
  }
}

/**
 * 等待弹窗可见。
 * 注意：locator.evaluate/isVisible 会对不存在元素自动等待（默认30s），
 * 必须先用 count()（立即返回）确认存在，否则会造成长时间无日志的假死。
 */
async function waitDialogVisible(page, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const dialog = await resolveEditorDialog(page);
    if (dialog) {
      const rect = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }).catch(() => null);
      if (rect && rect.w > 100 && rect.h > 100) return true;
    }
  }
  return false;
}

/** 等待指定弹窗关闭（定位器带 :visible，count()=0 即视为关闭），不受页面其他残留弹窗干扰 */
async function waitDialogClosed(page, dialog, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    if (!(await dialog.count().catch(() => 0))) return true;
  }
  return false;
}

async function cleanDescription(page) {
  console.log('[描述] 开始清理产品描述中的文字模块...');

  // 1. 点击"编辑描述"按钮打开弹窗
  const editBtn = page.locator('.preview-bottom-box').first();
  if (!(await editBtn.count().catch(() => 0))) {
    console.log('[描述] 未找到"编辑描述"按钮，跳过');
    return { status: 'skipped', deleted: 0, reason: '未找到编辑描述按钮' };
  }
  if (!(await editBtn.isVisible().catch(() => false))) {
    console.log('[描述] "编辑描述"按钮不可见，跳过');
    return { status: 'skipped', deleted: 0, reason: '编辑描述按钮不可见' };
  }

  await editBtn.click({ timeout: 5000 });
  console.log('[描述] 已点击"编辑描述"按钮');

  // 2. 等待弹窗打开
  if (!(await waitDialogVisible(page))) {
    const diag = await describeVisibleDialogs(page);
    const extraPages = page.context().pages().length - 1;
    console.warn(`[描述] 弹窗未打开，跳过（可见弹窗: ${diag || '无'}；新开标签页: ${extraPages}）`);
    return { status: 'skipped', deleted: 0, reason: '弹窗未打开' };
  }
  const dialog = await resolveEditorDialog(page);
  if (!dialog) {
    console.warn('[描述] 弹窗刚打开又不可见，跳过');
    return { status: 'skipped', deleted: 0, reason: '未能定位描述编辑弹窗' };
  }
  console.log('[描述] 弹窗已打开');

  // 3. 在"使用中模块"列表中逐个删除"文字"模块
  const deleteResult = await deleteTextModules(page, dialog);

  // 4. 有删除则点保存；没有也关闭弹窗（避免遮挡后续流程）
  if (deleteResult.deleted > 0) {
    await saveDescriptionDialog(page, dialog);
  } else {
    await closeDescriptionDialog(page, dialog);
  }

  return deleteResult;
}

async function deleteTextModules(page, dialog) {
  // 列表可能渐进渲染：短暂重试，避免弹窗刚打开就扫描漏掉文字模块
  let total = await textModuleLocator(page, dialog).count().catch(() => 0);
  for (let i = 0; !total && i < 6; i++) {
    const anyItem = await dialog.locator('.active-module-item').count().catch(() => 0);
    if (!anyItem) break; // 列表本身未渲染，等待无意义
    await page.waitForTimeout(500);
    total = await textModuleLocator(page, dialog).count().catch(() => 0);
  }
  if (!total) {
    const names = await dialog.locator('.active-module-name').allInnerTexts().catch(() => []);
    return { deleted: 0, reason: names.length ? `没有文字模块需要删除（使用中模块: ${names.join('、')}）` : '未找到使用中模块列表' };
  }
  console.log(`[描述] 检测到 ${total} 个文字模块，开始删除`);

  let deleted = 0;
  let remaining = total;
  for (let guard = 0; guard < total + 5 && remaining > 0; guard++) {
    const item = textModuleLocator(page, dialog).first();
    if (!(await item.count().catch(() => 0))) break;

    // 删除控件：V2 为 operate-box 内最后一个图标（垃圾桶，前两个是下移/复制）；旧版 .el-icon-delete
    const delBtn = item.locator('.active-module-operate-box i, .el-icon-delete').last();

    let clicked = true;
    try {
      await delBtn.click({ timeout: 3000 });
    } catch (_) {
      // 图标可能 hover 后才显示/可交互，悬停模块项后重试
      try {
        await item.hover({ timeout: 2000 });
        await delBtn.click({ timeout: 3000 });
      } catch (_e) {
        clicked = false;
      }
    }
    if (!clicked) {
      console.warn('[描述] 删除按钮点击失败，中断删除');
      break;
    }

    await page.waitForTimeout(300);
    await confirmDeleteIfAsked(page);

    // 等待该模块从列表消失（最多3s），确认点击生效
    let gone = false;
    for (let t = 0; t < 10; t++) {
      await page.waitForTimeout(300);
      const now = await textModuleLocator(page, dialog).count().catch(() => 0);
      if (now < remaining) {
        gone = true;
        remaining = now;
        break;
      }
    }
    if (!gone) {
      console.warn('[描述] 点击删除后模块未消失（可能被确认框拦截），中断删除');
      break;
    }
    deleted++;
  }

  const remainingLog = remaining > 0 ? `，剩余 ${remaining} 个未删除` : '';
  const reason = deleted > 0
    ? `已删除 ${deleted} 个文字模块${remainingLog}`
    : `文字模块删除未生效${remainingLog}`;
  console.log(`[描述] ${reason}`);
  return { deleted, reason };
}

/** 删除可能弹确认框，尝试点"确定"（覆盖常见弹层组件） */
async function confirmDeleteIfAsked(page) {
  try {
    const okBtn = page.locator([
      '.jx-overlay-dialog button:has-text("确定")',
      '.jx-message-box button:has-text("确定")',
      '.el-message-box button:has-text("确定")',
      '.el-popconfirm button:has-text("确定")',
      '.jx-popper button:has-text("确定")',
      '[class*="popconfirm"] button:has-text("确定")',
      '[class*="popover"] button:has-text("确定")'
    ].join(', ')).first();
    if ((await okBtn.count().catch(() => 0)) && (await okBtn.isVisible().catch(() => false))) {
      await okBtn.click({ timeout: 2000 });
      console.log('[描述] 已确认删除');
    }
  } catch (_) { /* 确认框不存在则忽略 */ }
}

async function saveDescriptionDialog(page, dialog) {
  // 新版/旧版头部 .dialog-header-right 内均为 取消 / 批量操作 / 保存（jx-button）。
  // 兼容按钮文字带空格（"保 存"）及非 button 元素渲染
  const saveBtn = dialog.locator('.dialog-header-right, .dialog-header, .jx-dialog__header').getByText(/保\s*存/).last()
    .or(dialog.getByText(/保\s*存/).last());
  if (!(await saveBtn.count().catch(() => 0))) {
    console.warn('[描述] 未找到弹窗保存按钮');
    await closeDescriptionDialog(page, dialog);
    return;
  }

  await saveBtn.click({ timeout: 5000 });
  console.log('[描述] 已点击保存按钮');

  if (await waitDialogClosed(page, dialog, 9000)) {
    console.log('[描述] 弹窗已关闭，保存成功');
    return;
  }
  console.warn('[描述] 保存后弹窗未关闭，重试一次');
  try {
    await saveBtn.click({ timeout: 3000 });
  } catch (_) { /* 忽略 */ }
  if (await waitDialogClosed(page, dialog, 6000)) {
    console.log('[描述] 弹窗已关闭，保存成功（重试）');
    return;
  }
  console.warn('[描述] 保存未生效，改为取消关闭弹窗');
  await closeDescriptionDialog(page, dialog);
}

async function closeDescriptionDialog(page, dialog) {
  // 兼容按钮文字带空格（"取 消"）及非 button 元素渲染：优先头部范围，找不到再全弹窗找
  let cancelBtn = dialog.locator('.dialog-header-right, .dialog-header, .jx-dialog__header').getByText(/取\s*消/).first();
  if (!(await cancelBtn.count().catch(() => 0))) {
    cancelBtn = dialog.getByText(/取\s*消/).first();
  }
  if (await cancelBtn.count().catch(() => 0)) {
    await cancelBtn.click({ timeout: 3000 }).catch(() => {});
    await confirmDeleteIfAsked(page); // 可能弹"未保存修改"确认框
    if (await waitDialogClosed(page, dialog, 3000)) return;
  }

  // 头部关闭（X）按钮：新版 jx-dialog 为 .jx-dialog__headerbtn，旧版为 dialog-header 内 close 图标
  const closeIcon = dialog.locator(
    '.jx-dialog__headerbtn, [aria-label="关闭此对话框"], .el-dialog__headerbtn, .dialog-header [class*="close"], [class*="dialog-close"]'
  ).first();
  if (await closeIcon.count().catch(() => 0)) {
    await closeIcon.click({ timeout: 2000 }).catch(() => {});
    await confirmDeleteIfAsked(page);
    if (await waitDialogClosed(page, dialog, 3000)) return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await confirmDeleteIfAsked(page);
  if (await waitDialogClosed(page, dialog, 3000)) return;

  // 仍未消失才输出头部结构，便于补充选择器（弹窗在尝试过程中已关闭则不再误报）
  if (await dialog.count().catch(() => 0)) {
    const headerInfo = await dialog.evaluate((el) => {
      const header = el.querySelector('.dialog-header, [class*="header"]');
      return ((header && header.outerHTML) || String(el.className)).replace(/\s+/g, ' ').slice(0, 400);
    }).catch(() => '');
    console.warn(`[描述] 弹窗未能关闭，可能遮挡后续流程（头部结构: ${headerInfo || '未知'}）`);
  }
}

module.exports = { cleanDescription };
