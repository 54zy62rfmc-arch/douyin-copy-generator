@echo off
rem 开机自启：静默起服务，不弹浏览器
setlocal
set "AUTOSTART=1"
set "APP_DIR=%~dp0"
"C:\Users\Administrator\Tools\node-v22.11.0-win-x64\node.exe" "%APP_DIR%start.js"
