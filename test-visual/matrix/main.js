// Electron entry for the character matrix: one plain window the spec navigates
// from grid to grid, so the matrix renders in the same Chromium the app ships.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900, height: 900, show: true, backgroundColor: '#2a2833',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
