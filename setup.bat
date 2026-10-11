@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo การติดตั้งไม่สำเร็จ อ่านข้อความสีแดงด้านบน
  pause
  exit /b 1
)
pause
