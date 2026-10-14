<#
  妙手属性助手 Windows 打包脚本
  作用：打包前自动设置国内镜像，解决 electron-builder 从 GitHub 下载 electron / nsis 等二进制超时的问题；
        打包后把「安装包」和「免安装版」分别整理到 dist\installer 与 dist\portable，避免 dist 根目录混乱；
        最后自动生成升级清单 manifest.json，并尝试上传安装包与清单到腾讯云 COS（升级检测用）。
  用法：在项目根目录执行   .\scripts\build.ps1 -Notes "本次更新说明"
        （也可在任意目录用绝对路径调用，脚本会自动切回项目根目录；-Notes 缺省时会交互询问）
#>

param(
  [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'

# 切到项目根目录（脚本位于 scripts/ 下，其父目录即项目根）
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $ProjectRoot

# 版本号从 package.json 读，避免在脚本里硬编码
# （用 ConvertFrom-Json 而不是 node -p：PS 5.1 向原生程序传参会吃掉双引号，导致 $Version 为空；
#   必须显式 -Encoding UTF8：package.json 是无 BOM 的 UTF-8，PS 5.1 默认按 GBK 读会把中文读成乱码导致 JSON 解析失败）
$Version = (Get-Content -Path (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$DistDir      = Join-Path $ProjectRoot 'dist'
$InstallerDir = Join-Path $DistDir 'installer'
$PortableDir  = Join-Path $DistDir 'portable'

Write-Host '==> 设置国内镜像与打包参数...' -ForegroundColor Cyan
# electron 二进制镜像（解决 electron-v*-*-win32-x64.zip 下载超时）
$env:ELECTRON_MIRROR                  = 'https://npmmirror.com/mirrors/electron/'
# 打包工具链镜像：winCodeSign / nsis / nsis-resources 等
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
# 关闭代码签名探测（第一版不签名，避免额外下载 winCodeSign）
$env:CSC_IDENTITY_AUTO_DISCOVERY      = 'false'

Write-Host '==> 开始打包（npm run dist）...' -ForegroundColor Cyan
npm run dist

if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "==> 打包失败，退出码 $LASTEXITCODE" -ForegroundColor Red
  Write-Host '    若仍报下载超时，请检查网络或更换镜像源。'
  exit $LASTEXITCODE
}

Write-Host '==> 整理产物（installer / portable 分目录）...' -ForegroundColor Cyan

# 安装包目录：NSIS Setup exe 及其附属产物（*.blockmap、latest.yml）统一放这里
Remove-Item -Path $InstallerDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path $InstallerDir -ItemType Directory -Force | Out-Null
$installerArtifacts = Get-ChildItem -Path $DistDir -File | Where-Object {
  $_.Extension -eq '.exe' -or $_.Extension -eq '.blockmap' -or $_.Name -eq 'latest.yml'
}
foreach ($f in $installerArtifacts) {
  Move-Item -Path $f.FullName -Destination $InstallerDir -Force
}

# 免安装目录：把 win-unpacked 整个目录重命名为 portable
# 刚构建完的 exe 可能被杀毒软件短暂占用（Access denied），重试几次；
# 仍失败则退化为复制；再失败只警告并继续，不阻塞安装包与升级清单的收尾
$WinUnpacked = Join-Path $DistDir 'win-unpacked'
Remove-Item -Path $PortableDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $WinUnpacked) {
  $moved = $false
  foreach ($attempt in 1..3) {
    try {
      Move-Item -Path $WinUnpacked -Destination $PortableDir -Force -ErrorAction Stop
      $moved = $true
      break
    } catch {
      Write-Host "    （win-unpacked 被占用，第 $attempt 次重试失败：$($_.Exception.Message)）" -ForegroundColor Yellow
      Start-Sleep -Seconds 2
    }
  }
  if (-not $moved) {
    try {
      Copy-Item -Path $WinUnpacked -Destination $PortableDir -Recurse -Force -ErrorAction Stop
      Remove-Item -Path $WinUnpacked -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host '    （win-unpacked 持续被占用，已改为复制方式生成 portable）' -ForegroundColor Yellow
    } catch {
      Write-Host "    （portable 整理失败：$($_.Exception.Message)——不影响安装包与升级清单）" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '    （未找到 win-unpacked，跳过免安装版整理）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '==> 打包成功！产物：' -ForegroundColor Green
Write-Host "    dist\installer\妙手属性助手 Setup $Version.exe    （NSIS 安装包）" -ForegroundColor Green
Write-Host "    dist\portable\妙手属性助手.exe                    （免安装版，整个文件夹即可运行）" -ForegroundColor Green
Write-Host "    dist\portable\                                    （把这个文件夹打包成 zip 即可分发免安装版）" -ForegroundColor Green

# ---------------- 升级清单（manifest.json）生成与上传 ----------------
# App 内置的升级检测会拉取 COS 上的 manifest.json（地址见 config.update.manifestUrl），
# 每次发版需要：上传 Setup exe + 更新 COS 上的 manifest.json。本段自动完成清单生成并尽量自动上传。

$CosBucketHost = 'miaoshou-1308104144.cos.ap-guangzhou.myqcloud.com'
$SetupExe = Get-ChildItem -Path $InstallerDir -Filter '*Setup*.exe' -File |
  Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1

if (-not $SetupExe) {
  Write-Host ''
  Write-Host '==> 未在 dist\installer 找到 Setup 安装包，跳过升级清单生成' -ForegroundColor Yellow
} else {
  if (-not $Notes) {
    $Notes = Read-Host '请输入本次更新说明（留空则使用默认文案）'
  }
  if (-not $Notes) { $Notes = "版本 $Version 发布" }

  $manifest = [ordered]@{
    version = $Version
    url     = "https://$CosBucketHost/$($SetupExe.Name)"
    notes   = $Notes
  }
  $ManifestPath = Join-Path $ProjectRoot 'manifest.json'
  $manifestJson = $manifest | ConvertTo-Json
  # 无 BOM UTF-8 写入，避免远端 JSON 解析问题
  [System.IO.File]::WriteAllText($ManifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ''
  Write-Host '==> 升级清单已生成：manifest.json' -ForegroundColor Green
  Write-Host $manifestJson -ForegroundColor DarkGray

  # 上传：优先用本机已配置的 coscli / coscmd；没有则给出手动指引
  $cosTool = Get-Command coscli, coscmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cosTool) {
    Write-Host ''
    Write-Host "==> 检测到 $($cosTool.Name)，开始上传安装包与清单到 COS..." -ForegroundColor Cyan
    if ($cosTool.Name -eq 'coscli') {
      coscli cp "$($SetupExe.FullName)" "cos://$CosBucketHost/$($SetupExe.Name)"
      coscli cp "$ManifestPath" "cos://$CosBucketHost/manifest.json"
    } else {
      coscmd upload "$($SetupExe.FullName)" "$($SetupExe.Name)"
      coscmd upload "$ManifestPath" "manifest.json"
    }
    if ($LASTEXITCODE -eq 0) {
      Write-Host '==> COS 上传完成，客户端升级检测已生效' -ForegroundColor Green
    } else {
      Write-Host "==> COS 上传失败（退出码 $LASTEXITCODE），请按下方手动步骤上传" -ForegroundColor Yellow
      $cosTool = $null
    }
  }
  if (-not $cosTool) {
    Write-Host ''
    Write-Host '==> 未检测到 coscli / coscmd，请手动上传以下两个文件到 COS（或安装配置后重跑）：' -ForegroundColor Yellow
    Write-Host "    1. 安装包： $SetupExe" -ForegroundColor Yellow
    Write-Host "       上传到： https://$CosBucketHost/$($SetupExe.Name)" -ForegroundColor Yellow
    Write-Host "    2. 升级清单： $ManifestPath" -ForegroundColor Yellow
    Write-Host "       上传到： https://$CosBucketHost/manifest.json" -ForegroundColor Yellow
    Write-Host '    COS 控制台： https://console.cloud.tencent.com/cos' -ForegroundColor Yellow
    Write-Host '    （安装 coscli 并配置好存储桶后，本脚本将自动完成上传）' -ForegroundColor DarkGray
  }
}
