const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const STATUS_DIR = path.join(os.homedir(), '.claude-traffic-light');
const STATUS_FILE = path.join(STATUS_DIR, 'status.json');
const BOUNDS_FILE = path.join(STATUS_DIR, 'window-bounds.json');

if (!fs.existsSync(STATUS_DIR)) fs.mkdirSync(STATUS_DIR, { recursive: true });
if (!fs.existsSync(STATUS_FILE)) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: 'amber', updatedAt: new Date().toISOString(), reason: 'idle' }, null, 2));
}

let win;
let tray;

function readBounds() {
  try {
    return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveBounds() {
  if (!win) return;
  fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds(), null, 2));
}

function createWindow() {
  const saved = readBounds();
  const primary = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: saved?.width || 90,
    height: saved?.height || 90,
    x: saved?.x ?? Math.round(primary.width - 140),
    y: saved?.y ?? 80,
    minWidth: 48,
    minHeight: 48,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  try {
    tray = new Tray(trayIconPath);
  } catch {
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: 'Open Claude', click: () => shell.openExternal('https://claude.ai') },
    { label: 'Show / Hide Widget', click: () => (win?.isVisible() ? win.hide() : win?.show()) },
    { type: 'separator' },
    {
      label: 'Set state: Green (working)',
      click: () => writeStatus('green', 'manual'),
    },
    {
      label: 'Set state: Amber (needs input)',
      click: () => writeStatus('amber', 'manual'),
    },
    {
      label: 'Set state: Red (out of tokens)',
      click: () => writeStatus('red', 'manual'),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('Claude Traffic Light');
  tray.setContextMenu(menu);
}

function writeStatus(state, reason) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ state, updatedAt: new Date().toISOString(), reason }, null, 2));
}

ipcMain.handle('open-claude', () => {
  shell.openExternal('https://claude.ai');
});

ipcMain.handle('get-status-path', () => STATUS_FILE);

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  createWindow();
  createTray();

  fs.watch(STATUS_DIR, { persistent: true }, (eventType, filename) => {
    if (filename === path.basename(STATUS_FILE) && win) {
      win.webContents.send('status-changed');
    }
  });
});

app.on('window-all-closed', () => {
  // Keep running in the tray on macOS/other platforms.
});
