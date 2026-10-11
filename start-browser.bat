@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo ยังไม่ได้ติดตั้ง กรุณารัน setup.bat ก่อน
  pause
  exit /b 1
)
echo โหมดเบราว์เซอร์: ห้ามปิดหน้าต่างนี้ขณะใช้งาน (เปิดที่ http://127.0.0.1:3000)
node server.js
pause
