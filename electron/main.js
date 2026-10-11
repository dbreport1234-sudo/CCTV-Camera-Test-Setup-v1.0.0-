'use strict';
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // ให้เปิดเสียงได้ทันทีเมื่อกดปุ่ม

let srv = null, win = null;
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    try {
      // รันเซิร์ฟเวอร์ภายในเครื่อง (127.0.0.1 เท่านั้น) ในโปรเซสเดียวกับหน้าต่างโปรแกรม
      srv = await require('../server.js').start({
        port: 0,
        dataDir: path.join(app.getPath('userData'), 'data'),
        outputDir: path.join(app.getPath('documents'), 'CCTV'),
      });
    } catch (e) {
      require('electron').dialog.showErrorBox('เริ่มโปรแกรมไม่ได้', String(e && e.message || e));
      app.quit(); return;
    }
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1400, height: 930, minWidth: 1100, minHeight: 700,
      backgroundColor: '#08111d', title: 'CCTV Camera Test & Setup', autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0b1a2f', symbolColor: '#e8eef8', height: 36 },
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const origin = `http://127.0.0.1:${srv.port}`;
    win.loadURL(origin + '/');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) e.preventDefault(); });
    win.on('closed', () => { win = null; });
  });

  let quitting = false;
  app.on('before-quit', async (e) => {
    if (quitting || !srv) return;
    quitting = true; e.preventDefault();
    try { await srv.stop(); } catch {}
    app.exit(0);
  });
  app.on('window-all-closed', () => app.quit());
}
