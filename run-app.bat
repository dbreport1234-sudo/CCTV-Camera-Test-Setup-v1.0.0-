@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo ยังไม่ได้ติดตั้ง กรุณารัน setup.bat ก่อน
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
