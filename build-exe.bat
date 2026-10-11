@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo ยังไม่ได้ติดตั้ง กรุณารัน setup.bat ก่อน
  pause
  exit /b 1
)
call npx electron-builder --win portable
if errorlevel 1 (
  echo สร้างไฟล์ EXE ไม่สำเร็จ ดูข้อความด้านบน
  pause
  exit /b 1
)
echo.
echo สร้างเสร็จแล้ว ดูไฟล์ .exe ในโฟลเดอร์ release (คัดลอกไฟล์เดียวไปให้ช่างแต่ละคนได้เลย)
pause
