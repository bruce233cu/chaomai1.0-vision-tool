@echo off
setlocal
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%TEMP%\create-main-image-shortcut.vbs"

> "%VBS%" echo Set shell = CreateObject("WScript.Shell")
>> "%VBS%" echo Set shortcut = shell.CreateShortcut("%STARTUP%\Main Image Optimizer.lnk")
>> "%VBS%" echo shortcut.TargetPath = "%~dp0start.bat"
>> "%VBS%" echo shortcut.WorkingDirectory = "%~dp0"
>> "%VBS%" echo shortcut.WindowStyle = 7
>> "%VBS%" echo shortcut.Save

cscript //nologo "%VBS%"
del "%VBS%" >nul 2>nul

echo Autostart installed.
echo The tool will start automatically after Windows login.
pause
