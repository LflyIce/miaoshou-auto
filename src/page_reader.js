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

async function readProductLink(page) {
  return page.evaluate(() => {
    const candidates = [
      '.list-goods-item.active .goods-other-info a',
      '.list-goods-item .goods-other-info a',
      '.goods-other-info a'
    ];

    for (const selector of candidates) {
      const link = document.querySelector(selector);
      if (link && link.href) return link.href;
    }

    return '';
  }).catch(() => '');
}

async function readTotalProductCount(page) {
  return page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function textOf(el) {
      return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    // 方法1：从分页器读取总数（如 "共 50 条" 或 "Total 50" 等）
    const paginationSelectors = [
      '.el-pagination__total',
      '.ant-pagination-total-text',
      '.el-pagination .total',
      '.pagination .total',
      '.el-pagination__sizes + .el-pagination__total',
      '[class*="pagination"] [class*="total"]',
      '[class*="pagination"]'
    ];
    for (const selector of paginationSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
      for (const node of nodes) {
        const text = textOf(node);
        const match = text.match(/(\d+)\s*(?:条|个|件|items?|products?|total|records?)/i);
        if (match) return { total: parseInt(match[1], 10), method: 'pagination_text', raw: text };
        const numMatch = text.match(/(\d+)/);
        if (numMatch && /共|total|全部|all/i.test(text)) return { total: parseInt(numMatch[1], 10), method: 'pagination_text', raw: text };
      }
    }

    // 方法2：从页面任意位置读取 "共 X 条/件/个" 文本
    const bodyText = textOf(document.body);
    const globalMatch = bodyText.match(/共\s*(\d+)\s*(?:条|个|件|items?|products?)/i);
    if (globalMatch) return { total: parseInt(globalMatch[1], 10), method: 'global_text', raw: globalMatch[0] };

    // 方法3：从右侧商品列表直接数 goods-item 数量，加上分页信息
    const listRoots = Array.from(document.querySelectorAll(
      '.goods-list-box, .goods-list, .pro-scrollbar.goods-list, [class*="goods-list"], [class*="product-list"]'
    )).filter(visible);

    let maxItemCount = 0;
    for (const root of listRoots) {
      const items = root.querySelectorAll('.goods-item');
      if (items.length > maxItemCount) maxItemCount = items.length;
    }

    if (maxItemCount > 0) {
      // 检查是否有分页且能读取到总页数或总条数
      const pagerText = document.querySelector('.el-pagination, .ant-pagination, [class*="pager"], [class*="pagination"]');
      if (pagerText) {
        const pt = textOf(pagerText);
        const pageNumMatch = pt.match(/(\d+)\s*(?:页|pages?)/i);
        const pageTotalMatch = pt.match(/(\d+)\s*(?:条|个|件|total)/i);
        if (pageTotalMatch) return { total: parseInt(pageTotalMatch[1], 10), method: 'list_with_pager', raw: pt };
        if (pageNumMatch) {
          const totalPages = parseInt(pageNumMatch[1], 10);
          if (totalPages > 1) return { total: totalPages * maxItemCount, method: 'list_pages_estimate', raw: pt };
        }
      }
      return { total: maxItemCount, method: 'list_count', raw: `商品列表项数: ${maxItemCount}` };
    }

    // 方法4：读取左侧/任意列表的列表项
    const listItems = Array.from(document.querySelectorAll('[class*="left"] [class*="item"], [class*="side"] [class*="item"]')).filter(visible);
    if (listItems.length > 0) return { total: listItems.length, method: 'left_list_count', raw: `左侧列表项数: ${listItems.length}` };

    return { total: 0, method: 'not_found', raw: '' };
  }).catch(() => ({ total: 0, method: 'error', raw: '' }));
}

async function readCurrentProductIndex(page) {
  return page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    // 从右侧商品列表中找到 active 项的索引
    const listRoots = Array.from(document.querySelectorAll(
      '.goods-list-box, .goods-list, .pro-scrollbar.goods-list, [class*="goods-list"], [class*="product-list"]'
    )).filter(visible);

    for (const root of listRoots) {
      const items = Array.from(root.querySelectorAll('.goods-item'));
      for (let i = 0; i < items.length; i++) {
        if (/\bactive\b|\bselected\b|\bcurrent\b|\bis-active\b/.test(`${items[i].className || ''}`)) {
          return { index: i + 1, total: items.length, method: 'goods_list_active' };
        }
      }
    }

    // 从左侧/任意列表中查找 active 项
    const activeSelector = '.active,.selected,.current,.is-active,[aria-selected="true"]';
    const activeNodes = Array.from(document.querySelectorAll(activeSelector)).filter((el) => {
      if (!visible(el)) return false;
      return el.getBoundingClientRect().left < window.innerWidth * 0.55;
    });

    for (const active of activeNodes) {
      let container = active.parentElement;
      for (let depth = 0; container && container !== document.body && depth < 6; depth += 1) {
        const children = Array.from(container.children).filter(visible);
        const index = children.findIndex((child) => child === active || child.contains(active));
        if (index >= 0 && children.length > 1) {
          return { index: index + 1, total: children.length, method: 'left_list_active' };
        }
        container = container.parentElement;
      }
    }

    return { index: 1, total: 0, method: 'not_found' };
  }).catch(() => ({ index: 1, total: 0, method: 'error' }));
}

async function readCurrentProductImageUrl(page) {
  return page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    // 从右侧商品列表的 active 项读取商品图片
    const listRoots = Array.from(document.querySelectorAll(
      '.goods-list-box, .goods-list, .pro-scrollbar.goods-list, [class*="goods-list"], [class*="product-list"]'
    )).filter(visible);

    for (const root of listRoots) {
      const items = Array.from(root.querySelectorAll('.goods-item'));
      for (const item of items) {
        if (!/\bactive\b|\bselected\b|\bcurrent\b|\bis-active\b/.test(`${item.className || ''}`)) continue;
        // 优先从 div.status-img-box 的 src 属性读取原始 URL
        const imgBox = item.querySelector('.status-img-box.goods-img, .goods-img');
        if (imgBox) {
          const divSrc = imgBox.getAttribute('src');
          if (divSrc) return divSrc;
        }
        // 兜底：从 img 标签读取
        const img = item.querySelector('.status-img-box img, .goods-img img, img');
        if (img) {
          const src = img.src || img.getAttribute('src') || '';
          // 去掉 webp 后缀
          return src.replace(/\.webp$/, '').replace(/_\.\w+$/, '');
        }
      }
    }

    return '';
  }).catch(() => '');
}

module.exports = {
  readProductInfo,
  readProductLink,
  readTotalProductCount,
  readCurrentProductIndex,
  readCurrentProductImageUrl
};
