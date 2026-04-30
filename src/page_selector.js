function isUsablePage(page) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
  const url = typeof page.url === 'function' ? page.url() : '';
  return Boolean(url && url !== 'about:blank');
}

function chooseManualPage(pages, currentPage) {
  const usablePages = (pages || []).filter(isUsablePage);
  if (!usablePages.length) return currentPage;
  return usablePages[usablePages.length - 1] || currentPage;
}

async function activateManualPage(context, currentPage) {
  const selected = chooseManualPage(context.pages(), currentPage);
  if (selected && selected !== currentPage) {
    console.log(`[页面] 检测到新的浏览器标签，切换到: ${selected.url()}`);
  }
  await selected.bringToFront().catch(() => {});
  await selected.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  return selected;
}

module.exports = {
  activateManualPage,
  chooseManualPage
};
