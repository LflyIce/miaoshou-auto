const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { resolveRoot, nowForFile } = require('./utils');

const COLUMNS = [
  { header: '图片', key: 'imageUrl', width: 40 },
  { header: '产品地址', key: 'productUrl', width: 50 },
  { header: '日语标题', key: 'japaneseTitle', width: 60 },
  { header: '规格', key: 'specifications', width: 30 },
  { header: '申报价格', key: 'declaredPrice', width: 15 },
  { header: '采购成本', key: 'procurementCost', width: 15 }
];

class ProductExporter {
  constructor() {
    this.workbook = null;
    this.worksheet = null;
    this.filePath = '';
  }

  async init() {
    const dir = resolveRoot('data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const dateStr = nowForFile().split('_')[0];
    this.filePath = path.join(dir, `product_export_${dateStr}.xlsx`);

    if (fs.existsSync(this.filePath)) {
      this.workbook = new ExcelJS.Workbook();
      await this.workbook.xlsx.readFile(this.filePath);
      this.worksheet = this.workbook.worksheets[0];
      if (!this.worksheet) {
        this.worksheet = this.workbook.addWorksheet('产品数据');
        this._addHeader();
      }
    } else {
      this.workbook = new ExcelJS.Workbook();
      this.worksheet = this.workbook.addWorksheet('产品数据');
      this._addHeader();
    }

    console.log(`[导出] Excel文件: ${this.filePath}`);
  }

  _addHeader() {
    const headerRow = this.worksheet.addRow(COLUMNS.map((col) => col.header));
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };

    COLUMNS.forEach((col, index) => {
      this.worksheet.getColumn(index + 1).width = col.width;
    });
  }

  addProduct(record) {
    const price = parseFloat(record.declaredPrice) || 0;
    const cost = price > 0 ? Math.round((price / 4) * 100) / 100 : 0;

    this.worksheet.addRow({
      imageUrl: record.imageUrl || '',
      productUrl: record.productUrl || '',
      japaneseTitle: record.japaneseTitle || '',
      specifications: record.specifications || '',
      declaredPrice: price > 0 ? price : (record.declaredPrice || ''),
      procurementCost: cost
    });

    console.log(`[导出] 已写入第 ${this.worksheet.rowCount - 1} 条产品数据`);
  }

  async save() {
    if (!this.workbook || !this.filePath) return;
    await this.workbook.xlsx.writeFile(this.filePath);
    const count = this.worksheet.rowCount - 1;
    console.log(`[导出] 已保存 ${count} 条产品数据到 ${this.filePath}`);
  }
}

module.exports = {
  ProductExporter
};
