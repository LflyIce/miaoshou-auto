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
        const priceInputs = row.querySelectorAll('.cell-container .el-input__inner');
        for (const input of priceInputs) {
          const container = input.closest('.cell-container');
          if (!container) continue;
          const currency = container.querySelector('.price-currency');
          if (currency) {
            declaredPrice = (input.value || '').trim();
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
