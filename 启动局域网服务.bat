@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gaokao platform - LAN mode

set "NODE_EXE=C:\Users\winter\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node.js LTS first: https://nodejs.org/
  pause
  exit /b 1
)

echo ============================================
echo  Gaokao platform - LAN mode
echo  Close this window to stop the server.
echo ============================================
echo.
"%NODE_EXE%" dev-server.mjs --lan %*
echo.
echo Server stopped.
pause