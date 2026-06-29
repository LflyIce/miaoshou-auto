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
  loginBtn: document.querySelector('#loginBtn'),
  fillBtn: document.querySelector('#fillBtn'),
  continueBtn: document.querySelector('#continueBtn'),
  stopBtn: document.querySelector('#stopBtn'),
  clearLogBtn: document.querySelector('#clearLogBtn'),
  saveSettingsBtn: document.querySelector('#saveSettingsBtn'),
  saveMessage: document.querySelector('#saveMessage'),
  apiKeyInput: document.querySelector('#apiKeyInput'),
  modelInput: document.querySelector('#modelInput'),
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
  logoutBtn: document.querySelector('#logoutBtn')
};

window.miaoshouApp.onLog((payload) => appendLog(payload.text, payload.type));
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

init();

async function init() {
  const data = await window.miaoshouApp.loadSettings();
  const config = data.config || {};
  const ai = config.ai || {};
  const behavior = config.behavior || {};
  const batch = config.batch || {};

  els.apiKeyInput.value = data.apiKey || '';
  els.modelInput.value = ai.model || 'glm-5.1';
  els.productEditUrlInput.value = config.productEditUrl || '';
  els.maxProductsInput.value = Number(batch.maxProducts || 0);
  els.saveAfterFillInput.checked = behavior.saveAfterFill !== false;
  els.waitForManualPageInput.checked = behavior.waitForManualPage !== false;
  els.headlessInput.checked = Boolean(config.headless);
  els.sendImagesInput.checked = Boolean(ai.sendImages);

  const paths = data.paths || {};
  els.pathsText.textContent = [
    `运行数据目录：${paths.runtimeRoot || paths.root || ''}`,
    `程序目录：${paths.codeRoot || ''}`,
    `配置文件：${paths.config || ''}`,
    `环境变量：${paths.env || ''}`,
    `日志目录：${paths.data || ''}`,
    `知识库目录：${paths.storage || ''}`
  ].join('\n');

  renderState();
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
    model: els.modelInput.value,
    productEditUrl: els.productEditUrlInput.value,
    maxProducts: Number(els.maxProductsInput.value || 0),
    saveAfterFill: els.saveAfterFillInput.checked,
    waitForManualPage: els.waitForManualPageInput.checked,
    headless: els.headlessInput.checked,
    sendImages: els.sendImagesInput.checked
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
  els.statusText.textContent = state.running
    ? `运行中：${state.taskName === 'login' ? '登录' : '填写'}`
    : '空闲';

  // 每个按钮仅在自己同类任务运行时禁用；这样登录后即可直接点“开始填写”
  els.loginBtn.disabled = state.taskName === 'login';
  els.fillBtn.disabled = state.taskName === 'fill';
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

function appendLog(text, type = 'stdout') {
  const prefix = type === 'stderr' ? '[错误] ' : type === 'info' ? '[状态] ' : '';
  els.logOutput.textContent += `${prefix}${text}`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}
