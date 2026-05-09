const state = {
  running: false,
  taskName: ''
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
  pathsText: document.querySelector('#pathsText')
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
}

function switchView(name) {
  Object.entries(views).forEach(([key, node]) => node.classList.toggle('active', key === name));
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === name);
  });
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

  els.loginBtn.disabled = state.running;
  els.fillBtn.disabled = state.running;
  els.stopBtn.disabled = !state.running;
  els.continueBtn.disabled = !state.running;
}

function appendLog(text, type = 'stdout') {
  const prefix = type === 'stderr' ? '[错误] ' : type === 'info' ? '[状态] ' : '';
  els.logOutput.textContent += `${prefix}${text}`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}
