// A bare Electron main for classify.spec.js: one hidden, sandboxed window, so the classifier decodes PNGs in the
// repo's own Chromium (no separate Playwright browser download). It loads nothing and has no preload.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.loadURL('data:text/html,<!doctype html><title>classify</title>');
});
app.on('window-all-closed', () => app.quit());
