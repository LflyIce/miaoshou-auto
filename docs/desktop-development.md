# 桌面版开发文档

## 目标

桌面版把原来的命令行自动化流程包装成 Electron 应用，让使用者通过按钮完成登录、配置、批量填写、继续确认和查看日志。

第一版保持现有自动化核心不大改：

- `src/login.js` 仍负责打开妙手 ERP 并保存登录态。
- `src/main.js` 仍负责读取商品、调用 AI、填写属性、保存、导出日志。
- Electron 负责配置界面、任务启动、日志展示、向子进程发送回车。

## 目录结构

```text
electron/
  main.js              Electron 主进程，管理窗口、配置、子进程任务
  preload.js           安全暴露 IPC API 给前端
  renderer/
    index.html         桌面界面
    app.js             前端交互逻辑
    style.css          界面样式

src/
  main.js              批量填写入口
  login.js             登录入口
  utils.js             项目目录、配置、浏览器参数等工具

docs/
  desktop-development.md
```

## 运行数据目录

开发环境直接使用项目目录：

```text
D:\666\miaoshou-attribute-helper
```

打包后使用 Electron 的用户数据目录，也就是 `app.getPath('userData')`。这样安装到 Program Files 后也不会因为写入安装目录失败。

运行数据包括：

- `.env`
- `config/config.json`
- `config/*.json`
- `storage/miaoshou_state.json`
- `storage/category_attribute_knowledge.json`
- `data/logs.xlsx`
- `data/failed_items.xlsx`
- `data/screenshots/`

实现点：

- `electron/main.js` 的 `prepareRuntime()` 会创建运行目录，并把默认 `config` 与知识库复制过去。
- `src/utils.js` 支持 `MIAOSHOU_DATA_ROOT` 环境变量，打包后子进程会通过这个变量读取和写入用户数据目录。

## IPC 接口

前端通过 `window.miaoshouApp` 调用主进程能力。

```js
loadSettings()
saveSettings(settings)
startTask('login' | 'fill')
continueTask()
stopTask()
openPath('data' | 'storage' | 'config' | 'root')
onLog(handler)
onTaskState(handler)
```

## 子进程任务

桌面版不直接 import `src/main.js`，而是用 `child_process.fork()` 启动：

```text
登录：src/login.js
填写：src/main.js
```

原因：

- 保留原命令行行为。
- 任务崩溃不会带崩 Electron 界面。
- `console.log` 可以被主进程捕获并实时显示。
- 原脚本里的 `waitForEnter()` 可以通过“继续”按钮向 stdin 写入 `\n`。

## 常用命令

安装依赖：

```powershell
$env:npm_config_cache='D:\666\miaoshou-attribute-helper\.npm-cache'
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
```

启动桌面版：

```powershell
npm run app
```

打包 Windows 安装包：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist
```

产物：

```text
dist/妙手属性助手 Setup 1.0.0.exe
dist/win-unpacked/妙手属性助手.exe
```

## 验证清单

修改桌面端后至少运行：

```powershell
node -c electron\main.js
node -c electron\preload.js
node -c electron\renderer\app.js
node -c src\utils.js
```

现有自动化测试：

```powershell
Get-ChildItem test -Filter *.test.js | ForEach-Object {
  Write-Host "RUN $($_.Name)"
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

桌面版烟测：

```powershell
npm run app
```

打包版烟测：

```powershell
.\dist\win-unpacked\妙手属性助手.exe
```

## 打包配置说明

`package.json` 中的关键配置：

- `main`: 指向 `electron/main.js`
- `scripts.app`: 开发启动桌面端
- `scripts.dist`: 构建 Windows 安装包
- `build.asar=false`: 第一版保持文件展开，方便子进程直接运行 `src/*.js`
- `win.signAndEditExecutable=false`: 第一版不做代码签名，避免构建时下载 `winCodeSign`
- `nsis.oneClick=false`: 安装时允许用户选择安装路径

## 注意事项

- `.env.example` 只能放占位符，不能放真实 API Key。
- `storage/miaoshou_state.json` 是登录态，不要提交。
- `data/` 下的 Excel 和截图是运行产物，不要提交。
- 如果打包下载 GitHub 资源失败，优先设置 `ELECTRON_BUILDER_BINARIES_MIRROR`。
- 当前 UI 是第一版工作台，后续可以继续加失败商品重跑、知识库编辑、规则编辑和任务进度统计。
