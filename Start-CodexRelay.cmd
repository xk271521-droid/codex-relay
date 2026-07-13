@echo off
setlocal
cd /d "%~dp0"
start "Codex Relay" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\start-router.ps1"
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:15723
