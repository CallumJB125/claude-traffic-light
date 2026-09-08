const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const WIDGET_ASPECT = 100 / 230; // width / height — a real traffic light is taller than it is wide

// Best-effort: bring the terminal app most likely running the session that
// needs attention to the front. We can't target the exact tab/pane from
// outside the terminal, so this activates the app; the user still has to
// find the right window, but at least it's the right app, focused.
const TERMINAL_APPS = ['Ghostty', 'iTerm2', 'iTerm', 'Terminal', 'Warp', 'Alacritty', 'kitty', 'WezTerm'];

function activateTerminalApp() {
  return new Promise((resolve) => {
    const script = `
      tell application "System Events"
        set names to name of every process
      end tell
      repeat with candidate in {${TERMINAL_APPS.map((n) => `"${n}"`).join(', ')}}
        if names contains candidate then
          tell application candidate to activate
          return candidate
        end if
      end repeat
      return ""
    `;
    execFile('osascript', ['-e', script], (err, stdout) => {
      resolve(!err && stdout.trim() ? stdout.trim() : null);
    });
  });
}

const ROOT_DIR = path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const BOUNDS_FILE = path.join(ROOT_DIR, 'window-bounds.json');
const MANUAL_OVERRIDE_FILE = path.join(ROOT_DIR, 'manual-override.json');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Inside the packaged .app, hooks/ is bundled as an extraResource; in dev it's
// just the checked-out hooks/ dir next to main.js.
const HOOKS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'hooks') : path.join(__dirname, 'hooks');
const SET_STATUS_SCRIPT = path.join(HOOKS_DIR, 'set-status.js');

function hookCmd(state, reason) {
  return `node "${SET_STATUS_SCRIPT}" ${state} ${reason}`;
}

function areHooksInstalled() {
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const stop = settings.hooks?.Stop || [];
    return stop.some((h) => h.hooks?.some((hh) => hh.command === hookCmd('amber', 'stop')));
  } catch {
    return false;
  }
}

function installHooks() {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch {
    // no settings file yet, or unreadable — start fresh rather than clobber silently
  }
  settings.hooks = settings.hooks || {};

  const addHook = (event, command) => {
    settings.hooks[event] = settings.hooks[event] || [];
    const already = settings.hooks[event].some((h) => h.hooks?.some((hh) => hh.command === command));
    if (!already) settings.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command }] });
  };

  addHook('UserPromptSubmit', hookCmd('green', 'prompt-submit'));
  addHook('PreToolUse', hookCmd('green', 'tool-use'));
  addHook('Notification', hookCmd('amber', 'notification'));
  addHook('Stop', hookCmd('amber', 'stop'));
  addHook('SessionEnd', hookCmd('amber', 'session-end'));

  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// A session that hasn't updated in this long is assumed dead (crashed,
// closed without a SessionEnd hook, laptop slept, etc) and is ignored.
const STALE_MS = 15 * 60 * 1000;

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

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

function readManualOverride() {
  try {
    const data = JSON.parse(fs.readFileSync(MANUAL_OVERRIDE_FILE, 'utf8'));
    if (data.expiresAt && Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

function readSessions() {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const now = Date.now();
  const sessions = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (now - new Date(data.updatedAt).getTime() > STALE_MS) continue;
      sessions.push(data);
    } catch {
      // skip unreadable/partially-written file
    }
  }
  return sessions;
}

// Priority: any session needing you (red) wins, then any still working
// (green), otherwise everything is idle/waiting (amber). A manual override
// from the tray menu always wins until it expires or is cleared.
function aggregateState() {
  const override = readManualOverride();
  if (override) return { state: override.state, reason: 'manual', sessions: readSessions() };

  const sessions = readSessions();
  if (sessions.length === 0) return { state: 'amber', reason: 'idle', sessions: [] };

  if (sessions.some((s) => s.state === 'red')) return { state: 'red', reason: 'session', sessions };
  if (sessions.some((s) => s.state === 'green')) return { state: 'green', reason: 'session', sessions };
  return { state: 'amber', reason: 'session', sessions };
}

function createWindow() {
  const saved = readBounds();
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const defaultWidth = 100;
  const defaultHeight = Math.round(defaultWidth / WIDGET_ASPECT);

  win = new BrowserWindow({
    width: saved?.width || defaultWidth,
    height: saved?.height || defaultHeight,
    x: saved?.x ?? Math.round(primary.width - defaultWidth - 40),
    y: saved?.y ?? 80,
    minWidth: 60,
    minHeight: Math.round(60 / WIDGET_ASPECT),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
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
  win.setAspectRatio(WIDGET_ASPECT);
  win.loadFile('index.html');

  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  const trayIconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  try {
    tray = new Tray(trayIconPath);
  } catch {
    return;
  }

  function setManual(state) {
    fs.writeFileSync(
      MANUAL_OVERRIDE_FILE,
      JSON.stringify({ state, expiresAt: Date.now() + 5 * 60 * 1000 }, null, 2)
    );
    win?.webContents.send('status-changed');
  }

  function clearManual() {
    fs.rm(MANUAL_OVERRIDE_FILE, { force: true }, () => win?.webContents.send('status-changed'));
  }

  const hooksLabel = areHooksInstalled() ? 'Reinstall Claude Code Hooks' : 'Install Claude Code Hooks (required)';

  const menu = Menu.buildFromTemplate([
    { label: 'Open Claude', click: () => shell.openExternal('https://claude.ai') },
    { label: 'Show / Hide Widget', click: () => (win?.isVisible() ? win.hide() : win?.show()) },
    { type: 'separator' },
    {
      label: hooksLabel,
      click: () => {
        installHooks();
        createTray();
      },
    },
    { type: 'separator' },
    { label: 'Override: Green (5 min)', click: () => setManual('green') },
    { label: 'Override: Amber (5 min)', click: () => setManual('amber') },
    { label: 'Override: Red (5 min)', click: () => setManual('red') },
    { label: 'Clear override', click: clearManual },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('Claude Traffic Light');
  tray.setContextMenu(menu);
}

ipcMain.handle('open-claude', () => {
  shell.openExternal('https://claude.ai');
});

ipcMain.handle('get-aggregate-status', () => aggregateState());

// Click handler: jump to whichever session needs the user (red beats amber,
// most-recently-updated wins ties), by focusing the terminal app it's most
// likely running in. If nothing needs attention, just open claude.ai.
ipcMain.handle('go-to-needing-session', async () => {
  const { sessions } = aggregateState();
  const needing = sessions
    .filter((s) => s.state === 'red' || s.state === 'amber')
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (needing.length === 0) {
    shell.openExternal('https://claude.ai');
    return { opened: 'claude.ai' };
  }

  const target = needing.find((s) => s.state === 'red') || needing[0];
  const activated = await activateTerminalApp();
  return { opened: activated || 'none-found', cwd: target.cwd };
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  if (!areHooksInstalled()) installHooks();
  createWindow();
  createTray();

  fs.watch(SESSIONS_DIR, { persistent: true }, () => {
    win?.webContents.send('status-changed');
  });

  // Belt-and-braces poll: covers editors of manual-override.json and any
  // watcher events the OS coalesces or drops.
  setInterval(() => win?.webContents.send('status-changed'), 4000);
});

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
