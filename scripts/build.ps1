<#
  妙手属性助手 Windows 打包脚本
  作用：打包前自动设置国内镜像，解决 electron-builder 从 GitHub 下载 electron / nsis 等二进制超时的问题；
        打包后把「安装包」和「免安装版」分别整理到 dist\installer 与 dist\portable，避免 dist 根目录混乱。
  用法：在项目根目录执行   .\scripts\build.ps1
        （也可在任意目录用绝对路径调用，脚本会自动切回项目根目录）
#>

$ErrorActionPreference = 'Stop'

# 切到项目根目录（脚本位于 scripts/ 下，其父目录即项目根）
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $ProjectRoot

# 版本号从 package.json 读，避免在脚本里硬编码
$Version = (node -p 'require("./package.json").version')
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
$WinUnpacked = Join-Path $DistDir 'win-unpacked'
Remove-Item -Path $PortableDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $WinUnpacked) {
  Move-Item -Path $WinUnpacked -Destination $PortableDir -Force
} else {
  Write-Host '    （未找到 win-unpacked，跳过免安装版整理）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '==> 打包成功！产物：' -ForegroundColor Green
Write-Host "    dist\installer\妙手属性助手 Setup $Version.exe    （NSIS 安装包）" -ForegroundColor Green
Write-Host "    dist\portable\妙手属性助手.exe                    （免安装版，整个文件夹即可运行）" -ForegroundColor Green
Write-Host "    dist\portable\                                    （把这个文件夹打包成 zip 即可分发免安装版）" -ForegroundColor Green
