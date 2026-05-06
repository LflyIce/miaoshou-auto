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
      const stat = fs.statSync(this.filePath);
      console.log(`[导出-DEBUG] init 发现已有文件: ${this.filePath} (${stat.size} 字节)`);
      this.workbook = new ExcelJS.Workbook();
      await this.workbook.xlsx.readFile(this.filePath);
      this.worksheet = this.workbook.worksheets[0];
      if (!this.worksheet) {
        console.log(`[导出-DEBUG] init 已有文件无 worksheet，新建`);
        this.worksheet = this.workbook.addWorksheet('产品数据');
        this._addHeader();
      } else {
        console.log(`[导出-DEBUG] init 已有文件 worksheet 行数: ${this.worksheet.rowCount}`);
        // 重新绑定列 key 映射，确保后续 addRow({key: value}) 能正确对应
        this.worksheet.columns = COLUMNS.map((col, index) => {
          const existing = this.worksheet.getColumn(index + 1);
          return {
            header: existing.header || col.header,
            key: col.key,
            width: existing.width || col.width
          };
        });
      }
    } else {
      console.log(`[导出-DEBUG] init 新建文件: ${this.filePath}`);
      this.workbook = new ExcelJS.Workbook();
      this.worksheet = this.workbook.addWorksheet('产品数据');
      this._addHeader();
    }

    console.log(`[导出] Excel文件: ${this.filePath}`);
  }

  _addHeader() {
    // 用 columns 属性定义列，确保 key 映射正确，addRow 时对象属性能对应到正确列
    this.worksheet.columns = COLUMNS.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width
    }));
    const headerRow = this.worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };
  }

  addProduct(record) {
    const price = parseFloat(record.declaredPrice) || 0;
    const cost = price > 0 ? Math.round((price / 4) * 100) / 100 : 0;

    console.log(`[导出-DEBUG] addProduct 调用前 worksheet 行数: ${this.worksheet ? this.worksheet.rowCount : 'worksheet为null'}`);
    console.log(`[导出-DEBUG] addProduct 数据: imageUrl=${(record.imageUrl || '').slice(0, 60)}, productUrl=${(record.productUrl || '').slice(0, 60)}, japaneseTitle=${(record.japaneseTitle || '').slice(0, 40)}, specs=${(record.specifications || '').slice(0, 40)}, price=${record.declaredPrice}`);

    this.worksheet.addRow({
      imageUrl: record.imageUrl || '',
      productUrl: record.productUrl || '',
      japaneseTitle: record.japaneseTitle || '',
      specifications: record.specifications || '',
      declaredPrice: price > 0 ? price : (record.declaredPrice || ''),
      procurementCost: cost
    });

    console.log(`[导出-DEBUG] addProduct 调用后 worksheet 行数: ${this.worksheet.rowCount}, 数据行: ${this.worksheet.rowCount - 1}`);
  }

  async save() {
    if (!this.workbook || !this.filePath) {
      console.log(`[导出-DEBUG] save 跳过: workbook=${!!this.workbook}, filePath=${this.filePath || '(空)'}`);
      return;
    }
    try {
      const beforeRowCount = this.worksheet.rowCount;
      console.log(`[导出-DEBUG] save 写入前 worksheet.rowCount=${beforeRowCount}, filePath=${this.filePath}`);
      const buffer = await this.workbook.xlsx.writeBuffer();
      console.log(`[导出-DEBUG] writeBuffer 大小: ${buffer ? buffer.length : 'null'}`);
      fs.writeFileSync(this.filePath, Buffer.from(buffer));
      // 写入后立即回读验证
      const verifyWb = new ExcelJS.Workbook();
      await verifyWb.xlsx.readFile(this.filePath);
      const verifyWs = verifyWb.worksheets[0];
      const verifyCount = verifyWs ? verifyWs.rowCount : -1;
      const stat = fs.statSync(this.filePath);
      console.log(`[导出-DEBUG] save 完成后验证: 文件=${stat.size}字节, 写入前行数=${beforeRowCount}, 回读行数=${verifyCount}`);
    } catch (error) {
      console.error(`[导出-DEBUG] save 失败: ${error.message}\n${error.stack}`);
      try {
        const backupPath = this.filePath.replace('.xlsx', '_backup.xlsx');
        const buffer = await this.workbook.xlsx.writeBuffer();
        fs.writeFileSync(backupPath, Buffer.from(buffer));
        console.log(`[导出-DEBUG] 已保存到备用文件: ${backupPath}`);
      } catch (e2) {
        console.error(`[导出-DEBUG] 备用保存也失败: ${e2.message}`);
      }
    }
  }
}

module.exports = {
  ProductExporter
};
