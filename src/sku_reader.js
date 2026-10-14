async function readSkuTableData(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.jx-pro-virtual-table__row'));
    const colors = [];
    let declaredPrice = '';
    let thumbnailUrl = '';

    for (const row of rows) {
      const colorCell = row.querySelector('.jx-pro-virtual-table__row-cell.is-last-column');
      if (colorCell) {
        const color = (colorCell.textContent || '').trim();
        if (color) colors.push(color);
      }

      if (!thumbnailUrl) {
        const img = row.querySelector('.thumbnail-box img');
        if (img) thumbnailUrl = img.src || img.getAttribute('src') || '';
      }

      if (!declaredPrice) {
        // 申报价单元格定位：带货币符号/价格类名的单元格，兼容 el/jx 两套组件的输入框
        const cells = row.querySelectorAll('.jx-pro-virtual-table__row-cell, .cell-container');
        for (const cell of cells) {
          const cls = `${cell.className || ''}`;
          const text = cell.textContent || '';
          const isPriceCell = Boolean(cell.querySelector('.price-currency'))
            || /price|currency|申报/i.test(cls)
            || /[¥￥]/.test(text);
          if (!isPriceCell) continue;
          const input = cell.querySelector('input');
          const v = input ? (input.value || '').trim() : '';
          if (/^\d+(?:\.\d+)?$/.test(v)) {
            declaredPrice = v;
            break;
          }
          // 只读展示时从单元格文本提取数字
          const m = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
          if (m) {
            declaredPrice = m[0];
            break;
          }
        }
      }
    }

    return {
      colors,
      declaredPrice,
      thumbnailUrl,
      rowCount: rows.length
    };
  }).catch((error) => {
    console.warn(`[SKU读取] 读取SKU表格失败: ${error.message}`);
    return { colors: [], declaredPrice: '', thumbnailUrl: '', rowCount: 0 };
  });
}

async function readSpecInputValues(page) {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder="请输入选项名称"]'));
    return inputs
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((input) => (input.value || '').trim())
      .filter(Boolean);
  }).catch((error) => {
    console.warn(`[SKU读取] 读取规格输入值失败: ${error.message}`);
    return null;
  });
}

module.exports = {
  readSkuTableData,
  readSpecInputValues
};
