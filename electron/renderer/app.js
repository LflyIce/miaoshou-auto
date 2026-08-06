const state = {
  running: false,
  taskName: '',
  role: null
};

const views = {
  run: document.querySelector('#runView'),
  settings: document.querySelector('#settingsView'),
  files: document.querySelector('#filesView')
};

const els = {
  statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'),
  logOutput: document.querySelector('#logOutput'),
  progressBar: document.querySelector('#progressBar'),
  progressFill: document.querySelector('#progressFill'),
  progressText: document.querySelector('#progressText'),
  loginBtn: document.querySelector('#loginBtn'),
  fillBtn: document.querySelector('#fillBtn'),
  temuLoginBtn: document.querySelector('#temuLoginBtn'),
  temuBtn: document.querySelector('#temuBtn'),
  temuMultiplierInput: document.querySelector('#temuMultiplierInput'),
  temuPriceCheckUrlInput: document.querySelector('#temuPriceCheckUrlInput'),
  continueBtn: document.querySelector('#continueBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  clearLogBtn: document.querySelector('#clearLogBtn'),
  saveSettingsBtn: document.querySelector('#saveSettingsBtn'),
  saveMessage: document.querySelector('#saveMessage'),
  apiKeyInput: document.querySelector('#apiKeyInput'),
  modelSelect: document.querySelector('#modelSelect'),
  productEditUrlInput: document.querySelector('#productEditUrlInput'),
  maxProductsInput: document.querySelector('#maxProductsInput'),
  saveAfterFillInput: document.querySelector('#saveAfterFillInput'),
  waitForManualPageInput: document.querySelector('#waitForManualPageInput'),
  headlessInput: document.querySelector('#headlessInput'),
  sendImagesInput: document.querySelector('#sendImagesInput'),
  pathsText: document.querySelector('#pathsText'),
  historyList: document.querySelector('#historyList'),
  historyEmpty: document.querySelector('#historyEmpty'),
  refreshHistoryBtn: document.querySelector('#refreshHistoryBtn'),
  productSearchInput: document.querySelector('#productSearchInput'),
  productSearchBtn: document.querySelector('#productSearchBtn'),
  searchList: document.querySelector('#searchList'),
  searchEmpty: document.querySelector('#searchEmpty'),
  searchHint: document.querySelector('#searchHint'),
  loginScreen: document.querySelector('#loginScreen'),
  appEl: document.querySelector('.app'),
  guestLoginBtn: document.querySelector('#guestLoginBtn'),
  adminLoginBtn: document.querySelector('#adminLoginBtn'),
  adminUserInput: document.querySelector('#adminUserInput'),
  adminPassInput: document.querySelector('#adminPassInput'),
  loginHint: document.querySelector('#loginHint'),
  loginError: document.querySelector('#loginError'),
  logoutBtn: document.querySelector('#logoutBtn'),
  updateBanner: document.querySelector('#updateBanner'),
  updateBannerText: document.querySelector('#updateBannerText'),
  updateDownloadBtn: document.querySelector('#updateDownloadBtn'),
  updateDismissBtn: document.querySelector('#updateDismissBtn'),
  versionText: document.querySelector('#versionText')
};

window.miaoshouApp.onLog((payload) => appendLog(payload.text, payload.type));
window.miaoshouApp.onUpdateAvailable((info) => renderUpdateBanner(info));
window.miaoshouApp.onTaskState((payload) => {
  state.running = Boolean(payload.running);
  state.taskName = payload.taskName || '';
  renderState();
});

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

els.loginBtn.addEventListener('click', () => startTask('login'));
els.fillBtn.addEventListener('click', () => startTask('fill'));
els.temuLoginBtn.addEventListener('click', () => startTask('temu-login'));
els.temuBtn.addEventListener('click', () => startTask('temu-price'));
els.continueBtn.addEventListener('click', async () => {
  const result = await window.miaoshouApp.continueTask();
  if (!result.ok) appendLog(`${result.error}\n`, 'stderr');
});
els.stopBtn.addEventListener('click', () => window.miaoshouApp.stopTask());
els.clearLogBtn.addEventListener('click', () => {
  els.logOutput.textContent = '';
});
els.saveSettingsBtn.addEventListener('click', saveSettings);

document.querySelectorAll('[data-open]').forEach((button) => {
  button.addEventListener('click', async () => {
    const result = await window.miaoshouApp.openPath(button.dataset.open);
    if (!result.ok) appendLog(`${result.error}\n`, 'stderr');
  });
});

els.refreshHistoryBtn.addEventListener('click', loadHistory);

// 模型下拉：根据 providers 表填充选项，切换时更新 apiKey 占位符
// @param {Object} providers — config.ai.providers
// @param {string} [currentModel] — 当前已选模型，用于回显
function populateModelSelect(providers, currentModel) {
  const select = els.modelSelect;
  const prev = select.value;
  select.innerHTML = '';
  const knownKeys = Object.keys(providers);
  for (const key of knownKeys) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = providers[key].label || key;
    select.appendChild(opt);
  }
  if (prev && knownKeys.includes(prev)) {
    select.value = prev;
  } else if (currentModel && knownKeys.includes(currentModel)) {
    select.value = currentModel;
  } else if (knownKeys.length) {
    select.value = knownKeys[0];
  }
  updateApiKeyPlaceholder();
  select.onchange = updateApiKeyPlaceholder;
}

function updateApiKeyPlaceholder() {
  const providers = (window._lastProviders) || {};
  const key = els.modelSelect.value;
  const provider = providers[key];
  const envVar = provider ? provider.apiKeyEnv : 'ZAI_API_KEY';
  els.apiKeyInput.placeholder = envVar;
}

// 商品检索：点查找 / 回车立即查；输入时 300ms 防抖实时查
els.productSearchBtn.addEventListener('click', searchProducts);
els.productSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchProducts();
});
let searchTimer = null;
els.productSearchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchProducts, 300);
});

// 登录界面
els.guestLoginBtn.addEventListener('click', () => enterApp('guest'));
els.adminLoginBtn.addEventListener('click', doAdminLogin);
els.adminPassInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') doAdminLogin();
});
els.logoutBtn.addEventListener('click', logout);
els.updateDownloadBtn.addEventListener('click', downloadUpdate);
els.updateDismissBtn.addEventListener('click', () => els.updateBanner.classList.add('is-hidden'));

init();

async function init() {
  const data = await window.miaoshouApp.loadSettings();
  const config = data.config || {};
  const ai = config.ai || {};
  const behavior = config.behavior || {};
  const batch = config.batch || {};

  els.apiKeyInput.value = data.apiKey || '';
  window._lastProviders = ai.providers || {};
  populateModelSelect(window._lastProviders, ai.model);
  els.productEditUrlInput.value = config.productEditUrl || '';
  els.maxProductsInput.value = Number(batch.maxProducts || 0);
  els.saveAfterFillInput.checked = behavior.saveAfterFill !== false;
  els.waitForManualPageInput.checked = behavior.waitForManualPage !== false;
  els.headlessInput.checked = Boolean(config.headless);
  els.sendImagesInput.checked = Boolean(ai.sendImages);
  const temu = config.temu || {};
  els.temuMultiplierInput.value = Number(temu.multiplier) || 2;
  els.temuPriceCheckUrlInput.value = temu.priceCheckUrl || '';

  const paths = data.paths || {};
  els.pathsText.textContent = [
    `运行数据目录：${paths.runtimeRoot || paths.root || ''}`,
    `程序目录：${paths.codeRoot || ''}`,
    `配置文件：${paths.config || ''}`,
    `环境变量：${paths.env || ''}`,
    `日志目录：${paths.data || ''}`,
    `知识库目录：${paths.storage || ''}`
  ].join('\n');

  els.versionText.textContent = data.version ? `v${data.version}` : '';
  renderState();
  renderUpdateBanner(await window.miaoshouApp.getUpdateStatus());
  await showLoginScreen();
}

function switchView(name) {
  Object.entries(views).forEach(([key, node]) => node.classList.toggle('active', key === name));
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === name);
  });
  if (name === 'files') loadHistory();
}

function enterApp(role) {
  state.role = role;
  els.loginScreen.classList.add('is-hidden');
  els.appEl.classList.remove('is-hidden');
  // 游客模式：通过 body.guest-mode 隐藏带 guest-hide 的元素（配置页、文件页里的目录/路径）
  document.body.classList.toggle('guest-mode', role === 'guest');
  els.adminPassInput.value = '';
  switchView('run');
}

async function doAdminLogin() {
  els.loginError.textContent = '';
  const username = els.adminUserInput.value.trim();
  const password = els.adminPassInput.value;
  if (!username || !password) {
    els.loginError.textContent = '请输入账号和密码';
    return;
  }
  els.adminLoginBtn.disabled = true;
  const result = await window.miaoshouApp.authLogin({ username, password });
  els.adminLoginBtn.disabled = false;
  if (result.ok) {
    enterApp('admin');
  } else {
    els.loginError.textContent = result.error || '登录失败';
    els.adminPassInput.focus();
    els.adminPassInput.select();
  }
}

async function showLoginScreen() {
  els.appEl.classList.add('is-hidden');
  els.loginScreen.classList.remove('is-hidden');
  document.body.classList.remove('guest-mode');
  try {
    const status = await window.miaoshouApp.authStatus();
    els.loginHint.textContent = '';
  } catch (_) {
    els.loginHint.textContent = '';
  }
  els.adminUserInput.focus();
}

function logout() {
  state.role = null;
  els.adminUserInput.value = '';
  els.adminPassInput.value = '';
  els.loginError.textContent = '';
  showLoginScreen();
}

async function startTask(taskName) {
  await saveSettings({ silent: true });
  const result = await window.miaoshouApp.startTask(taskName);
  if (!result.ok) appendLog(`${result.error}\n`, 'stderr');
}

async function saveSettings(options = {}) {
  const settings = {
    apiKey: els.apiKeyInput.value,
    model: els.modelSelect.value,
    productEditUrl: els.productEditUrlInput.value,
    maxProducts: Number(els.maxProductsInput.value || 0),
    saveAfterFill: els.saveAfterFillInput.checked,
    waitForManualPage: els.waitForManualPageInput.checked,
    headless: els.headlessInput.checked,
    sendImages: els.sendImagesInput.checked,
    temuMultiplier: Number(els.temuMultiplierInput.value || 2),
    temuPriceCheckUrl: String(els.temuPriceCheckUrlInput.value || '').trim()
  };

  const result = await window.miaoshouApp.saveSettings(settings);
  if (!options.silent) {
    els.saveMessage.textContent = result.ok ? '已保存' : (result.error || '保存失败');
    window.setTimeout(() => {
      els.saveMessage.textContent = '';
    }, 2400);
  }
  return result;
}

function renderState() {
  els.statusDot.classList.toggle('running', state.running);
  els.statusDot.classList.toggle('idle', !state.running);
  const labelMap = { 'login': '登录', 'fill': '填写', 'temu-login': '登录Temu', 'temu-price': 'Temu核价' };
  els.statusText.textContent = state.running
    ? `运行中：${labelMap[state.taskName] || state.taskName}`
    : '空闲';

  // 每个按钮仅在自己同类任务运行时禁用；这样登录后即可直接点“开始填写”
  els.loginBtn.disabled = state.taskName === 'login';
  els.fillBtn.disabled = state.taskName === 'fill';
  els.temuLoginBtn.disabled = state.taskName === 'temu-login';
  els.temuBtn.disabled = state.taskName === 'temu-price';
  els.stopBtn.disabled = !state.running;
  els.continueBtn.disabled = !state.running;
}

async function loadHistory() {
  let items = [];
  try {
    const result = await window.miaoshouApp.listFillHistory();
    items = result.items || [];
  } catch (error) {
    appendLog(`读取填写历史失败：${error.message}\n`, 'stderr');
    return;
  }
  els.historyList.innerHTML = '';
  els.historyEmpty.style.display = items.length ? 'none' : 'block';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = item.date;
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${item.sizeKb} KB`;
    const open = document.createElement('button');
    open.className = 'history-open';
    open.textContent = '打开';
    open.addEventListener('click', async () => {
      const r = await window.miaoshouApp.openFillHistory(item.fileName);
      if (!r.ok) appendLog(`${r.error}\n`, 'stderr');
    });
    li.append(date, meta, open);
    els.historyList.appendChild(li);
  }
}

async function searchProducts() {
  const query = els.productSearchInput.value.trim();
  els.searchHint.style.display = 'none';
  if (!query) {
    els.searchList.innerHTML = '';
    els.searchEmpty.style.display = 'none';
    els.searchHint.style.display = 'block';
    return;
  }

  els.productSearchBtn.disabled = true;
  let items = [];
  try {
    const result = await window.miaoshouApp.searchFillHistory(query);
    items = result.items || [];
  } catch (error) {
    appendLog(`检索失败：${error.message}\n`, 'stderr');
    els.productSearchBtn.disabled = false;
    return;
  }
  els.productSearchBtn.disabled = false;

  els.searchList.innerHTML = '';
  els.searchEmpty.style.display = items.length ? 'none' : 'block';
  for (const item of items) {
    els.searchList.appendChild(buildSearchItem(item));
  }
}

function buildSearchItem(item) {
  const li = document.createElement('li');
  li.className = 'search-item';

  const title = document.createElement('div');
  title.className = 'search-title';
  title.textContent = item.japaneseTitle;

  const meta = document.createElement('div');
  meta.className = 'search-meta';
  meta.textContent = `日期：${item.date}　规格：${item.specifications || '—'}　申报价：${item.declaredPrice || '—'}`;

  const copy = document.createElement('button');
  copy.className = 'search-copy';
  if (item.productUrl) {
    copy.textContent = '复制产品地址';
    copy.addEventListener('click', async () => {
      const r = await window.miaoshouApp.writeClipboard(item.productUrl);
      if (r && r.ok) {
        copy.textContent = '已复制';
        copy.classList.add('is-copied');
        window.setTimeout(() => {
          copy.textContent = '复制产品地址';
          copy.classList.remove('is-copied');
        }, 1500);
      } else {
        appendLog('复制产品地址失败\n', 'stderr');
      }
    });
  } else {
    copy.textContent = '无地址';
    copy.disabled = true;
  }

  li.append(title, meta, copy);
  return li;
}

function renderUpdateBanner(info) {
  if (!info || !info.version) {
    els.updateBanner.classList.add('is-hidden');
    return;
  }
  els.updateBannerText.textContent = `发现新版本 v${info.version}${info.notes ? '　' + info.notes : ''}`;
  els.updateBanner.classList.remove('is-hidden');
}

async function downloadUpdate() {
  const result = await window.miaoshouApp.openDownloadUrl();
  if (!result.ok) appendLog(`${result.error || '打开下载页失败'}\n`, 'stderr');
}

function appendLog(text, type = 'stdout') {
  const prefix = type === 'stderr' ? '[错误] ' : type === 'info' ? '[状态] ' : '';
  els.logOutput.textContent += `${prefix}${text}`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
  updateProgress(text);
}

// 解析日志中的进度标记 [商品 X][N/5]，更新进度条
function updateProgress(text) {
  // 匹配 [商品 1][2/5] 或 [当前商品][3/5] 格式
  const stepMatch = text.match(/\[(?:商品\s*\d+|当前商品)\]\[(\d)\/5\]/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    const pct = Math.round((step / 5) * 100);
    els.progressBar.classList.remove('is-hidden');
    els.progressFill.style.width = `${pct}%`;
    const stepNames = ['', '读取信息', '优化标题', '扫描属性', '填写属性', '保存商品'];
    els.progressText.textContent = `步骤 ${step}/5：${stepNames[step] || ''}`;
  }
  // 保存成功后隐藏进度条
  if (/保存成功|已跳过|保存失败/.test(text) && !/失败提示/.test(text)) {
    setTimeout(() => els.progressBar.classList.add('is-hidden'), 1500);
  }
}
