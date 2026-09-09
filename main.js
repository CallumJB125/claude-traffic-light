const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const WIDGET_ASPECT = 64 / 82; // width / height — matches the robot+sign SVG viewBox
const MIN_WIDTH = 80;
const MAX_WIDTH = 320;

function resizeBy(factor) {
  if (!win) return;
  const [x, y, w, h] = [...win.getPosition(), ...win.getSize()];
  const newWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w * factor)));
  const newHeight = Math.round(newWidth / WIDGET_ASPECT);
  // Anchor on the window's center so scrolling/clicking to resize doesn't
  // walk the widget across the screen.
  const cx = x + w / 2;
  const cy = y + h / 2;
  win.setBounds({
    x: Math.round(cx - newWidth / 2),
    y: Math.round(cy - newHeight / 2),
    width: newWidth,
    height: newHeight,
  });
}

// Best-effort: bring the terminal app most likely running the session that
// needs attention to the front, and — best-effort again — try to raise the
// specific window whose title mentions the target folder. There's no
// portable way to ask a terminal "which window has session X" from outside
// it, so this leans on window *titles* via the generic Accessibility API
// (works for any app, scriptable or not — Ghostty included, which has very
// little AppleScript support of its own). If no window title matches, it
// still activates the app so you're at least looking at the right place.
const TERMINAL_APPS = ['Ghostty', 'iTerm2', 'iTerm', 'Terminal', 'Warp', 'Alacritty', 'kitty', 'WezTerm'];

function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// folderHint: last path segment of the target cwd, e.g. "bondly" for
// "/Users/x/Desktop/bondly" — window titles very often show just that.
function activateTerminalApp(folderHint) {
  return new Promise((resolve) => {
    const hint = escapeForAppleScript((folderHint || '').toLowerCase());
    const script = `
      tell application "System Events"
        set names to name of every process
      end tell
      set targetApp to ""
      repeat with candidate in {${TERMINAL_APPS.map((n) => `"${n}"`).join(', ')}}
        set candidateName to contents of candidate
        if names contains candidateName then
          set targetApp to candidateName
          exit repeat
        end if
      end repeat
      if targetApp is "" then return "NONE|"
      tell application targetApp to activate
      delay 0.15
      set matched to false
      if "${hint}" is not "" then
        tell application "System Events"
          tell process targetApp
            repeat with w in windows
              try
                set t to (title of w as string)
                ignoring case
                  if t contains "${hint}" then
                    perform action "AXRaise" of w
                    set matched to true
                  end if
                end ignoring
              end try
              if matched then exit repeat
            end repeat
          end tell
        end tell
      end if
      if matched then
        return targetApp & "|exact"
      else
        return targetApp & "|app-only"
      end if
    `;
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) {
        console.log('[main] activateTerminalApp error:', err.message, stderr);
        return resolve(null);
      }
      const [app, precision] = stdout.trim().split('|');
      resolve(app && app !== 'NONE' ? { app, exact: precision === 'exact' } : null);
    });
  });
}

// Same override hooks/set-status.js supports — set this in the environment
// (before the app reads it, e.g. launchctl setenv or a shell profile that
// GUI-launched apps also inherit) to point sessions at a synced folder so
// multiple machines' sessions merge into one widget. Local-only by default.
const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const BOUNDS_FILE = path.join(ROOT_DIR, 'window-bounds.json');
const MANUAL_OVERRIDE_FILE = path.join(ROOT_DIR, 'manual-override.json');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const DEFAULT_CONFIG = {
  workingStaleMinutes: 6,
  waitingStaleHours: 4,
  soundOnAmber: true,
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(partial) {
  const next = { ...loadConfig(), ...partial };
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

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
    const notif = settings.hooks?.Notification || [];
    return notif.some((h) => h.hooks?.some((hh) => hh.command === hookCmd('amber', 'notification')));
  } catch {
    return false;
  }
}

// Claude Code's Stop hook fires after every single response — including
// completely routine ones with nothing blocking you — so it used to mark a
// session amber just for having finished its last turn, which lit the
// widget amber almost constantly. Only Notification (a real permission
// prompt, or Claude Code's own "still waiting on you" idle nudge) is an
// actual "your input is needed" signal, so only that sets amber now.
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

  // Drop any old install's Stop→amber hook — it's what caused the "amber
  // for no reason" noise. Matched by script name + trailing args rather
  // than the full command, since the .app's own path can change (moved
  // out of /Applications, rebuilt to a dev checkout, etc) between installs.
  // Only ever strips our own set-status.js calls, never a Stop hook the
  // user or another tool added.
  const isOldStopCmd = (command) => /set-status\.js" amber stop$/.test(command || '');
  if (settings.hooks.Stop) {
    settings.hooks.Stop = settings.hooks.Stop
      .map((h) => ({ ...h, hooks: (h.hooks || []).filter((hh) => !isOldStopCmd(hh.command)) }))
      .filter((h) => h.hooks.length > 0);
  }

  addHook('UserPromptSubmit', hookCmd('green', 'prompt-submit'));
  addHook('PreToolUse', hookCmd('green', 'tool-use'));
  addHook('Notification', hookCmd('amber', 'notification'));
  // Finished a task cleanly (not the same as the old amber-on-Stop this
  // replaced) — eyes go green and Claude gives a thumbs up until the next
  // prompt starts or something actually needs you.
  addHook('Stop', hookCmd('done', 'stop'));
  addHook('SessionEnd', hookCmd('amber', 'session-end'));

  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// A "green" (working) session that hasn't updated in this long is assumed
// closed (terminal force-quit, crash, laptop slept without a graceful
// SessionEnd) — green sessions fire PreToolUse constantly while genuinely
// active, so persistent silence really does mean it's gone.
//
// A session waiting on you (amber/red) is different: Notification fires
// once and then nothing updates that file again until you actually respond
// (UserPromptSubmit -> green) or the session closes (SessionEnd -> removed)
// — there is no heartbeat while it waits. Applying the same short cutoff to
// it just means anything you don't get back to within a few minutes quietly
// stops counting as "needing you," which is backwards. So amber/red get a
// much longer leash — long enough to cover a legitimately long break,
// short enough to eventually drop a session whose SessionEnd never fired.
// Both are configurable (tray → Preferences) rather than hardcoded.

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
  const config = loadConfig();
  const workingStaleMs = config.workingStaleMinutes * 60 * 1000;
  const waitingStaleMs = config.waitingStaleHours * 60 * 60 * 1000;
  const now = Date.now();
  const sessions = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      const staleAfter = data.state === 'green' || data.state === 'done' ? workingStaleMs : waitingStaleMs;
      if (now - new Date(data.updatedAt).getTime() > staleAfter) continue;
      sessions.push(data);
    } catch {
      // skip unreadable/partially-written file
    }
  }
  return sessions;
}

// Priority: any session needing you (red) wins, then any session waiting on
// you (amber) — even if everything else is still busy, since that's the
// actionable state — and only if every session is green does the light show
// green. A manual override from the tray menu always wins until it expires
// or is cleared.
function aggregateState() {
  const override = readManualOverride();
  if (override) return { state: override.state, reason: 'manual', sessions: readSessions() };

  const sessions = readSessions();
  if (sessions.length === 0) return { state: 'amber', reason: 'idle', sessions: [] };

  if (sessions.some((s) => s.state === 'red')) return { state: 'red', reason: 'session', sessions };
  if (sessions.some((s) => s.state === 'amber')) return { state: 'amber', reason: 'session', sessions };
  if (sessions.some((s) => s.state === 'green')) return { state: 'green', reason: 'session', sessions };
  // Nothing red/amber/actively-working — if at least one session just
  // finished a task cleanly, show that instead of plain green so finishing
  // something actually reads as a small win, not silence.
  if (sessions.some((s) => s.state === 'done')) return { state: 'done', reason: 'session', sessions };
  return { state: 'green', reason: 'session', sessions };
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
    minWidth: MIN_WIDTH,
    minHeight: Math.round(MIN_WIDTH / WIDGET_ASPECT),
    maxWidth: MAX_WIDTH,
    maxHeight: Math.round(MAX_WIDTH / WIDGET_ASPECT),
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

let settingsWin = null;

function createSettingsWindow() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 360,
    height: 420,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Claude Traffic Light Preferences',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => {
    settingsWin = null;
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
    { label: 'Bigger', click: () => resizeBy(1.25) },
    { label: 'Smaller', click: () => resizeBy(0.8) },
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
    { label: 'Preferences…', click: createSettingsWindow },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('Claude Traffic Light');
  tray.setContextMenu(menu);
}

ipcMain.handle('open-claude', () => {
  shell.openExternal('https://claude.ai');
});

ipcMain.handle('get-window-position', () => {
  const [x, y] = win?.getPosition() || [0, 0];
  return { x, y };
});

ipcMain.on('set-window-position', (e, x, y) => {
  win?.setPosition(Math.round(x), Math.round(y));
});

// Scroll-to-resize: far easier to hit than dragging the true window edge of
// a small frameless widget. `factor` is a small multiplier per wheel tick
// (e.g. 1.03 / 0.97), not an absolute size.
ipcMain.on('resize-window-by', (e, factor) => {
  resizeBy(factor);
});

ipcMain.handle('get-aggregate-status', () => aggregateState());

// Click handler: jump to whichever session needs the user. We can't target
// an exact terminal tab/pane from outside the terminal, so this activates
// the terminal app and copies that session's folder to the clipboard. With
// more than one session waiting, each click cycles to the next one (oldest
// waiting first, so nothing gets stuck at the back of the queue forever);
// a red (limit-hit) session always jumps the queue to be shown first.
let cycleIndex = 0;

ipcMain.handle('go-to-needing-session', async () => {
  const { sessions } = aggregateState();
  const needing = sessions
    .filter((s) => s.state === 'red' || s.state === 'amber')
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  if (needing.length === 0) {
    shell.openExternal('https://claude.ai');
    cycleIndex = 0;
    return { opened: 'claude.ai', total: 0 };
  }

  const reds = needing.filter((s) => s.state === 'red');
  const queue = reds.length > 0 ? reds : needing;

  cycleIndex = cycleIndex % queue.length;
  const target = queue[cycleIndex];
  const shownIndex = cycleIndex + 1;
  cycleIndex += 1;

  clipboard.writeText(target.cwd);
  const folderHint = target.cwd.split('/').filter(Boolean).pop() || '';
  const activated = await activateTerminalApp(folderHint);
  return {
    opened: activated?.app || 'none-found',
    exact: activated?.exact || false,
    cwd: target.cwd,
    state: target.state,
    index: shownIndex,
    total: queue.length,
  };
});

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-config', (e, partial) => {
  const next = saveConfig(partial);
  win?.webContents.send('status-changed');
  return next;
});

// A subtle system alert sound when the widget transitions INTO amber or red
// — easy to miss a small corner light if you're not looking right at it.
// Tracked here (not in the renderer) since this is the one place that
// already polls aggregateState() on a timer regardless of whether the
// window is visible.
let lastSoundState = null;
function maybePlayAlertSound() {
  const config = loadConfig();
  if (!config.soundOnAmber) return;
  const { state } = aggregateState();
  const isAlert = state === 'amber' || state === 'red';
  if (isAlert && lastSoundState !== state) shell.beep();
  lastSoundState = isAlert ? state : null;
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  if (!areHooksInstalled()) installHooks();

  // Default to launching at login on first run only — respects the user
  // turning it back off afterwards (checked via a marker file since
  // Electron has no "was this ever set" query of its own).
  const autoLaunchMarker = path.join(ROOT_DIR, '.auto-launch-configured');
  if (!fs.existsSync(autoLaunchMarker)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.writeFileSync(autoLaunchMarker, new Date().toISOString());
  }

  createWindow();
  createTray();

  fs.watch(SESSIONS_DIR, { persistent: true }, () => {
    win?.webContents.send('status-changed');
    maybePlayAlertSound();
  });

  // Belt-and-braces poll: covers editors of manual-override.json and any
  // watcher events the OS coalesces or drops.
  setInterval(() => {
    win?.webContents.send('status-changed');
    maybePlayAlertSound();
  }, 4000);

  // Self-heal: something (a Claude Code update, hand-editing settings.json,
  // etc) could wipe our hooks out from under us. Check occasionally and
  // silently reinstall rather than requiring you to notice the widget's
  // gone quiet and dig into the tray menu yourself.
  setInterval(() => {
    if (!areHooksInstalled()) installHooks();
  }, 10 * 60 * 1000);
});

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
