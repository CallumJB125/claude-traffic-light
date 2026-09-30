// `npm run tune`: opens the motion tuning playground (tools/tuning.html) in a
// plain window. Dev only — not in build.files, and it never touches the
// app's data directory.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    title: 'Claude Buddy — motion tuning',
    backgroundColor: '#1c1a1f',
    webPreferences: { contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'tuning.html'));
});

app.on('window-all-closed', () => app.quit());
