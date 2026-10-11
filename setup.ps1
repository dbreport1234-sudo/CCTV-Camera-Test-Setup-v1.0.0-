\xEF\xBB\xBF$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host 'CCTV Camera Test & Setup - ติดตั้ง (ทำครั้งเดียว)' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'ไม่พบ Node.js — ติดตั้ง Node.js LTS จาก https://nodejs.org/ แล้วรัน setup.bat ใหม่' -ForegroundColor Red
  exit 1
}
$ver = (node -v).TrimStart('v').Split('.')[0]
if ([int]$ver -lt 18) { Write-Host "Node.js เวอร์ชันเก่าเกินไป (v$ver) — ต้องใช้ v18 ขึ้นไป" -ForegroundColor Red; exit 1 }

Write-Host 'กำลังติดตั้งแพ็กเกจ (ต้องต่ออินเทอร์เน็ต ใช้เวลาสักครู่) ...'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install ไม่สำเร็จ' }

# ตรวจว่า ffmpeg (ตัวแปลงภาพสำหรับกล้องรุ่นเก่า) ดาวน์โหลดมาครบ
$ff = node -e "try{console.log(require('ffmpeg-static')||'')}catch(e){console.log('')}"
if (-not $ff -or -not (Test-Path $ff)) {
  Write-Host 'ดาวน์โหลด ffmpeg ไม่สำเร็จ (อาจถูกไฟร์วอลล์/แอนตี้ไวรัสบล็อก)' -ForegroundColor Red
  Write-Host 'ทางแก้: ดาวน์โหลด ffmpeg.exe มาวางในโฟลเดอร์นี้ แล้วตั้งตัวแปร FFMPEG_PATH หรือเพิ่มเข้า PATH' -ForegroundColor Yellow
  exit 1
}
& $ff -version | Select-Object -First 1
Write-Host ''
Write-Host 'ติดตั้งเสร็จแล้ว  ->  เปิดโปรแกรมด้วย run-app.bat' -ForegroundColor Green
