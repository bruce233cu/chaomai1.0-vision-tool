@echo off
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

netsh advfirewall firewall add rule name="Chaomai Vision Tool 4173" dir=in action=allow protocol=TCP localport=4173
echo.
echo Firewall port 4173 is open.
echo.
pause
