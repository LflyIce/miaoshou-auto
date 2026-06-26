<#
  妙手属性助手 Windows 打包脚本
  作用：打包前自动设置国内镜像，解决 electron-builder 从 GitHub 下载 electron / nsis 等二进制超时的问题，然后执行打包。
  用法：在项目根目录执行   .\scripts\build.ps1
        （也可在任意目录用绝对路径调用，脚本会自动切回项目根目录）
#>

$ErrorActionPreference = 'Stop'

# 切到项目根目录（脚本位于 scripts/ 下，其父目录即项目根）
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $ProjectRoot

Write-Host '==> 设置国内镜像与打包参数...' -ForegroundColor Cyan
# electron 二进制镜像（解决 electron-v*-*-win32-x64.zip 下载超时）
$env:ELECTRON_MIRROR                  = 'https://npmmirror.com/mirrors/electron/'
# 打包工具链镜像：winCodeSign / nsis / nsis-resources 等
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
# 关闭代码签名探测（第一版不签名，避免额外下载 winCodeSign）
$env:CSC_IDENTITY_AUTO_DISCOVERY      = 'false'

Write-Host '==> 开始打包（npm run dist）...' -ForegroundColor Cyan
npm run dist

if ($LASTEXITCODE -eq 0) {
    Write-Host ''
    Write-Host '==> 打包成功！产物：' -ForegroundColor Green
    Write-Host '    dist\妙手属性助手 Setup 1.0.0.exe        （NSIS 安装包）'
    Write-Host '    dist\win-unpacked\妙手属性助手.exe        （免安装版）'
} else {
    Write-Host ''
    Write-Host "==> 打包失败，退出码 $LASTEXITCODE" -ForegroundColor Red
    Write-Host '    若仍报下载超时，请检查网络或更换镜像源。'
    exit $LASTEXITCODE
}
