const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen, clipboard, systemPreferences, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const Rules = require('./rules.js');
const Hooks = require('./hooks/install.js');
const Stats = require('./stats.js');

const WIDGET_ASPECT = 64 / 82; // width / height — matches the rig SVG viewBox
const MIN_WIDTH = 80;
const MAX_WIDTH = 320;

function resizeBy(factor) {
  if (!win) return;
  const [x, y, w, h] = [...win.getPosition(), ...win.getSize()];
  const newWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w * factor)));
  const newHeight = Math.round(newWidth / WIDGET_ASPECT);
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
// needs attention to the front, and try to raise the window whose title
// mentions the target folder via the Accessibility API.
const TERMINAL_APPS = ['Ghostty', 'iTerm2', 'iTerm', 'Terminal', 'Warp', 'Alacritty', 'kitty', 'WezTerm'];

function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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
  showWidget: true,
  menuBarMode: false,
};
const STATS_FILE = path.join(ROOT_DIR, 'stats.json');

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // no config yet
  }
  const config = { ...DEFAULT_CONFIG, ...saved };
  // Rules are stored whole; a config from before rules existed gets the
  // defaults, which reproduce the old fixed behaviour exactly.
  config.rules = (Array.isArray(saved.rules) ? saved.rules : Rules.defaultRules()).map(Rules.normalizeRule);
  config.presets = (Array.isArray(saved.presets) ? saved.presets : [])
    .filter((p) => p && typeof p.name === 'string' && Array.isArray(p.rules))
    .map((p) => ({ id: String(p.id || Rules.uid()), name: p.name.slice(0, 30), rules: p.rules.map(Rules.normalizeRule) }));
  return config;
}

function saveConfig(partial) {
  const next = { ...loadConfig(), ...partial };
  if (partial.rules) next.rules = partial.rules.map(Rules.normalizeRule);
  if (partial.presets) next.presets = partial.presets;
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ── Stats ──────────────────────────────────────────────────────────────────
let stats = { days: {} };
try {
  stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  if (!stats || typeof stats !== 'object') stats = { days: {} };
} catch {
  // first run
}
let lastTick = Date.now();
let statsDirty = false;
function tickStats(sessions) {
  const now = Date.now();
  Stats.tick(stats, sessions, now, now - lastTick);
  lastTick = now;
  statsDirty = true;
}
function flushStats() {
  if (!statsDirty) return;
  Stats.prune(stats);
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
  statsDirty = false;
}

// Inside the packaged .app, hooks/ is bundled as an extraResource; in dev it's
// the checked-out hooks/ dir next to main.js.
const HOOKS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'hooks') : path.join(__dirname, 'hooks');
const SET_STATUS_SCRIPT = path.join(HOOKS_DIR, 'set-status.js');

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function areHooksInstalled() {
  return Hooks.isInstalled(readClaudeSettings(), SET_STATUS_SCRIPT);
}

function installHooks() {
  const settings = Hooks.install(readClaudeSettings(), SET_STATUS_SCRIPT);
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

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

const WAITING_SIGNALS = new Set(Rules.SIGNALS.filter((s) => s.kind === 'waiting').map((s) => s.id));

// A working session pings constantly, so silence really means it's gone. A
// waiting session (permission ask, limit) gets one event and then nothing
// until you respond, so it gets a much longer leash. Both configurable.
function readSessions(config) {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const workingStaleMs = config.workingStaleMinutes * 60 * 1000;
  const waitingStaleMs = config.waitingStaleHours * 60 * 60 * 1000;
  const now = Date.now();
  const sessions = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      const signal = Rules.sessionSignal(data);
      if (!signal) continue;
      const staleAfter = WAITING_SIGNALS.has(signal) ? waitingStaleMs : workingStaleMs;
      if (now - new Date(data.updatedAt).getTime() > staleAfter) continue;
      sessions.push({ ...data, signal });
    } catch {
      // skip unreadable/partially-written file
    }
  }
  return sessions;
}

// A tray override is a synthetic session carrying the signal that the
// default rules map to that colour, so it flows through the user's rules.
const OVERRIDE_SIGNALS = { green: 'tool-use', amber: 'permission-ask', red: 'limit-hit' };

let previewLook = null; // set by the Lights editor's "Try on widget"

function aggregateState() {
  const config = loadConfig();
  const sessions = readSessions(config);
  if (previewLook && Date.now() < previewLook.expiresAt) {
    return { look: previewLook.look, reason: 'preview', sessions, fired: [] };
  }
  const override = readManualOverride();
  if (override) {
    const synthetic = [{ signal: OVERRIDE_SIGNALS[override.state] || 'idle', cwd: '' }];
    const { look, fired, owned } = Rules.resolve(config.rules, synthetic);
    return { look, reason: 'manual', sessions, fired, owned };
  }
  const { look, fired, owned } = Rules.resolve(config.rules, sessions);
  return { look, reason: sessions.length ? 'session' : 'idle', sessions, fired, owned };
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAspectRatio(WIDGET_ASPECT);
  win.loadFile('index.html');
  win.once('ready-to-show', () => { if (loadConfig().showWidget) win?.showInactive(); });

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
    height: 560,
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

let lightsWin = null;

function createLightsWindow() {
  if (lightsWin) {
    lightsWin.show();
    lightsWin.focus();
    return;
  }
  lightsWin = new BrowserWindow({
    width: 800,
    height: 620,
    minWidth: 720,
    minHeight: 560,
    useContentSize: true,
    title: 'Lights',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1a1f',
    webPreferences: {
      preload: path.join(__dirname, 'lights-preload.js'),
      contextIsolation: true,
      // The live preview must keep animating when this window sits behind
      // the terminal; macOS occlusion would otherwise freeze it.
      backgroundThrottling: false,
    },
  });
  lightsWin.setMenuBarVisibility(false);
  // Dev: `electron . --lights --shot out.png [--select <ruleId>] [--mode live]`
  // captures the editor and quits.
  const shotAt = process.argv.indexOf('--shot');
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
  const query = {};
  if (arg('--select')) query.select = arg('--select');
  if (arg('--mode')) query.mode = arg('--mode');
  if (arg('--pose')) query.pose = arg('--pose');
  if (arg('--view')) query.view = arg('--view');
  if (arg('--costume')) query.costume = arg('--costume');
  if (arg('--text')) query.text = arg('--text');
  lightsWin.loadFile('lights.html', { query });
  if (shotAt > 0 && process.argv[shotAt + 1]) {
    lightsWin.webContents.once('did-finish-load', () => {
      lightsWin.show();
      lightsWin.focus();
      setTimeout(async () => {
        // Dev: `--playtest` runs test/playtest.js inside the editor window and
        // prints its report; exits non-zero on any failure.
        if (process.argv.includes('--playtest')) {
          const script = fs.readFileSync(path.join(__dirname, 'test', 'playtest.js'), 'utf8');
          const report = await lightsWin.webContents.executeJavaScript(script);
          console.log(report.log.join('\n'));
          process.exitCode = report.failed ? 1 : 0;
        }
        const img = await lightsWin.webContents.capturePage();
        fs.writeFileSync(process.argv[shotAt + 1], img.toPNG());
        // Dev: `--shot-overlay out.png` previews the ak47 pose on the widget
        // and captures the bullet overlay window.
        // Dev: `--shot-widget out.png` captures the widget with its real look.
        if (arg('--shot-widget') && win) {
          await new Promise((r) => setTimeout(r, 800));
          fs.writeFileSync(arg('--shot-widget'), (await win.webContents.capturePage()).toPNG());
          console.log('[shot] widget look', JSON.stringify(aggregateState().look));
        }
        // Dev: `--shot-tray out.png` renders the menu-bar icon frame.
        if (arg('--shot-tray')) {
          ensureTrayRenderer();
          await new Promise((r) => setTimeout(r, 900));
          const { look } = aggregateState();
          trayRenderWin.webContents.send('look', { ...look, pose: 'think', costume: 'crown', facing: 'right' });
          await new Promise((r) => setTimeout(r, 400));
          const img = await trayRenderWin.webContents.capturePage();
          fs.writeFileSync(arg('--shot-tray'), img.toPNG());
          console.log('[shot] tray frame', JSON.stringify(img.getSize()));
        }
        const ov = arg('--shot-overlay');
        if (ov) {
          previewLook = { look: { lamp: 'amber', eyes: 'default', pose: 'ak47', name: 'shot' }, expiresAt: Date.now() + 8000 };
          broadcastStatus();
          await new Promise((r) => setTimeout(r, 900));
          if (overlayWin) {
            console.log('[shot] overlay bounds', JSON.stringify(overlayWin.getBounds()), 'aim', JSON.stringify(aimForOverlay()), 'screen', JSON.stringify(widgetMuzzle()?.screenPoint));
            fs.writeFileSync(ov, (await overlayWin.webContents.capturePage()).toPNG());
            if (win) fs.writeFileSync(ov.replace(/\.png$/, '-widget.png'), (await win.webContents.capturePage()).toPNG());
            console.log('[shot] widget bounds', JSON.stringify(win?.getBounds()));
          } else {
            console.log('[shot] overlay window did not open');
          }
        }
        app.quit();
      }, 2000);
    });
  }
  lightsWin.on('closed', () => {
    lightsWin = null;
  });
}

// ── Bullet overlay ──────────────────────────────────────────────────────────
// A click-through, transparent window covering the widget's display, opened
// only while the resolved pose is ak47 and closed the moment it isn't. The
// muzzle sits at the rifle's tip on the widget; rounds fly toward the wider
// side of the screen so they cross the most desktop.
let overlayWin = null;
let overlayDisplayId = null;
let burstTimer = null;
const BURST_MS = 1200;
const BURST_EVERY_MS = 15000;

function widgetMuzzle() {
  if (!win) return null;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  // Rig viewBox is 64x82 inside a 12px body padding; the rifle tip sits at
  // x=67 (facing right) or x=-3 (mirrored, see rig.css .face-left), y=50.
  const inner = { x: b.x + 12, y: b.y + 12, w: b.width - 24, h: b.height - 24 };
  const sx = inner.w / 64;
  const sy = inner.h / 82;
  const dir = inner.x + inner.w / 2 - wa.x < wa.width / 2 ? 1 : -1;
  const x = inner.x + (dir === 1 ? 67 : -3) * sx;
  const y = inner.y + 50 * sy;
  return { display, screenPoint: { x, y }, dir, facing: dir === 1 ? 'right' : 'left' };
}

// Aim is expressed in the overlay window's own coordinates, from its REAL
// bounds — macOS may shift a window that starts at the display origin below
// the menu bar, and an aim computed from display bounds would then land the
// rounds below the barrel.
function aimForOverlay() {
  const m = widgetMuzzle();
  if (!m || !overlayWin) return null;
  const ob = overlayWin.getBounds();
  return { x: m.screenPoint.x - ob.x, y: m.screenPoint.y - ob.y, dir: m.dir };
}

function fireBurst() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const aim = aimForOverlay();
  if (!aim) return;
  overlayWin.webContents.send('burst', aim, BURST_MS);
  win?.webContents.send('burst', BURST_MS);
}

function stopOverlay() {
  clearInterval(burstTimer);
  burstTimer = null;
  if (!overlayWin) return;
  const w = overlayWin;
  overlayWin = null;
  if (!w.isDestroyed()) {
    w.webContents.send('stop');
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 1500);
  }
}

function prefersReducedMotion() {
  try {
    return process.platform === 'darwin' && systemPreferences.getAnimationSettings().prefersReducedMotion;
  } catch {
    return false;
  }
}

function updateOverlay(look) {
  const wants = look.pose === 'ak47' && win && win.isVisible() && !prefersReducedMotion();
  if (!wants) { stopOverlay(); return; }
  const m = widgetMuzzle();
  if (!m) return;
  if (overlayWin && overlayDisplayId !== m.display.id) stopOverlay();
  if (overlayWin) return;
  overlayDisplayId = m.display.id;
  overlayWin = new BrowserWindow({
    ...m.display.bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile('overlay.html');
  overlayWin.once('ready-to-show', () => {
    if (!overlayWin) return;
    overlayWin.showInactive();
    // Re-assert the display bounds now that the level allows covering the
    // menu bar; the aim is computed from whatever bounds we actually got.
    overlayWin.setBounds(m.display.bounds);
    fireBurst();
    clearInterval(burstTimer);
    burstTimer = setInterval(fireBurst, BURST_EVERY_MS);
  });
  overlayWin.on('closed', () => { overlayWin = null; });
  // The widget sits above the overlay so it is never painted over.
  win.setAlwaysOnTop(true, 'screen-saver', 2);
}

// ── Menu-bar mode ───────────────────────────────────────────────────────────
// An offscreen window renders the rig at menu-bar size; its frames become
// the tray image. Off by default; the template icon is used otherwise.
let trayRenderWin = null;
let trayTimer = null;
let trayLastKey = null;

function ensureTrayRenderer() {
  if (trayRenderWin) return;
  trayRenderWin = new BrowserWindow({
    width: 18,
    height: 22,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'tray-preload.js'), contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  trayRenderWin.webContents.setFrameRate(4);
  trayRenderWin.loadFile('tray.html');
  trayRenderWin.on('closed', () => { trayRenderWin = null; });
}

async function paintTray() {
  if (!tray || !trayRenderWin || trayRenderWin.isDestroyed() || trayRenderWin.webContents.isLoading()) return;
  const { look } = aggregateState();
  trayRenderWin.webContents.send('look', { ...look, facing: 'right' });
  const img = await trayRenderWin.webContents.capturePage();
  const size = img.getSize();
  if (!size.width) return;
  // capturePage returns device pixels; tell the tray the scale so it draws
  // at 18x22 points.
  const scale = size.width / 18;
  const icon = nativeImage.createFromBuffer(img.toPNG(), { scaleFactor: scale });
  tray.setImage(icon);
}

function updateTrayMode() {
  const on = loadConfig().menuBarMode;
  if (on) {
    ensureTrayRenderer();
    if (!trayTimer) trayTimer = setInterval(() => paintTray().catch(() => {}), 500);
  } else {
    clearInterval(trayTimer);
    trayTimer = null;
    if (trayRenderWin) { trayRenderWin.close(); trayRenderWin = null; }
    tray?.setImage(path.join(__dirname, 'assets', 'trayTemplate.png'));
  }
}

function applyWidgetVisibility() {
  if (!win) return;
  if (loadConfig().showWidget) win.showInactive(); else win.hide();
}

function broadcastStatus() {
  win?.webContents.send('status-changed');
  lightsWin?.webContents.send('status-changed');
  try { updateOverlay(aggregateState().look); } catch (e) { console.log('[overlay]', e.message); }
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
    broadcastStatus();
  }

  function clearManual() {
    fs.rm(MANUAL_OVERRIDE_FILE, { force: true }, broadcastStatus);
  }

  const hooksLabel = areHooksInstalled() ? 'Reinstall Claude Code Hooks' : 'Install Claude Code Hooks (required)';

  const menu = Menu.buildFromTemplate([
    { label: 'Open Claude', click: () => shell.openExternal('https://claude.ai') },
    {
      label: 'Floating Widget',
      type: 'checkbox',
      checked: loadConfig().showWidget,
      click: (item) => { saveConfig({ showWidget: item.checked }); applyWidgetVisibility(); broadcastStatus(); },
    },
    {
      label: 'Claude in the Menu Bar',
      type: 'checkbox',
      checked: loadConfig().menuBarMode,
      click: (item) => { saveConfig({ menuBarMode: item.checked }); updateTrayMode(); },
    },
    { type: 'separator' },
    { label: 'Lights…', accelerator: 'CmdOrCtrl+L', click: createLightsWindow },
    { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: createSettingsWindow },
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
  updateTrayMode();
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

ipcMain.on('resize-window-by', (e, factor) => {
  resizeBy(factor);
});

ipcMain.handle('get-aggregate-status', () => {
  const state = aggregateState();
  const facing = widgetMuzzle()?.facing || 'right';
  return { ...state, look: { ...state.look, facing } };
});

// Click handler: jump to whichever session needs the user — the ones whose
// live signal is a waiting one. Cycles through them, oldest first; a limit
// hit jumps the queue.
let cycleIndex = 0;

ipcMain.handle('go-to-needing-session', async () => {
  const { sessions } = aggregateState();
  const needing = sessions
    .filter((s) => WAITING_SIGNALS.has(s.signal))
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  if (needing.length === 0) {
    shell.openExternal('https://claude.ai');
    cycleIndex = 0;
    return { opened: 'claude.ai', total: 0 };
  }

  const limits = needing.filter((s) => s.signal === 'limit-hit');
  const queue = limits.length > 0 ? limits : needing;

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
    signal: target.signal,
    index: shownIndex,
    total: queue.length,
  };
});

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-config', (e, partial) => {
  const next = saveConfig(partial);
  if ('showWidget' in partial) applyWidgetVisibility();
  if ('menuBarMode' in partial || 'showWidget' in partial) createTray();
  broadcastStatus();
  return next;
});

ipcMain.handle('get-stats', () => Stats.summary(stats));

ipcMain.handle('reset-rules', () => {
  const next = saveConfig({ rules: Rules.defaultRules() });
  broadcastStatus();
  return next;
});

// The Lights editor can push a look onto the real widget for a few seconds so
// the user sees the rule in place, at size, in the corner it actually lives in.
ipcMain.handle('preview-on-widget', (e, look, ms = 4000) => {
  previewLook = { look, expiresAt: Date.now() + ms };
  win?.show();
  broadcastStatus();
  setTimeout(() => {
    if (previewLook && Date.now() >= previewLook.expiresAt) previewLook = null;
    broadcastStatus();
  }, ms + 50);
});

ipcMain.handle('open-lights', createLightsWindow);
ipcMain.handle('open-preferences', createSettingsWindow);

// A subtle system alert sound when the resolved look's sound channel turns on
// (transition only, not every poll).
let lastSoundKey = null;
function maybePlayAlertSound() {
  const config = loadConfig();
  const { look, reason, owned } = aggregateState();
  if (reason === 'preview') return;
  const key = look.sound ? `${look.sound}:${owned.sound}` : null;
  if (config.soundOnAmber && key && key !== lastSoundKey) shell.beep();
  lastSoundKey = key;
}

// Dev captures (--shot, --playtest) must run beside the installed app, so
// they take their own userData (and therefore their own instance lock).
if (process.argv.includes('--shot') || process.argv.includes('--playtest')) {
  app.setPath('userData', path.join(os.tmpdir(), 'claude-traffic-light-dev'));
}

// One widget, one tray. A second launch (e.g. `open -a … --args --lights`)
// hands its flags to the running instance instead of starting another.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    if (argv.includes('--lights')) createLightsWindow();
    else win?.show();
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  if (!areHooksInstalled()) installHooks();

  const autoLaunchMarker = path.join(ROOT_DIR, '.auto-launch-configured');
  if (!fs.existsSync(autoLaunchMarker)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.writeFileSync(autoLaunchMarker, new Date().toISOString());
  }

  createWindow();
  createTray();
  if (process.argv.includes('--lights')) createLightsWindow();

  fs.watch(SESSIONS_DIR, { persistent: true }, () => {
    broadcastStatus();
    maybePlayAlertSound();
  });

  setInterval(() => {
    broadcastStatus();
    maybePlayAlertSound();
    tickStats(readSessions(loadConfig()));
  }, 4000);
  setInterval(flushStats, 30000);
  app.on('before-quit', flushStats);

  setInterval(() => {
    if (!areHooksInstalled()) installHooks();
  }, 10 * 60 * 1000);
});

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
