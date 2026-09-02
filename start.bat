@echo off
rem ============================================================
rem  QQ 机器人托管平台（本地空白版）一键启动
rem ============================================================
if exist "%SystemRoot%\system32\chcp.com" "%SystemRoot%\system32\chcp.com" 65001 >nul
title QQ 机器人托管平台
cd /d "%~dp0"

rem ---- 查找 node.exe ----
set "NODE_EXE="
"%SystemRoot%\system32\where.exe" node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "D:\Program Files\nodejs\node.exe" set "NODE_EXE=D:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE (
    echo [错误] 未找到 Node.js，请到 https://nodejs.org 安装 LTS 版本后重试。
    pause
    exit /b 1
)

rem ---- 首次运行安装依赖 ----
if exist node_modules goto ready
echo 首次运行，正在安装依赖，请稍候...
set "NPM_CLI="
if exist "D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" set "NPM_CLI=D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
if not defined NPM_CLI if exist "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" set "NPM_CLI=C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
if not defined NPM_CLI if exist "%APPDATA%\npm\node_modules\npm\bin\npm-cli.js" set "NPM_CLI=%APPDATA%\npm\node_modules\npm\bin\npm-cli.js"
for %%f in ("%NODE_EXE%") do if not defined NPM_CLI if exist "%%~dpfnode_modules\npm\bin\npm-cli.js" set "NPM_CLI=%%~dpfnode_modules\npm\bin\npm-cli.js"
if not defined NPM_CLI (
    echo [错误] 未找到 npm，请重新安装 Node.js。
    pause
    exit /b 1
)
"%NODE_EXE%" "%NPM_CLI%" install --cache .npm-cache
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
)

:ready
echo ==============================================
echo   正在启动 QQ 机器人托管平台...
echo   浏览器打开 http://localhost:3000 使用
echo   关闭本窗口或按 Ctrl+C 停止
echo ==============================================
"%NODE_EXE%" server.js
echo.
echo 平台已停止
pause
