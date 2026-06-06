@echo off
setlocal
cd /d "%~dp0"

echo.
echo Main Image Optimizer Launcher
echo.

for /f "delims=" %%N in ('where node 2^>nul') do (
  echo %%N | findstr /i /c:"OpenAI.Codex" >nul
  if errorlevel 1 (
    set "NODE_CMD=%%N"
    goto ask_key
  )
)

if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE_CMD=C:\Program Files\nodejs\node.exe"
  goto ask_key
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
  goto ask_key
)

if exist "%LocalAppData%\Programs\nodejs\node.exe" (
  set "NODE_CMD=%LocalAppData%\Programs\nodejs\node.exe"
  goto ask_key
)

echo Node.js was not found.
echo Please install Node.js LTS from https://nodejs.org
pause
exit /b 1

:ask_key
set "HOST=0.0.0.0"
echo Starting server...
echo Open this URL in your browser:
echo http://127.0.0.1:4173
echo.
echo Other devices on the same network can open:
echo http://YOUR_COMPUTER_IP:4173
echo.
start "" "http://127.0.0.1:4173"
"%NODE_CMD%" server.js

pause
