/**
 * 产品描述编辑器：删除文字模块
 * 流程：点击"编辑描述" → 在弹窗左侧"使用中模块"列表找到"文字"模块 → 点击删除 → 点击保存
 */

async function cleanDescription(page) {
  console.log('[描述] 开始清理产品描述中的文字模块...');

  // 1. 点击"编辑描述"按钮打开弹窗
  const editBtn = page.locator('.preview-bottom-box').first();
  if (!(await editBtn.count().catch(() => 0))) {
    console.log('[描述] 未找到"编辑描述"按钮，跳过');
    return { status: 'skipped', reason: '未找到编辑描述按钮' };
  }
  if (!(await editBtn.isVisible().catch(() => false))) {
    console.log('[描述] "编辑描述"按钮不可见，跳过');
    return { status: 'skipped', reason: '编辑描述按钮不可见' };
  }

  await editBtn.click({ timeout: 5000 });
  console.log('[描述] 已点击"编辑描述"按钮');

  // 2. 等待弹窗打开
  const dialog = page.locator('.h5-editor-dialog').first();
  let dialogVisible = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const style = await dialog.evaluate((el) => el.style.display).catch(() => 'none');
    if (style !== 'none') {
      dialogVisible = true;
      break;
    }
  }
  if (!dialogVisible) {
    console.log('[描述] 弹窗未打开，跳过');
    return { status: 'skipped', reason: '弹窗未打开' };
  }
  console.log('[描述] 弹窗已打开');

  // 3. 在左侧"使用中模块"列表中查找"文字"模块并删除
  const deleteResult = await deleteTextModules(page);

  // 4. 点击弹窗右上角"保存"按钮
  if (deleteResult.deleted > 0) {
    await saveDescriptionDialog(page);
  } else {
    // 没有删除任何模块，关闭弹窗
    await closeDescriptionDialog(page);
  }

  return deleteResult;
}

async function deleteTextModules(page) {
  const result = await page.evaluate(() => {
    const moduleList = document.querySelector('.h5-editor-dialog .active-module-list');
    if (!moduleList) {
      return { deleted: 0, reason: '未找到使用中模块列表' };
    }

    const items = Array.from(moduleList.querySelectorAll('.active-module-item'));
    let deleted = 0;

    // 收集所有文字模块（从后往前删除，避免索引变化）
    const textItems = items.filter((item) => {
      const nameEl = item.querySelector('.active-module-name');
      return nameEl && nameEl.textContent.trim() === '文字';
    });

    if (textItems.length === 0) {
      return { deleted: 0, reason: '没有文字模块需要删除' };
    }

    // 从后往前点击删除按钮
    for (let i = textItems.length - 1; i >= 0; i--) {
      const deleteIcon = textItems[i].querySelector('.el-icon-delete');
      if (deleteIcon) {
        deleteIcon.click();
        deleted++;
      }
    }

    return { deleted, reason: `已删除 ${deleted} 个文字模块` };
  });

  if (result.deleted > 0) {
    console.log(`[描述] ${result.reason}`);
    await page.waitForTimeout(500);
  } else {
    console.log(`[描述] ${result.reason}`);
  }

  return result;
}

async function saveDescriptionDialog(page) {
  // 点击弹窗内的保存按钮（dialog-header-right 中的最后一个保存按钮）
  const saveBtn = page.locator('.h5-editor-dialog .dialog-header-right button:has-text("保存")').last();
  if (!(await saveBtn.count().catch(() => 0))) {
    console.warn('[描述] 未找到弹窗保存按钮');
    await closeDescriptionDialog(page);
    return;
  }

  await saveBtn.click({ timeout: 5000 });
  console.log('[描述] 已点击保存按钮');

  // 等待弹窗关闭
  const dialog = page.locator('.h5-editor-dialog').first();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const style = await dialog.evaluate((el) => el.style.display).catch(() => 'none');
    if (style === 'none') {
      console.log('[描述] 弹窗已关闭，保存成功');
      return;
    }
  }
  console.warn('[描述] 保存后弹窗未关闭，尝试手动关闭');
  await closeDescriptionDialog(page);
}

async function closeDescriptionDialog(page) {
  const cancelBtn = page.locator('.h5-editor-dialog .dialog-header-right button:has-text("取消")').first();
  if ((await cancelBtn.count().catch(() => 0)) && (await cancelBtn.isVisible().catch(() => false))) {
    await cancelBtn.click({ timeout: 3000 }).catch(() => {});
  } else {
    // 尝试按 Escape 关闭
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(500);
}

module.exports = { cleanDescription };
