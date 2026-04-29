const fs = require('fs');
const ExcelJS = require('exceljs');
const { ensureProjectDirs, resolveRoot } = require('./utils');

const LOG_COLUMNS = [
  'time',
  'pageUrl',
  'productTitle',
  'attributeName',
  'controlType',
  'options',
  'aiValue',
  'finalValue',
  'matchMethod',
  'confidence',
  'status',
  'reason'
];

const FAILED_COLUMNS = [...LOG_COLUMNS, 'screenshot', 'error'];

function normalizeCell(value) {
  if (Array.isArray(value)) return value.join(' | ');
  if (value && typeof value === 'object') return JSON.stringify(value, null, 0);
  if (value == null) return '';
  return String(value);
}

async function readExistingRows(filePath, columns) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const headers = [];
    sheet.getRow(1).eachCell((cell, index) => {
      headers[index] = String(cell.value || '').trim();
    });
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record = {};
      for (let i = 1; i <= headers.length; i += 1) {
        if (!headers[i]) continue;
        record[headers[i]] = normalizeCell(row.getCell(i).value);
      }
      if (columns.some((column) => record[column])) rows.push(record);
    });
    return rows;
  } catch (error) {
    console.warn(`[日志] 读取旧日志失败，将创建新文件: ${error.message}`);
    return [];
  }
}

async function writeWorkbook(filePath, columns, rows, sheetName) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((column) => ({
    header: column,
    key: column,
    width: column === 'reason' || column === 'options' ? 42 : 22
  }));
  for (const row of rows) {
    const normalized = {};
    for (const column of columns) normalized[column] = normalizeCell(row[column]);
    sheet.addRow(normalized);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
  });
  await workbook.xlsx.writeFile(filePath);
}

class RunLogger {
  constructor() {
    this.logFile = resolveRoot('data', 'logs.xlsx');
    this.failedFile = resolveRoot('data', 'failed_items.xlsx');
    this.logs = [];
    this.failures = [];
  }

  async init() {
    await ensureProjectDirs();
    this.logs = await readExistingRows(this.logFile, LOG_COLUMNS);
    this.failures = await readExistingRows(this.failedFile, FAILED_COLUMNS);
  }

  log(record) {
    const normalized = {
      time: new Date().toISOString(),
      ...record
    };
    this.logs.push(normalized);
    const icon = normalized.status === 'success' ? 'OK' : normalized.status === 'failed' ? 'FAIL' : 'SKIP';
    console.log(`[${icon}] ${normalized.attributeName || '-'} -> ${normalizeCell(normalized.finalValue || normalized.aiValue)} ${normalized.reason ? `(${normalized.reason})` : ''}`);
  }

  fail(record) {
    const normalized = {
      time: new Date().toISOString(),
      status: 'failed',
      ...record
    };
    this.logs.push(normalized);
    this.failures.push(normalized);
    console.log(`[FAIL] ${normalized.attributeName || '-'}: ${normalized.error || normalized.reason || 'unknown error'}`);
  }

  async save() {
    await ensureProjectDirs();
    await writeWorkbook(this.logFile, LOG_COLUMNS, this.logs, 'logs');
    await writeWorkbook(this.failedFile, FAILED_COLUMNS, this.failures, 'failed');
    console.log(`[日志] 已写入 ${this.logFile}`);
    console.log(`[日志] 已写入 ${this.failedFile}`);
  }
}

module.exports = {
  RunLogger,
  LOG_COLUMNS,
  FAILED_COLUMNS
};
