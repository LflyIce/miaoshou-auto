const { sleep, unique } = require('./utils');

async function navigateToModule(page, moduleConfig = {}) {
  const name = moduleConfig.name || '类别&属性';
  const labels = unique([
    name,
    ...(moduleConfig.aliases || []),
    '类别&属性',
    '类目&属性',
    '分类&属性',
    '商品属性',
    '产品属性'
  ]);

  console.log(`[模块] 自动切换到：${name}`);

  for (const label of labels) {
    if (await clickVisibleModuleEntry(page, label)) {
      await waitAfterNavigationClick(page);
      return { success: true, method: 'click', label };
    }
  }

  const scrolled = await scrollToModule(page, labels);
  if (scrolled) {
    await sleep(500);
    return { success: true, method: 'scroll', label: scrolled };
  }

  return {
    success: false,
    method: 'not_found',
    label: name,
    reason: `没有找到模块入口：${labels.join(' / ')}`
  };
}

async function clickVisibleModuleEntry(page, label) {
  const candidates = [
    '[role="tab"]',
    '.el-tabs__item',
    '.ant-tabs-tab',
    '.el-menu-item',
    '.ant-menu-item',
    '.el-anchor-link-title',
    '.ant-anchor-link-title',
    '[class*="tab"]',
    '[class*="menu"]',
    '[class*="anchor"]',
    '[class*="nav"]',
    'button',
    'a'
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).filter({ hasText: label });
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i += 1) {
      const item = locator.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      try {
        await item.scrollIntoViewIfNeeded();
        await item.click({ timeout: 3000 });
        return true;
      } catch (_) {
        continue;
      }
    }
  }

  return clickByDomSearch(page, label);
}

async function clickByDomSearch(page, label) {
  return page.evaluate((targetLabel) => {
    const target = normalize(targetLabel);
    const selector = [
      '[role="tab"]',
      'button',
      'a',
      'li',
      '.el-tabs__item',
      '.ant-tabs-tab',
      '.el-menu-item',
      '.ant-menu-item',
      '.el-anchor-link-title',
      '.ant-anchor-link-title',
      '[class*="tab"]',
      '[class*="menu"]',
      '[class*="anchor"]',
      '[class*="nav"]'
    ].join(',');

    function normalize(text) {
      return String(text || '').replace(/\s+/g, '').replace(/＆/g, '&').trim();
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const nodes = Array.from(document.querySelectorAll(selector));
    const matched = nodes.find((node) => visible(node) && normalize(node.innerText || node.textContent).includes(target));
    if (!matched) return false;
    matched.scrollIntoView({ block: 'center', inline: 'center' });
    matched.click();
    return true;
  }, label).catch(() => false);
}

async function scrollToModule(page, labels) {
  return page.evaluate((targetLabels) => {
    const targets = targetLabels.map(normalize);
    const selector = [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'label',
      'span',
      'div',
      '.title',
      '[class*="title"]',
      '[class*="header"]',
      '.el-card__header',
      '.ant-card-head-title',
      '.el-collapse-item__header',
      '.ant-collapse-header'
    ].join(',');

    function normalize(text) {
      return String(text || '').replace(/\s+/g, '').replace(/＆/g, '&').trim();
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const nodes = Array.from(document.querySelectorAll(selector));
    const matched = nodes.find((node) => {
      if (!visible(node)) return false;
      const text = normalize(node.innerText || node.textContent);
      return targets.some((target) => text.includes(target));
    });

    if (!matched) return '';
    matched.scrollIntoView({ block: 'start', inline: 'nearest' });
    return (matched.innerText || matched.textContent || '').replace(/\s+/g, ' ').trim();
  }, labels).catch(() => '');
}

async function waitAfterNavigationClick(page) {
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}),
    sleep(1000)
  ]);
  await sleep(500);
}

module.exports = {
  navigateToModule
};
