@echo off
chcp 65001 >nul
echo ปิดโปรแกรมและตัวแปลงภาพที่ค้างอยู่ ...
taskkill /IM "CCTV-Camera-Test-Setup*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CCTV*" /F >nul 2>&1
taskkill /IM ffmpeg.exe /F >nul 2>&1
echo เรียบร้อย
pause
