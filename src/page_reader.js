const { unique } = require('./utils');

async function readProductInfo(page) {
  const url = page.url();
  let title = '';
  let images = [];

  try {
    title = await readTitle(page);
  } catch (error) {
    console.warn(`[页面读取] 标题读取失败: ${error.message}`);
  }

  try {
    images = await readImages(page);
  } catch (error) {
    console.warn(`[页面读取] 图片读取失败: ${error.message}`);
  }

  return {
    title: title || '',
    images: unique(images).slice(0, 8),
    url
  };
}

async function readTitle(page) {
  const selectorCandidates = [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    'input[aria-label*="标题"]',
    'textarea[aria-label*="标题"]',
    'input[name*="title" i]',
    'textarea[name*="title" i]',
    'input[id*="title" i]',
    'textarea[id*="title" i]',
    'input[class*="title" i]',
    'textarea[class*="title" i]'
  ];

  for (const selector of selectorCandidates) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const value = await locator.inputValue().catch(() => '');
    if (value && value.trim().length > 1) return value.trim();
  }

  return page.evaluate(() => {
    function textOf(node) {
      return (node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    const controls = Array.from(document.querySelectorAll('input, textarea'));
    const scored = controls.map((el) => {
      const value = el.value || el.getAttribute('value') || '';
      const text = [
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('name') || '',
        el.getAttribute('id') || '',
        el.className || '',
        textOf(el.closest('.el-form-item, .ant-form-item, .form-item, tr, li, div'))
      ].join(' ');
      let score = 0;
      if (/商品标题|产品标题|标题|title/i.test(text)) score += 5;
      if (/标题/i.test(el.getAttribute('placeholder') || '')) score += 4;
      if (value.length >= 8) score += 2;
      if (value.length > 160) score -= 2;
      return { value: value.trim(), score };
    }).filter((item) => item.value);

    scored.sort((a, b) => b.score - a.score);
    return scored[0] ? scored[0].value : '';
  });
}

async function readImages(page) {
  return page.evaluate(() => {
    function absoluteUrl(url) {
      try {
        return new URL(url, window.location.href).href;
      } catch (_) {
        return '';
      }
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width >= 30 && rect.height >= 30 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(visible)
      .map((img) => {
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
        const parentText = (img.closest('[class*="main"], [class*="image"], [class*="pic"], [class*="upload"], li, div')?.innerText || '').slice(0, 120);
        const classText = `${img.className || ''} ${img.closest('[class]')?.className || ''}`;
        let score = 0;
        if (/主图|main|cover|首图|商品图|image|pic|upload/i.test(parentText + classText)) score += 5;
        if ((img.naturalWidth || 0) >= 200 && (img.naturalHeight || 0) >= 200) score += 2;
        if (/logo|avatar|icon|二维码|qrcode/i.test(src + parentText + classText)) score -= 5;
        return { src: absoluteUrl(src), score };
      })
      .filter((item) => item.src && !item.src.startsWith('data:'));

    imgs.sort((a, b) => b.score - a.score);
    return imgs.map((item) => item.src);
  });
}

module.exports = {
  readProductInfo
};
