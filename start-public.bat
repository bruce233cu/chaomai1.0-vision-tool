@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo Chaomai Vision Public Launcher
echo.

for /f "delims=" %%N in ('where node 2^>nul') do (
  echo %%N | findstr /i /c:"OpenAI.Codex" >nul
  if errorlevel 1 (
    set "NODE_CMD=%%N"
    goto start_server
  )
)

if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE_CMD=C:\Program Files\nodejs\node.exe"
  goto start_server
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
  goto start_server
)

if exist "%LocalAppData%\Programs\nodejs\node.exe" (
  set "NODE_CMD=%LocalAppData%\Programs\nodejs\node.exe"
  goto start_server
)

echo Node.js was not found.
echo Please install Node.js LTS from https://nodejs.org
pause
exit /b 1

:start_server
set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=4173"

echo Starting public server...
echo.
echo Local URL:
echo   http://127.0.0.1:%PORT%
echo.
echo LAN URL candidates:
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%A"
  set "IP=!IP: =!"
  echo   http://!IP!:%PORT%
)
echo.
echo For internet customers, also open Windows Firewall and configure router/cloud security group.
echo See PUBLIC_DEPLOY.md
echo.

"%NODE_CMD%" server.js

pause
