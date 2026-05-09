const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const { fork } = require('child_process');

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
  await prepareRuntime();
  createWindow();
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
  if (runningTask) {
    return { ok: false, error: '已有任务正在运行' };
  }
  if (!['login', 'fill'].includes(taskName)) {
    return { ok: false, error: `未知任务：${taskName}` };
  }

  const script = taskName === 'login' ? path.join(CODE_ROOT, 'src', 'login.js') : path.join(CODE_ROOT, 'src', 'main.js');
  runningTask = fork(script, [], {
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

  send('task:state', { running: true, taskName });
  send('task:log', { type: 'info', text: `启动任务：${taskName === 'login' ? '登录' : '开始填写'}` });

  runningTask.stdout.on('data', (chunk) => send('task:log', { type: 'stdout', text: chunk.toString() }));
  runningTask.stderr.on('data', (chunk) => send('task:log', { type: 'stderr', text: chunk.toString() }));
  runningTask.on('error', (error) => {
    send('task:log', { type: 'stderr', text: `${error.stack || error.message}\n` });
  });
  runningTask.on('exit', (code, signal) => {
    send('task:log', { type: code === 0 ? 'info' : 'stderr', text: `任务结束：code=${code ?? ''} signal=${signal || ''}\n` });
    runningTask = null;
    send('task:state', { running: false, taskName: '' });
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

function stopRunningTask() {
  if (!runningTask) return false;
  const child = runningTask;
  runningTask = null;
  child.kill();
  send('task:state', { running: false, taskName: '' });
  send('task:log', { type: 'info', text: '已请求停止当前任务\n' });
  return true;
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
