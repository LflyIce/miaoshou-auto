const { app, BrowserWindow, ipcMain, shell, Menu, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const { fork } = require('child_process');
const ExcelJS = require('exceljs');

const CODE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_DIR = path.join(CODE_ROOT, 'config');
const DEFAULT_STORAGE_DIR = path.join(CODE_ROOT, 'storage');

let RUNTIME_ROOT = CODE_ROOT;
let CONFIG_PATH = path.join(RUNTIME_ROOT, 'config', 'config.json');
let ENV_PATH = path.join(RUNTIME_ROOT, '.env');
let DATA_DIR = path.join(RUNTIME_ROOT, 'data');
let STORAGE_DIR = path.join(RUNTIME_ROOT, 'storage');

let mainWindow = null;
let runningTask = null;
// 升级检查结果缓存：{ version, url, notes }，无新版时为 null
let updateInfo = null;

// 商品检索：按 fileName+mtime 缓存已解析的导出行，避免每次按键都全量解析 xlsx
const searchCache = new Map();
const SEARCH_RESULT_CAP = 200;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    title: '妙手属性助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // ① 隐藏 Electron 自带的 File/Edit/View 菜单栏
  Menu.setApplicationMenu(null);
  await prepareRuntime();
  createWindow();
  // 仅启动时检查一次更新（内部工具不需要周期复查，减少不必要的后台请求）
  checkForUpdate();
});

app.on('window-all-closed', () => {
  stopRunningTask();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('app:load-settings', async () => {
  const config = await readJSON(CONFIG_PATH, {});
  const env = await readEnv(ENV_PATH);
  return {
    config,
    apiKey: env.ZAI_API_KEY || '',
    version: app.getVersion(),
    paths: {
      root: RUNTIME_ROOT,
      codeRoot: CODE_ROOT,
      runtimeRoot: RUNTIME_ROOT,
      config: CONFIG_PATH,
      env: ENV_PATH,
      data: DATA_DIR,
      storage: STORAGE_DIR
    }
  };
});

ipcMain.handle('app:save-settings', async (_event, settings) => {
  const config = await readJSON(CONFIG_PATH, {});
  const nextConfig = mergeDeep(config, {
    headless: Boolean(settings.headless),
    productEditUrl: String(settings.productEditUrl || '').trim(),
    ai: {
      apiKeyEnv: 'ZAI_API_KEY',
      model: String(settings.model || config.ai && config.ai.model || 'glm-5.1').trim(),
      sendImages: Boolean(settings.sendImages)
    },
    behavior: {
      saveAfterFill: Boolean(settings.saveAfterFill),
      waitForManualPage: Boolean(settings.waitForManualPage)
    },
    batch: {
      maxProducts: Number(settings.maxProducts || 0)
    },
    temu: {
      multiplier: Number(settings.temuMultiplier || 2),
      priceCheckUrl: String(settings.temuPriceCheckUrl || '').trim()
    }
  });

  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

  const env = await readEnv(ENV_PATH);
  env.ZAI_API_KEY = String(settings.apiKey || '').trim();
  await writeEnv(ENV_PATH, env);

  return { ok: true };
});

ipcMain.handle('task:start', async (_event, taskName) => {
  if (!['login', 'fill', 'temu-login', 'temu-price'].includes(taskName)) {
    return { ok: false, error: `未知任务：${taskName}` };
  }

  // ② 切换任务：若有任务正在运行（含登录后未自动退出的情况），先停止再启动
  if (runningTask) {
    send('task:log', { type: 'info', text: '切换任务：先停止当前任务…\n' });
    await stopRunningTaskAndWait();
  }

  const scriptMap = {
    'login': ['src', 'login.js'],
    'fill': ['src', 'main.js'],
    'temu-login': ['src', 'temu', 'login_temu.js'],
    'temu-price': ['src', 'temu', 'price_check.js']
  };
  const script = path.join(CODE_ROOT, ...scriptMap[taskName]);
  const task = fork(script, [], {
    cwd: RUNTIME_ROOT,
    silent: true,
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FORCE_COLOR: '0',
      MIAOSHOU_DATA_ROOT: RUNTIME_ROOT
    }
  });

  runningTask = task;
  send('task:state', { running: true, taskName });
  const taskLabelMap = { 'login': '登录', 'fill': '开始填写', 'temu-login': '登录Temu', 'temu-price': 'Temu核价' };
  send('task:log', { type: 'info', text: `启动任务：${taskLabelMap[taskName] || taskName}\n` });

  task.stdout.on('data', (chunk) => send('task:log', { type: 'stdout', text: chunk.toString() }));
  task.stderr.on('data', (chunk) => send('task:log', { type: 'stderr', text: chunk.toString() }));
  task.on('error', (error) => {
    send('task:log', { type: 'stderr', text: `${error.stack || error.message}\n` });
  });
  task.on('exit', (code, signal) => {
    send('task:log', { type: code === 0 ? 'info' : 'stderr', text: `任务结束：code=${code ?? ''} signal=${signal || ''}\n` });
    // 仅当退出的仍是当前任务时才重置状态，避免切换任务时旧进程退出把新任务状态覆盖
    if (runningTask === task) {
      runningTask = null;
      send('task:state', { running: false, taskName: '' });
    }
  });

  return { ok: true };
});

ipcMain.handle('task:continue', async () => {
  if (!runningTask || !runningTask.stdin.writable) return { ok: false, error: '当前没有等待中的任务' };
  runningTask.stdin.write('\n');
  return { ok: true };
});

ipcMain.handle('task:stop', async () => {
  const stopped = stopRunningTask();
  return { ok: stopped };
});

ipcMain.handle('path:open', async (_event, target) => {
  const allowed = {
    root: RUNTIME_ROOT,
    code: CODE_ROOT,
    data: DATA_DIR,
    storage: STORAGE_DIR,
    config: path.dirname(CONFIG_PATH)
  };
  const resolved = allowed[target] || target;
  if (!resolved || !existsSync(resolved)) return { ok: false, error: '路径不存在' };
  const error = await shell.openPath(resolved);
  return error ? { ok: false, error } : { ok: true };
});

// ③ 填写历史：按日期列出 data/product_export_*.xlsx，并可打开指定日期的记录
ipcMain.handle('history:list', async () => {
  if (!existsSync(DATA_DIR)) return { items: [] };
  const items = [];
  for (const name of await fs.readdir(DATA_DIR)) {
    const m = name.match(/^product_export_(\d{8})\.xlsx$/i);
    if (!m) continue;
    const full = path.join(DATA_DIR, name);
    try {
      const stat = await fs.stat(full);
      items.push({
        fileName: name,
        date: dateLabel(m[1]),
        sizeKb: Math.round((stat.size / 1024) * 10) / 10,
        mtime: stat.mtime.toISOString()
      });
    } catch (_) {}
  }
  // 日期倒序（同日按修改时间倒序）
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.mtime < b.mtime ? 1 : -1)));
  return { items };
});

ipcMain.handle('history:open', async (_event, fileName) => {
  const file = path.join(DATA_DIR, path.basename(fileName || ''));
  if (!existsSync(file)) {
    return { ok: false, error: '填写记录不存在：' + (fileName || '(空)') };
  }
  const error = await shell.openPath(file);
  return error ? { ok: false, error } : { ok: true };
});

// 商品检索：在所有 product_export_*.xlsx 的「日语标题」列里按关键字子串匹配
// 导出列布局（表头第1行）：col2 产品地址 productUrl / col3 日语标题 japaneseTitle /
// col4 规格 specifications / col5 申报价格 declaredPrice
ipcMain.handle('history:search', async (_event, query) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !existsSync(DATA_DIR)) return { items: [] };

  const files = [];
  for (const name of await fs.readdir(DATA_DIR)) {
    const m = name.match(/^product_export_(\d{8})\.xlsx$/i);
    if (!m) continue;
    const full = path.join(DATA_DIR, name);
    try {
      const stat = await fs.stat(full);
      files.push({
        full,
        fileName: name,
        date: dateLabel(m[1]),
        key: `${name}::${stat.mtime.toISOString()}`
      });
    } catch (_) {}
  }
  // 日期倒序，与填写历史一致
  files.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.key < b.key ? 1 : -1)));

  const matches = [];
  for (const file of files) {
    let rows;
    try {
      rows = await parseExportRows(file.full, file.fileName, file.date, file.key);
    } catch (_) {
      // 文件被占用或损坏时跳过，不影响其它文件的检索
      continue;
    }
    for (const row of rows) {
      if (row.japaneseTitle.toLowerCase().includes(q)) {
        matches.push(row);
        if (matches.length >= SEARCH_RESULT_CAP) return { items: matches };
      }
    }
  }
  return { items: matches };
});

// 复制到剪贴板：渲染层是 file:// + contextIsolation，navigator.clipboard 不稳定，统一走主进程
ipcMain.handle('clipboard:write', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

// ⑤ 升级提示：渲染层启动时主动拉一次缓存结果（避免错过 ready 之后才完成的检查）
ipcMain.handle('update:status', () => updateInfo);

// 点「立即下载」：用默认浏览器打开清单里的下载地址
ipcMain.handle('update:open-download', async () => {
  if (!updateInfo || !updateInfo.url) return { ok: false, error: '没有可用的下载地址' };
  try {
    await shell.openExternal(updateInfo.url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// 把 YYYYMMDD 格式化为 YYYY-MM-DD（history:list 与 history:search 共用）
function dateLabel(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// 归一化 ExcelJS 单元格值：null / 原始值 / {richText} / {text} / {result}
function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value.richText)) return value.richText.map((t) => t.text || '').join('').trim();
  if (value.text != null) return String(value.text).trim();
  if (value.result != null) return String(value.result).trim();
  return String(value).trim();
}

// 解析单个导出文件为行对象数组（按 fileName+mtime 缓存）
async function parseExportRows(filePath, fileName, date, key) {
  const cached = searchCache.get(key);
  if (cached) return cached;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const ws = workbook.worksheets[0];
  const rows = [];
  if (ws) {
    const rowCount = ws.rowCount || 0;
    for (let r = 2; r <= rowCount; r += 1) {
      const row = ws.getRow(r);
      const japaneseTitle = cellText(row.getCell(3).value);
      if (!japaneseTitle) continue; // 跳过空标题行
      rows.push({
        fileName,
        date,
        japaneseTitle,
        specifications: cellText(row.getCell(4).value),
        declaredPrice: cellText(row.getCell(5).value),
        productUrl: cellText(row.getCell(2).value)
      });
    }
  }

  searchCache.set(key, rows);
  return rows;
}

// ④ 登录鉴权：游客直接进入（受限），管理员需账号密码（config/auth.json，缺省 admin/admin）
const DEFAULT_AUTH = { username: 'admin', password: 'admin' };

async function loadAuth() {
  const file = path.join(RUNTIME_ROOT, 'config', 'auth.json');
  if (!existsSync(file)) return { ...DEFAULT_AUTH, configured: false };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '');
    if (!username || !password) return { ...DEFAULT_AUTH, configured: false };
    return { username, password, configured: true };
  } catch (_) {
    return { ...DEFAULT_AUTH, configured: false };
  }
}

ipcMain.handle('auth:status', async () => {
  const auth = await loadAuth();
  return { configured: auth.configured };
});

ipcMain.handle('auth:login', async (_event, creds) => {
  const auth = await loadAuth();
  const username = String((creds && creds.username) || '').trim();
  const password = String((creds && creds.password) || '');
  if (username === auth.username && password === auth.password) {
    return { ok: true };
  }
  return { ok: false, error: '账号或密码错误' };
});

function stopRunningTask() {
  if (!runningTask) return false;
  const child = runningTask;
  runningTask = null;
  child.kill();
  send('task:state', { running: false, taskName: '' });
  send('task:log', { type: 'info', text: '已请求停止当前任务\n' });
  return true;
}

// 停止当前任务并等待其退出（最多 1.5s），用于切换任务时清理上一个子进程
async function stopRunningTaskAndWait() {
  const child = runningTask;
  if (!child) return;
  runningTask = null;
  try { child.kill(); } catch (_) {}
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// 版本比较：按 "." 分段数值比较，返回 -1/0/1。仅支持 "1.2.3" 这类纯数字段
function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

// 拉取服务器上的版本清单，发现新版则缓存并通知渲染层。任何异常都静默忽略，绝不弹错给用户
async function checkForUpdate() {
  const updateCfg = (await readJSON(CONFIG_PATH, {})).update || {};
  const manifestUrl = String(updateCfg.manifestUrl || '').trim();
  if (!manifestUrl) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(manifestUrl);
  } catch (_) {
    console.warn(`[升级] 清单地址非法，跳过检查：${manifestUrl}`);
    return;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    console.warn(`[升级] 仅支持 http/https 清单地址，跳过：${manifestUrl}`);
    return;
  }

  let remote;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await net.fetch(manifestUrl, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.warn(`[升级] 清单请求失败：HTTP ${resp.status}`);
      return;
    }
    remote = await resp.json();
  } catch (error) {
    console.warn(`[升级] 检查更新出错（已忽略）：${error.message || error}`);
    return;
  }

  const version = String(remote.version || '').trim();
  const url = String(remote.url || '').trim();
  const notes = String(remote.notes || '').trim();
  if (!version || !url) {
    console.warn('[升级] 清单缺少 version 或 url，跳过');
    return;
  }
  if (compareVersions(version, app.getVersion()) > 0) {
    updateInfo = { version, url, notes };
    send('update:available', updateInfo);
    console.log(`[升级] 发现新版本 ${version}（当前 ${app.getVersion()}）`);
  }
}

async function prepareRuntime() {
  RUNTIME_ROOT = app.isPackaged ? app.getPath('userData') : CODE_ROOT;
  CONFIG_PATH = path.join(RUNTIME_ROOT, 'config', 'config.json');
  ENV_PATH = path.join(RUNTIME_ROOT, '.env');
  DATA_DIR = path.join(RUNTIME_ROOT, 'data');
  STORAGE_DIR = path.join(RUNTIME_ROOT, 'storage');

  await Promise.all([
    fs.mkdir(path.join(RUNTIME_ROOT, 'config'), { recursive: true }),
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(path.join(DATA_DIR, 'screenshots'), { recursive: true }),
    fs.mkdir(STORAGE_DIR, { recursive: true })
  ]);

  await copyMissingDirFiles(DEFAULT_CONFIG_DIR, path.join(RUNTIME_ROOT, 'config'));
  await syncBundledDefaults();
  await copyMissingFile(
    path.join(DEFAULT_STORAGE_DIR, 'category_attribute_knowledge.json'),
    path.join(STORAGE_DIR, 'category_attribute_knowledge.json')
  );

  if (!existsSync(ENV_PATH)) {
    await fs.writeFile(ENV_PATH, 'ZAI_API_KEY=\n', 'utf8');
  }
}

async function copyMissingDirFiles(fromDir, toDir) {
  try {
    const items = await fs.readdir(fromDir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isFile()) continue;
      await copyMissingFile(path.join(fromDir, item.name), path.join(toDir, item.name));
    }
  } catch (_) {}
}

async function copyMissingFile(from, to) {
  if (existsSync(to) || !existsSync(from)) return;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

// 仅由打包包维护、UI 不会修改的开发者配置键：升级时始终以打包包为准，避免旧值残留
const DEVELOPER_CONFIG_KEYS = ['startUrl', 'browser', 'thresholds', 'modules', 'knowledgeBase', 'update'];

async function syncBundledDefaults() {
  const bundledPath = path.join(DEFAULT_CONFIG_DIR, 'config.json');
  if (!existsSync(bundledPath) || !existsSync(CONFIG_PATH)) return;

  let bundled;
  let current;
  try {
    bundled = JSON.parse(await fs.readFile(bundledPath, 'utf8'));
    current = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.warn(`[配置] 同步默认配置失败: ${error.message}`);
    return;
  }

  let changed = false;
  const ensureAi = () => { if (!current.ai) current.ai = {}; };
  // ai.baseURL / ai.maxTokens 嵌套在用户可改的 ai 对象里，单独同步这两个开发者字段
  if (bundled.ai) {
    if (bundled.ai.baseURL != null && (current.ai || {}).baseURL !== bundled.ai.baseURL) {
      ensureAi();
      current.ai.baseURL = bundled.ai.baseURL;
      changed = true;
    }
    if (bundled.ai.maxTokens != null && (current.ai || {}).maxTokens !== bundled.ai.maxTokens) {
      ensureAi();
      current.ai.maxTokens = bundled.ai.maxTokens;
      changed = true;
    }
  }
  // 顶层纯开发者键整体覆盖（UI 从不写入这些键）
  for (const key of DEVELOPER_CONFIG_KEYS) {
    if (bundled[key] !== undefined && JSON.stringify(current[key]) !== JSON.stringify(bundled[key])) {
      current[key] = bundled[key];
      changed = true;
    }
  }

  if (changed) {
    try {
      await fs.writeFile(CONFIG_PATH, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      console.log('[配置] 已同步打包包内的开发者默认配置（baseURL/thresholds 等）');
    } catch (error) {
      console.warn(`[配置] 写入同步后的配置失败: ${error.message}`);
    }
  }
}

async function readEnv(file) {
  const result = {};
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index < 0) continue;
      result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
  } catch (_) {}
  return result;
}

async function writeEnv(file, values) {
  const lines = Object.entries(values)
    .filter(([key]) => key)
    .map(([key, value]) => `${key}=${value}`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

function mergeDeep(target, source) {
  const output = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeDeep(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}
