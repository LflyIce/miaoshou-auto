const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = process.env.MIAOSHOU_DATA_ROOT
  ? path.resolve(process.env.MIAOSHOU_DATA_ROOT)
  : PROJECT_ROOT;

function resolveRoot(...parts) {
  return path.join(DATA_ROOT, ...parts);
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function ensureProjectDirs() {
  await Promise.all([
    ensureDir(resolveRoot('config')),
    ensureDir(resolveRoot('data')),
    ensureDir(resolveRoot('data', 'screenshots')),
    ensureDir(resolveRoot('storage'))
  ]);
}

function readJSONSync(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`[配置] 读取失败 ${filePath}: ${error.message}`);
    return fallback;
  }
}

function loadConfig() {
  const defaults = {
    startUrl: 'https://erp.91miaoshou.com/',
    productEditUrl: '',
    headless: false,
    ai: {
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.1',
      apiKeyEnv: 'ZAI_API_KEY',
      sendImages: true,
      maxTokens: 4096
    },
    thresholds: {
      autoSelectScore: 0.85,
      aiSecondChoiceScore: 0.7
    },
    browser: {
      channel: 'msedge',
      executablePath: '',
      maximize: true,
      viewport: {
        width: 1920,
        height: 1080
      }
    },
    behavior: {
      saveAfterFill: false,
      screenshotOnError: true,
      skipAlreadyFilled: true,
      waitForManualPage: true,
      pauseBeforeSave: false,
      pauseOnSaveError: true,
      pauseAfterEachProduct: false
    },
    knowledgeBase: {
      enabled: true,
      path: 'storage/category_attribute_knowledge.json',
      maxSamplesPerAttribute: 20,
      maxTitlesPerCategory: 5
    },
    batch: {
      maxProducts: 0,
      saveRetryLimit: 1,
      saveFeedbackTimeoutMs: 6000,
      nextProductWaitMs: 4000,
      saveButtonSelectors: [],
      nextProductSelectors: []
    },
    temu: {
      loginUrl: 'https://seller.kuajingmaihuo.com/settle/site-main',
      priceCheckUrl: '',
      multiplier: 2,
      diffThreshold: 10
    }
  };
  const userConfig = readJSONSync(resolveRoot('config', 'config.json'), {});
  return mergeDeep(defaults, userConfig);
}

function getBrowserLaunchOptions(config) {
  const headless = Boolean(config.headless);
  const maximize = config && config.browser ? config.browser.maximize !== false : true;
  // 有头模式：最大化铺满屏幕，避免低分辨率机器上 1920×1080 窗口被裁出可视区
  // 无头模式 / 关闭最大化：没有真实窗口可最大化，按固定尺寸渲染
  let args;
  // --disable-blink-features=AutomationControlled：去掉 Chromium 自动化标志，
  // 避免 navigator.webdriver=true 被 Temu 等平台的风控识别
  const antiDetection = ['--disable-blink-features=AutomationControlled'];
  if (!headless && maximize) {
    args = ['--start-maximized', ...antiDetection];
  } else {
    const viewport = getBrowserViewport(config);
    args = [`--window-size=${viewport.width},${viewport.height}`, ...antiDetection];
  }

  const options = {
    headless,
    args
  };

  if (config.browser && config.browser.executablePath) {
    options.executablePath = config.browser.executablePath;
  } else if (config.browser && config.browser.channel) {
    options.channel = config.browser.channel;
  }

  return options;
}

function getBrowserViewport(config) {
  const width = Number(config && config.browser && config.browser.viewport && config.browser.viewport.width) || 1920;
  const height = Number(config && config.browser && config.browser.viewport && config.browser.viewport.height) || 1080;
  return { width, height };
}

function getBrowserContextOptions(config, extra = {}) {
  const headless = Boolean(config.headless);
  const maximize = config && config.browser ? config.browser.maximize !== false : true;
  // 有头且开启最大化：页面视口跟随真实（已最大化）窗口；无头/关闭最大化则用固定视口
  if (!headless && maximize) {
    return { viewport: null, ...extra };
  }
  const viewport = getBrowserViewport(config);
  return {
    viewport,
    screen: viewport,
    ...extra
  };
}

// 反自动化检测：隐藏 navigator.webdriver，配合 --disable-blink-features=AutomationControlled 使用
async function applyAntiDetection(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

function mergeDeep(target, source) {
  const output = { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeDeep(output[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function waitForEnter(message = '完成后按回车继续...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(`${message}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function fullWidthToHalfWidth(text) {
  return String(text || '').replace(/[\uff01-\uff5e]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  ).replace(/\u3000/g, ' ');
}

function normalizeText(text) {
  return fullWidthToHalfWidth(text)
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|\[[^\]]*]|\{[^}]*}/g, '')
    .replace(/请选择|选择|全部|不限|--|—|－|none|null|undefined/g, '')
    .replace(/[\s"'`~!@#$%^&*_\-+=|\\/:;,.，。！？!?、<>《》【】[\]]+/g, '')
    .trim();
}

function cleanAttributeName(text) {
  return String(text || '')
    .replace(/\*/g, '')
    .replace(/必填/g, '')
    .replace(/[:：]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFileName(text, fallback = 'file') {
  const cleaned = String(text || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || fallback;
}

function nowForFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toArrayValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value == null) return [];
  return String(value)
    .split(/[,，;；/|]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

module.exports = {
  PROJECT_ROOT,
  DATA_ROOT,
  resolveRoot,
  ensureDir,
  ensureProjectDirs,
  readJSONSync,
  loadConfig,
  getBrowserLaunchOptions,
  getBrowserContextOptions,
  applyAntiDetection,
  waitForEnter,
  sleep,
  unique,
  normalizeText,
  cleanAttributeName,
  safeFileName,
  nowForFile,
  toArrayValue
};
