@echo off
if exist "%SystemRoot%\system32\chcp.com" "%SystemRoot%\system32\chcp.com" 65001 >nul
title 生成 HTTPS 自签名证书
cd /d "%~dp0"
set "OPENSSL="
if exist "D:\Program Files\Git\usr\bin\openssl.exe" set "OPENSSL=D:\Program Files\Git\usr\bin\openssl.exe"
if not defined OPENSSL if exist "D:\Program Files\Git\mingw64\bin\openssl.exe" set "OPENSSL=D:\Program Files\Git\mingw64\bin\openssl.exe"
if not defined OPENSSL if exist "C:\Program Files\Git\usr\bin\openssl.exe" set "OPENSSL=C:\Program Files\Git\usr\bin\openssl.exe"
if not defined OPENSSL if exist "C:\Program Files\Git\mingw64\bin\openssl.exe" set "OPENSSL=C:\Program Files\Git\mingw64\bin\openssl.exe"
if not defined OPENSSL (
    echo [错误] 未找到 openssl。安装 Git（https://git-scm.com）后重试。
    pause
    exit /b 1
)
if not exist data\certs mkdir data\certs
"%OPENSSL%" req -x509 -newkey rsa:2048 -keyout data\certs\server.key -out data\certs\server.crt -days 3650 -nodes -subj "/C=CN/O=QQBotPlatform/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
if errorlevel 1 (
    echo [错误] 证书生成失败。
    pause
    exit /b 1
)
echo.
echo [成功] HTTPS 证书已生成（data\certs\）。
echo 重启 start.bat 后，用 https://localhost:3000 访问。
echo 浏览器提示"不安全"是自签名证书的正常现象，点"高级 - 继续访问"即可。
pause