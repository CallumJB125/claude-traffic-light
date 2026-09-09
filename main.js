const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen, clipboard, systemPreferences, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const Rules = require('./rules.js');
const Hooks = require('./hooks/install.js');
const Stats = require('./stats.js');
const http = require('http');

// `--demo weed`: a self-contained showing of the garden's weed scene — its
// own home folder, a 24x clock, every plant is weed, a long deal, then quit.
const DEMO = process.argv.includes('--demo') ? process.argv[process.argv.indexOf('--demo') + 1] || 'weed' : null;
if (DEMO === 'weed') {
  process.env.CLAUDE_TRAFFIC_LIGHT_HOME = path.join(os.tmpdir(), 'claude-traffic-light-demo');
  process.env.CLAUDE_TRAFFIC_LIGHT_GARDEN_SPEED = '24';
  process.env.CLAUDE_TRAFFIC_LIGHT_WEED_ONE_IN = '1';
  process.env.CLAUDE_TRAFFIC_LIGHT_DEAL_MS = '30000';
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT = '47180';
  fs.rmSync(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions'), { recursive: true });
  const demoRules = Rules.defaultRules().map((r) => (r.id === 'idle' ? { ...r, then: { ...r.then, effect: 'garden', pose: 'none' } } : r));
  fs.writeFileSync(path.join(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, 'config.json'), JSON.stringify({ rules: demoRules, roam: false, randomEvents: false, seasonal: false, showTasks: false }));
}

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
const TERMINAL_APPS = process.platform === 'win32'
  ? ['WindowsTerminal', 'wt', 'Windows Terminal', 'powershell', 'cmd', 'Alacritty', 'WezTerm', 'Code', 'Cursor']
  : ['Ghostty', 'iTerm2', 'iTerm', 'Terminal', 'Warp', 'Alacritty', 'kitty', 'WezTerm'];

function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function activateTerminalApp(folderHint) {
  if (IS_WIN) {
    // Best effort: AppActivate matches a window title containing the folder,
    // falling back to a terminal's own name.
    return new Promise((resolve) => {
      const tries = [folderHint, 'Windows Terminal', 'PowerShell', 'Command Prompt'].filter(Boolean);
      const ps = `$w = New-Object -ComObject WScript.Shell; foreach ($t in @(${tries.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})) { if ($w.AppActivate($t)) { Write-Output $t; exit } }; Write-Output NONE`;
      execFile('powershell', ['-NoProfile', '-c', ps], (err, out) => {
        const hit = (out || '').trim();
        resolve(!err && hit && hit !== 'NONE' ? { app: hit, exact: hit === folderHint } : null);
      });
    });
  }
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
  seasonal: true,
  askFromWidget: false,
  showTasks: true,
  roam: true,
  randomEvents: true,
};
const REQUESTS_DIR = path.join(ROOT_DIR, 'requests');
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
  // Migration: configs saved before the idle nudge became a waiting signal
  // have no rule for it, and the widget would go dark after a finished turn.
  // Slot the default "Waiting for you" rule in just above "Nothing running".
  if (!config.rules.some((r) => r.when.signal.includes('idle-nudge'))) {
    const nudge = Rules.defaultRules().find((r) => r.id === 'nudge');
    const at = config.rules.findIndex((r) => r.when.signal.includes('idle'));
    config.rules.splice(at < 0 ? config.rules.length : at, 0, Rules.normalizeRule(nudge));
  }
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
const EMIT_SCRIPT = path.join(HOOKS_DIR, 'emit.js');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function hookOptions() {
  return { askFromWidget: !!loadConfig().askFromWidget };
}

function areHooksInstalled() {
  return Hooks.isInstalled(readClaudeSettings(), SET_STATUS_SCRIPT, hookOptions());
}

function installHooks() {
  const settings = Hooks.install(readClaudeSettings(), SET_STATUS_SCRIPT, hookOptions());
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(REQUESTS_DIR, { recursive: true });

// ── Local endpoint: any agent can POST a signal ────────────────────────────
//   curl -X POST http://127.0.0.1:47172/signal -H 'content-type: application/json' \
//        -d '{"source":"chatgpt","session":"abc","signal":"tool-use","tool":"Bash","cwd":"/x"}'
const SIGNAL_PORT = Number(process.env.CLAUDE_TRAFFIC_LIGHT_PORT || 47172);
const KNOWN_SIGNALS = new Set(Rules.SIGNALS.filter((x) => x.hook).map((x) => x.id).concat(['session-end']));
function startSignalServer() {
  const server = http.createServer((req, res) => {
    const done = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET' }); return res.end(); }
    if (req.method === 'GET' && req.url === '/status') { const st = aggregateState(); return done(200, { look: st.look, sessions: st.sessions.map((x) => ({ source: x.source || 'claude', signal: x.signal, cwd: x.cwd, updatedAt: x.updatedAt })) }); }
    if (req.method !== 'POST' || req.url !== '/signal') return done(404, { error: 'POST /signal or GET /status' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body || '{}'); } catch { return done(400, { error: 'bad json' }); }
      if (!KNOWN_SIGNALS.has(d.signal)) return done(400, { error: 'unknown signal', known: [...KNOWN_SIGNALS] });
      const source = String(d.source || 'custom').replace(/[^\w.-]/g, '').slice(0, 24) || 'custom';
      const session = String(d.session || 'default').replace(/[^\w.-]/g, '').slice(0, 80) || 'default';
      const file = path.join(SESSIONS_DIR, `${os.hostname().split('.')[0]}-${source}-${session}.json`);
      if (d.signal === 'session-end') { fs.rmSync(file, { force: true }); broadcastStatus(); return done(200, { ok: true }); }
      let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first */ }
      const now = new Date().toISOString();
      const turnEnd = new Set(['stop', 'idle-nudge', 'permission-ask', 'limit-hit', 'session-start']);
      const workingSince = d.signal === 'prompt-submit' ? now : turnEnd.has(d.signal) ? null : (prev?.workingSince || now);
      fs.writeFileSync(file, JSON.stringify({ sessionId: session, host: os.hostname().split('.')[0], source, cwd: typeof d.cwd === 'string' ? d.cwd.slice(0, 500) : '', signal: d.signal, tool: typeof d.tool === 'string' ? d.tool.slice(0, 80) : null, workingSince, tasks: prev?.tasks || { created: 0, done: 0 }, updatedAt: now }, null, 2));
      broadcastStatus();
      done(200, { ok: true });
    });
  });
  server.on('error', (e) => console.log('[signal server]', e.message));
  server.listen(SIGNAL_PORT, '127.0.0.1');
}

// ── Pending permission requests (from the PermissionRequest hook) ──────────
function readRequests() {
  let files = [];
  try { files = fs.readdirSync(REQUESTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(REQUESTS_DIR, f), 'utf8'));
      if (Date.now() - new Date(r.createdAt).getTime() > 90000) continue; // hook has long since timed out
      out.push(r);
    } catch { /* partial write */ }
  }
  return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function answerRequest(id, decision) {
  if (!/^[\w.-]+$/.test(id) || !['allow', 'deny'].includes(decision)) return false;
  const req = path.join(REQUESTS_DIR, `${id}.json`);
  if (!fs.existsSync(req)) return false;
  fs.writeFileSync(path.join(REQUESTS_DIR, `${id}.answer`), decision);
  return true;
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

let gardenRun = null;
function saveBounds() {
  if (!win || gardenRun || roamState.busy) return;
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

// Anything waiting on the person keeps its file for hours (no heartbeat
// while it waits); that now includes the post-turn idle nudge, so the
// ignored-for-N-minutes signals can build on it.
const WAITING_SIGNALS = Rules.WAITING_ON_YOU;

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
let travelLook = null;  // set while Claude is walking to your terminal

function sumTasks(sessions) {
  let created = 0, done = 0;
  for (const s of sessions) if (s.tasks) { created += s.tasks.created || 0; done += s.tasks.done || 0; }
  return { created, done };
}

function aggregateState() {
  const config = loadConfig();
  const sessions = readSessions(config);
  const pending = config.askFromWidget ? readRequests() : [];
  const tasks = config.showTasks ? sumTasks(sessions.filter((s) => !WAITING_SIGNALS.has(s.signal) && s.signal !== 'idle-nudge')) : null;
  if (previewLook && Date.now() < previewLook.expiresAt) {
    return { look: previewLook.look, reason: 'preview', sessions, fired: [], pending: [], tasks: null };
  }
  if (travelLook) {
    return { look: { ...travelLook, tasks }, reason: 'travel', sessions, fired: [], pending, tasks };
  }
  const override = readManualOverride();
  if (override) {
    const synthetic = [{ signal: OVERRIDE_SIGNALS[override.state] || 'idle', cwd: '' }];
    const { look, fired, owned } = Rules.resolve(config.rules, synthetic);
    return { look: { ...look, tasks }, reason: 'manual', sessions, fired, owned, pending, tasks };
  }
  const { look, fired, owned } = Rules.resolve(config.rules, sessions);
  if (config.seasonal) {
    if (look.costume === 'none') look.costume = Rules.seasonalCostume() || 'none';
    if (look.effect === 'none') look.effect = Rules.seasonalEffect() || 'none';
  }
  // A pending permission request is the "Needs your input" state, whatever
  // the session files say (the hook blocks before Notification fires).
  if (pending.length) {
    const asked = Rules.resolve(config.rules, [{ signal: 'permission-ask', cwd: pending[0].cwd }]).look;
    return { look: { ...asked, tasks }, reason: 'session', sessions, fired: ['permission'], owned, pending, tasks };
  }
  return { look: { ...withNumber(look, sessions, tasks), tasks }, reason: sessions.length ? 'session' : 'idle', sessions, fired, owned, pending, tasks };
}

// Number mode: the digit the sign shows instead of a colour.
function withNumber(look, sessions, tasks) {
  if (!look.numberOf) return look;
  let n = null;
  if (look.numberOf === 'sessions') n = sessions.length;
  else if (look.numberOf === 'minutes') n = look.waitMinutes || 0;
  else if (look.numberOf === 'tasks') n = tasks ? Math.max(0, tasks.created - tasks.done) : 0;
  return { ...look, number: n == null ? null : Math.min(99, n) };
}

// ── Sounds ──────────────────────────────────────────────────────────────────
function playSound(name) {
  if (!name) return;
  win?.webContents.send('sound-flash');
  if (name === 'beep') { shell.beep(); return; }
  if (IS_WIN) {
    if (!name.startsWith('file:')) { shell.beep(); return; }
    execFile('powershell', ['-NoProfile', '-c', `(New-Object Media.SoundPlayer '${name.slice(5).replace(/'/g, "''")}').PlaySync()`], () => {});
    return;
  }
  const file = name.startsWith('file:') ? name.slice(5) : `/System/Library/Sounds/${name}.aiff`;
  if (!fs.existsSync(file)) { shell.beep(); return; }
  execFile('afplay', [file], () => {});
}

function speak(text) {
  if (IS_WIN) execFile('powershell', ['-NoProfile', '-c', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${String(text).replace(/'/g, "''")}')`], () => {});
  else execFile('say', [text], () => {});
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
  // ready-to-show is unreliable for transparent windows on macOS, so show on
  // load, with a fallback in case that never fires either.
  const reveal = () => { if (win && !win.isVisible() && loadConfig().showWidget) win.showInactive(); };
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 1500);

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
    width: 380,
    height: 820,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Claude Buddy Preferences',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile('settings.html');
  if (IS_MAC) app.dock.show();
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (process.platform === 'darwin' && !lightsWin) app.dock.hide();
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
  for (const k of ['costume', 'body', 'effect', 'pet', 'eyes', 'event', 'scroll', 'lampfx', 'sign', 'shape', 'signfx', 'number', 'speed']) if (arg(`--${k}`)) query[k] = arg(`--${k}`);
  if (arg('--text')) query.text = arg('--text');
  lightsWin.loadFile('lights.html', { query });
  if (shotAt > 0 && process.argv[shotAt + 1]) {
    lightsWin.webContents.once('did-finish-load', () => {
      lightsWin.show();
      lightsWin.focus();
      setTimeout(async () => {
        if (arg('--wait')) await new Promise((r) => setTimeout(r, Number(arg('--wait'))));
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
        if (process.argv.includes('--rigdbg')) console.log('[shot] rigdbg', await lightsWin.webContents.executeJavaScript(`(() => { const s = document.querySelector('#stage-rig svg'); const q = (sel) => { const e = s.querySelector(sel); return e ? getComputedStyle(e).opacity : 'MISSING'; }; return JSON.stringify({ cls: s.className.baseVal, grin: q('.grin'), skate: q('.skate'), table: q('.table'), errs: window.__errs || [] }); })()`));
        // Dev: `--shot-overlay out.png` previews the ak47 pose on the widget
        // and captures the bullet overlay window.
        // Dev: `--shot-widget out.png` captures the widget with its real look.
        if (arg('--shot-widget') && win) {
          await new Promise((r) => setTimeout(r, 800));
          fs.writeFileSync(arg('--shot-widget'), (await win.webContents.capturePage()).toPNG());
          console.log('[shot] widget look', JSON.stringify(aggregateState().look));
        }
        // Dev: `--shot-garden out.png` captures the overlay mid-garden plus the widget's position.
        if (arg('--shot-garden')) {
          if (overlayWin) fs.writeFileSync(arg('--shot-garden'), (await overlayWin.webContents.capturePage()).toPNG());
          console.log('[shot] garden', JSON.stringify({ overlay: !!overlayWin, widget: win?.getBounds(), pots: gardenRun?.pots.length, states: gardenRun?.pots.map((p) => p.state || (p.crop ? 'g' : '-')).join(''), act: travelLook?.gardenAct || null }));
          if (overlayWin) console.log('[shot] overlay-state', await overlayWin.webContents.executeJavaScript('JSON.stringify({ on: garden.on, pots: garden.pots.length, racks: garden.pots.filter(p => p.rack).length, crops: garden.pots.filter(p => p.crop).length, deal: !!garden.deal, errs: window.__errs.slice(0, 3), raf: !!raf, W, H })'));
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
            console.log('[shot] overlay bounds', JSON.stringify(overlayWin.getBounds()), 'aim', JSON.stringify(aimAtCursor('ak47')?.muzzle));
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
  if (IS_MAC) app.dock.show();
  lightsWin.on('closed', () => {
    lightsWin = null;
    if (process.platform === 'darwin' && !settingsWin) app.dock.hide();
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
let snipeTimer = null;
let aimTimer = null;
let overlayPose = null;
const BURST_MS = 1200;
const BURST_EVERY_MS = 15000;
const SNIPE_EVERY_MS = 7000;
const AIM_CLAMP_DEG = 35;

// Where the gun is, where the cursor is, and the angle between them.
// Rig coords: the grip pivot is (44,50) facing right, (20,50) mirrored; the
// AK muzzle sits 23 units from the pivot, the sniper's 39. The rig rotates
// the gun by `angle` (degrees, positive = down), so the muzzle's screen
// position follows the same rotation and rounds leave the barrel.
function aimAtCursor(pose) {
  if (!win) return null;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const cursor = screen.getCursorScreenPoint();
  const inner = { x: b.x + 12, y: b.y + 12, w: b.width - 24, h: b.height - 24 };
  const sx = inner.w / 64;
  const sy = inner.h / 82;
  const centreX = inner.x + 32 * sx;
  const facing = cursor.x >= centreX ? 'right' : 'left';
  const pivot = { x: inner.x + (facing === 'right' ? 44 : 20) * sx, y: inner.y + 50 * sy };
  const dx = Math.abs(cursor.x - pivot.x);
  const dy = cursor.y - pivot.y;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  angle = Math.max(-AIM_CLAMP_DEG, Math.min(AIM_CLAMP_DEG, angle));
  const len = (pose === 'sniper' ? 39 : 23) * sx;
  const rad = (angle * Math.PI) / 180;
  const dirX = facing === 'right' ? 1 : -1;
  const muzzle = { x: pivot.x + dirX * Math.cos(rad) * len, y: pivot.y + Math.sin(rad) * len };
  // Direction of fire: straight at the cursor from the muzzle.
  const vx = cursor.x - muzzle.x, vy = cursor.y - muzzle.y;
  const n = Math.hypot(vx, vy) || 1;
  return { display, facing, angle, muzzle, cursor, dir: { x: vx / n, y: vy / n } };
}

function toOverlay(pt) {
  const ob = overlayWin.getBounds();
  return { x: pt.x - ob.x, y: pt.y - ob.y };
}

function fireBurst() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const a = aimAtCursor('ak47');
  if (!a) return;
  overlayWin.webContents.send('burst', { ...toOverlay(a.muzzle), dir: a.dir }, BURST_MS);
  win?.webContents.send('burst', BURST_MS);
}

function fireSnipe() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const a = aimAtCursor('sniper');
  if (!a) return;
  // Scope the cursor for a moment, then the shot lands where it is THEN.
  overlayWin.webContents.send('scope', toOverlay(a.cursor));
  setTimeout(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = aimAtCursor('sniper');
    if (!b) return;
    overlayWin.webContents.send('snipe', toOverlay(b.muzzle), toOverlay(b.cursor));
    win?.webContents.send('burst', 250);
  }, 700);
}

// Keep the gun pointed at the cursor while a gun pose is live.
function pushAim() {
  if (!win || !overlayPose) return;
  const a = aimAtCursor(overlayPose);
  if (!a) return;
  win.webContents.send('aim', { facing: a.facing, aimAngle: a.angle });
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('track', toOverlay(a.cursor));
}

function stopOverlay() {
  overlayFx = 'none';
  clearInterval(burstTimer); burstTimer = null;
  clearInterval(snipeTimer); snipeTimer = null;
  clearInterval(aimTimer); aimTimer = null;
  overlayPose = null;
  win?.webContents.send('aim', { facing: widgetMuzzle()?.facing || 'right', aimAngle: 0 });
  if (!overlayWin) return;
  const w = overlayWin;
  overlayWin = null;
  if (!w.isDestroyed()) {
    w.webContents.send('stop');
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 2500);
  }
}

let overlayFx = 'none';
async function pushScreenFx(fx) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const payload = { fx };
  if (fx === 'spotlight' && IS_MAC) {
    const app = await runningTerminal();
    const icon = app ? await dockIconRect(app) : null;
    if (icon && overlayWin && !overlayWin.isDestroyed()) {
      const ob = overlayWin.getBounds();
      const m = widgetMuzzle();
      payload.target = { x: icon.x + icon.w / 2 - ob.x, y: icon.y + icon.h / 2 - ob.y };
      payload.from = m ? { x: m.screenPoint.x - ob.x, y: m.screenPoint.y - ob.y } : null;
    }
  }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('fx', payload);
}

function updateOverlay(look) {
  const gun = look.pose === 'ak47' || look.pose === 'sniper' ? look.pose : null;
  const fx = look.screenFx && look.screenFx !== 'none' ? look.screenFx : (look.effect === 'garden' || gardenRun ? 'garden' : null);
  const wants = (gun || fx) && win && win.isVisible() && !prefersReducedMotion();
  if (!wants) { stopOverlay(); overlayFx = 'none'; return; }
  const m = widgetMuzzle();
  if (!m) return;
  if (overlayWin && (overlayDisplayId !== m.display.id || overlayPose !== gun)) stopOverlay();
  if (overlayWin) {
    if (overlayFx !== (fx || 'none')) { overlayFx = fx || 'none'; pushScreenFx(overlayFx); }
    return;
  }
  overlayDisplayId = m.display.id;
  overlayPose = gun;
  overlayFx = fx || 'none';
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
    overlayWin.setBounds(m.display.bounds);
    if (gun) aimTimer = setInterval(pushAim, 120);
    if (gun === 'ak47') { fireBurst(); burstTimer = setInterval(fireBurst, BURST_EVERY_MS); }
    else if (gun === 'sniper') { fireSnipe(); snipeTimer = setInterval(fireSnipe, SNIPE_EVERY_MS); }
    if (overlayFx !== 'none') pushScreenFx(overlayFx);
  });
  overlayWin.on('closed', () => { overlayWin = null; });
  win.setAlwaysOnTop(true, 'screen-saver', 2);
}

function widgetMuzzle() {
  if (!win) return null;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const inner = { x: b.x + 12, y: b.y + 12, w: b.width - 24, h: b.height - 24 };
  const sx = inner.w / 64;
  const sy = inner.h / 82;
  const dir = inner.x + inner.w / 2 - wa.x < wa.width / 2 ? 1 : -1;
  const x = inner.x + (dir === 1 ? 67 : -3) * sx;
  const y = inner.y + 50 * sy;
  return { display, screenPoint: { x, y }, dir, facing: dir === 1 ? 'right' : 'left' };
}

function prefersReducedMotion() {
  try {
    return process.platform === 'darwin' && systemPreferences.getAnimationSettings().prefersReducedMotion;
  } catch {
    return false;
  }
}

// ── Menu-bar mode ───────────────────────────────────────────────────────────
// An offscreen window renders the rig at menu-bar size; its frames become
// the tray image. Off by default; the template icon is used otherwise.
let trayRenderWin = null;
let trayTimer = null;

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
  const scale = size.width / 18;
  tray.setImage(nativeImage.createFromBuffer(img.toPNG(), { scaleFactor: scale }));
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
    tray?.setImage(path.join(__dirname, 'assets', IS_WIN ? 'tray-win.png' : 'trayTemplate.png'));
  }
}

function applyWidgetVisibility() {
  if (!win) return;
  if (loadConfig().showWidget) win.showInactive(); else win.hide();
}

// ── Garden on the real screen (Desktop-Goose style) ────────────────────────
// The widget drops to the bottom of its display and walks along it: off the
// screen edge for pots, back to place them, then plants, waters, eats and
// rotates. The overlay draws the bed, pots and crops at screen scale; the
// rig shows what he's carrying or doing via look.gardenAct.
const GSPEED = Number(process.env.CLAUDE_TRAFFIC_LIGHT_GARDEN_SPEED || 1);
// Slower, bigger: twelve pots spread over the whole display in a jittered
// grid, so the screen becomes the garden. One plant in thirty is weed — it
// gets dried on a rack for ten minutes, then a buyer comes for it.
const GT = { FETCH: 240000 / GSPEED, PLANT: 360000 / GSPEED, GROW: 240000 / GSPEED, EAT_EVERY: 40000 / GSPEED, ROTATE: 900000 / GSPEED, DRY: 600000 / GSPEED, DEAL: Number(process.env.CLAUDE_TRAFFIC_LIGHT_DEAL_MS || 40000 / GSPEED), POTS: 12, WEED_ONE_IN: Number(process.env.CLAUDE_TRAFFIC_LIGHT_WEED_ONE_IN || 30) };

function gardenGeometry() {
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const floorY = wa.y + wa.height - b.height;
  const homeX = Math.round(wa.x + wa.width * 0.5 - b.width / 2);
  // 3 rows × 4 columns, jittered, keeping clear of the very top (menu bar) and
  // leaving each row enough height for the widget to stand at the pot.
  const cols = 4, rows = 3;
  const pots = [];
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
    const x = Math.round(wa.x + wa.width * ((c + 0.5) / cols) + (Math.random() - 0.5) * wa.width * 0.12);
    const y = Math.round(wa.y + b.height + 40 + (wa.height - b.height - 80) * ((r + 0.7) / rows) + (Math.random() - 0.5) * 40);
    pots.push({ x, y });
  }
  return { display, wa, floorY, homeX, potPos: pots.sort(() => Math.random() - 0.5), width: b.width, height: b.height };
}

async function moveWidget(x, y, ms) {
  if (!win || win.isDestroyed()) return;
  const from = win.getBounds();
  await tween({ x: from.x, y: from.y }, { x: Math.round(x), y: Math.round(y) }, Math.max(1, ms), (pt) => { try { if (win && !win.isDestroyed()) win.setPosition(pt.x, pt.y); } catch { /* window gone */ } });
}

function gardenAct(act, extra = {}) {
  const base = gardenRun.base;
  const poseActs = new Set(['thumbs']);
  travelLook = { ...base, pose: poseActs.has(act) ? act : 'none', effect: 'none', gardenAct: poseActs.has(act) ? null : act, name: gardenRun.label, ...extra };
  win?.webContents.send('status-changed');
}

function overlayGarden(payload) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const ob = overlayWin.getBounds();
  overlayWin.webContents.send('garden', { ...payload, ox: ob.x, oy: ob.y });
}

async function runGarden(base) {
  console.log('[garden] start');
  const geo = gardenGeometry();
  gardenRun = { base, home: win.getBounds(), pots: [], firstBite: null, lastBite: 0, rotations: 0, stop: false, label: 'Gardening', geo, planted: 0 };
  const run = gardenRun;
  const alive = () => gardenRun === run && !run.stop;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const standAt = (pot) => ({ x: pot.x - Math.round(geo.width * 0.75), y: pot.y - geo.height + 14 });   // stand left of the pot, feet at its base
  const facingTo = (x) => (x < win.getBounds().x + geo.width / 2 ? 'left' : 'right');
  try {
    if (!overlayWin) { updateOverlay({ pose: 'none', screenFx: 'garden' }); await wait(700); }
    overlayGarden({ op: 'start', wa: geo.wa });
    // ── fetch pots from the screen edges
    const perFetch = GT.FETCH / GT.POTS;
    for (let i = 0; i < GT.POTS && alive(); i += 1) {
      const pos = geo.potPos[i];
      const edge = i % 2 ? { x: geo.wa.x - geo.width + 12, y: pos.y - geo.height + 14 } : { x: geo.wa.x + geo.wa.width - 12, y: pos.y - geo.height + 14 };
      gardenAct('walking', { facing: facingTo(edge.x) });
      await moveWidget(edge.x, edge.y, perFetch * 0.4);
      if (!alive()) break;
      const stand = standAt(pos);
      gardenAct('carrying', { facing: facingTo(stand.x) });
      await moveWidget(stand.x, stand.y, perFetch * 0.45);
      if (!alive()) break;
      run.pots.push({ x: pos.x, y: pos.y, crop: null, grownAt: null, bites: 0 });
      overlayGarden({ op: 'pot', x: pos.x, y: pos.y });
      gardenAct('walking', { facing: 'right' });
      await wait(perFetch * 0.15);
    }
    // ── plant each pot
    const perPlant = GT.PLANT / GT.POTS;
    for (let i = 0; i < run.pots.length && alive(); i += 1) {
      const pot = run.pots[i];
      const stand = standAt(pot);
      gardenAct('walking', { facing: facingTo(stand.x) });
      await moveWidget(stand.x, stand.y, perPlant * 0.15);
      if (!alive()) break;
      gardenAct('pouring', { facing: 'right' });
      await wait(perPlant * 0.35);
      overlayGarden({ op: 'dirt', i });
      overlayGarden({ op: 'seed', i });
      await wait(perPlant * 0.1);
      gardenAct('watering', { facing: 'right' });
      await wait(perPlant * 0.3);
      overlayGarden({ op: 'water', i });
      await wait(perPlant * 0.1);
    }
    // ── grow, eat, dry & deal, rotate
    const CROPS = ['carrot', 'tomato', 'berries', 'sunflower', 'apple', 'flowers'];
    const pick = () => { run.planted += 1; return run.planted % GT.WEED_ONE_IN === 0 || Math.random() < 1 / GT.WEED_ONE_IN ? 'weed' : CROPS[Math.floor(Math.random() * CROPS.length)]; };
    const sow = () => { const now = Date.now(); run.pots.forEach((pot, i) => { pot.crop = pick(); pot.grownAt = now + GT.GROW; pot.bites = 3; pot.state = 'growing'; overlayGarden({ op: 'sow', i, crop: pot.crop, growMs: GT.GROW }); }); };
    sow();
    gardenAct('walking', { facing: facingTo(geo.homeX) });
    await moveWidget(geo.homeX, geo.floorY, 3000);
    gardenAct(null);
    while (alive()) {
      await wait(1000);
      if (!alive()) break;
      const now = Date.now();
      // weed: harvest → dry 10 min → a buyer comes
      const weed = run.pots.find((p) => p.crop === 'weed' && now >= p.grownAt && p.state === 'growing');
      if (weed) {
        const i = run.pots.indexOf(weed);
        const stand = standAt(weed);
        gardenAct('walking', { facing: facingTo(stand.x) });
        await moveWidget(stand.x, stand.y, 2500);
        if (!alive()) break;
        gardenAct('carrying', { facing: 'right' });
        weed.state = 'drying'; weed.dryAt = Date.now() + GT.DRY;
        overlayGarden({ op: 'harvest', i, dryMs: GT.DRY });
        await wait(2500);
        gardenAct(null);
        continue;
      }
      const dried = run.pots.find((p) => p.state === 'drying' && now >= p.dryAt);
      if (dried) {
        const i = run.pots.indexOf(dried);
        const stand = standAt(dried);
        dried.state = 'dealing';
        gardenAct('walking', { facing: facingTo(stand.x) });
        await moveWidget(stand.x, stand.y, 2500);
        if (!alive()) break;
        gardenAct(null, { facing: 'right' });
        overlayGarden({ op: 'deal', i, ms: GT.DEAL, claude: { x: win.getBounds().x, y: win.getBounds().y, w: geo.width, h: geo.height } });
        await wait(GT.DEAL);
        if (!alive()) break;
        gardenAct('thumbs');
        await wait(1500);
        gardenAct(null);
        dried.crop = null; dried.state = 'empty';
        overlayGarden({ op: 'clearpot', i });
        continue;
      }
      const ready = run.pots.filter((p) => p.crop && p.crop !== 'flowers' && p.crop !== 'weed' && now >= p.grownAt && p.bites > 0);
      if (ready.length && now - run.lastBite >= GT.EAT_EVERY) {
        run.lastBite = now;
        if (run.firstBite == null) run.firstBite = now;
        const pot = ready[Math.floor(Math.random() * ready.length)];
        const idx = run.pots.indexOf(pot);
        const stand = standAt(pot);
        gardenAct('walking', { facing: facingTo(stand.x) });
        await moveWidget(stand.x, stand.y, 2500);
        if (!alive()) break;
        gardenAct('eating', { facing: 'right' });
        overlayGarden({ op: 'bite', i: idx });
        pot.bites -= 1;
        await wait(1400);
        gardenAct(null);
      }
      if (run.firstBite != null && now - run.firstBite >= GT.ROTATE * (run.rotations + 1)) {
        run.rotations += 1;
        overlayGarden({ op: 'pull' });
        await wait(1500);
        sow();
      }
    }
  } catch (e) {
    console.log('[garden] error', e.stack || e.message);
  } finally {
    console.log('[garden] end', JSON.stringify({ stop: run.stop, same: gardenRun === run }));
    if (gardenRun === run) {
      overlayGarden({ op: 'clear' });
      travelLook = null;
      const home = run.home;
      await moveWidget(home.x, home.y, 1500).catch(() => {});
      gardenRun = null;
      broadcastStatus();
    }
  }
}

function updateGarden(st) {
  const wants = st.look.effect === 'garden' && win && win.isVisible() && st.reason !== 'preview';
  if (wants && !gardenRun && !roamState.busy) {
    runGarden(st.look).catch((e) => console.log('[garden]', e.message));
  } else if (!wants && gardenRun && !gardenRun.stop && st.reason !== 'travel') {
    console.log('[garden] stopping: reason', st.reason, 'effect', st.look.effect, 'visible', win?.isVisible());
    gardenRun.stop = true;
  }
}

function broadcastStatus() {
  win?.webContents.send('status-changed');
  lightsWin?.webContents.send('status-changed');
  try {
    const st = aggregateState();
    updateOverlay(st.look);
    applyStrip(!!(st.pending && st.pending.length) && !travelLook);
    updateGarden(st);
    maybeRoam(st);
    maybeRandomEvent(st);
  } catch (e) { console.log('[status]', e.message); }
}

// ── Roaming: walk to the terminal's Dock icon and knock ────────────────────
// When something needs you and the terminal isn't the front app, Claude runs
// along the screen to that app's Dock icon, knocks, and runs home. Once per
// waiting episode, then every 10 minutes while still ignored.
let roamState = { lastKnock: 0, waitingSince: null, busy: false, home: null };

function osa(script) {
  return new Promise((resolve) => execFile('osascript', ['-e', script], (err, out) => resolve(err ? null : out.trim())));
}

async function frontmostApp() {
  return osa('tell application "System Events" to get name of first application process whose frontmost is true');
}

async function dockIconRect(appName) {
  const out = await osa(`tell application "System Events" to tell process "Dock" to get {position, size} of UI element "${appName}" of list 1`);
  if (!out) return null;
  const n = out.split(',').map((x) => Number(x.trim()));
  if (n.length < 4 || n.some(Number.isNaN)) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

async function runningTerminal() {
  const names = await osa('tell application "System Events" to get name of every process');
  if (!names) return null;
  const set = new Set(names.split(',').map((x) => x.trim()));
  return TERMINAL_APPS.find((t) => set.has(t)) || null;
}

function tween(from, to, ms, onStep) {
  const nums = [from?.x, from?.y, to?.x, to?.y, ms];
  if (!nums.every(Number.isFinite)) { console.log('[tween] skipped, non-finite input', JSON.stringify({ from, to, ms })); return Promise.resolve(); }
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / ms);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      onStep({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e) });
      if (p >= 1) { clearInterval(id); resolve(); }
    }, 16);
  });
}

async function maybeRoam(st) {
  const config = loadConfig();
  if (!IS_MAC || !config.roam || !win || !win.isVisible() || roamState.busy || previewLook || gardenRun) return;
  const waiting = st.pending?.length || st.sessions.some((s) => WAITING_SIGNALS.has(s.signal));
  if (!waiting) { roamState.waitingSince = null; return; }
  if (!roamState.waitingSince) roamState.waitingSince = Date.now();
  const due = roamState.lastKnock === 0 || Date.now() - roamState.lastKnock > 10 * 60 * 1000;
  if (!due) return;
  const app = await runningTerminal();
  if (!app) return;
  if ((await frontmostApp()) === app) return; // they're looking at it already
  const icon = await dockIconRect(app);
  if (!icon) return;
  roamState.busy = true;
  roamState.lastKnock = Date.now();
  const home = win.getBounds();
  roamState.home = home;
  const base = st.look;
  const target = { x: Math.round(icon.x + icon.w / 2 - home.width / 2), y: Math.round(icon.y - home.height + 6) };
  const facing = target.x < home.x ? 'left' : 'right';
  try {
    travelLook = { ...base, pose: 'run', facing, aimAngle: 0, name: `Running to ${app}` };
    broadcastStatus();
    await tween({ x: home.x, y: home.y }, target, 1400, (pt) => win?.setPosition(pt.x, pt.y));
    travelLook = { ...base, pose: 'knock', facing: 'right', text: 'KNOCK KNOCK', name: `Knocking on ${app}` };
    broadcastStatus();
    await new Promise((r) => setTimeout(r, 2400));
    travelLook = { ...base, pose: 'run', facing: facing === 'left' ? 'right' : 'left', aimAngle: 0, name: 'Running home' };
    broadcastStatus();
    await tween(target, { x: home.x, y: home.y }, 1400, (pt) => win?.setPosition(pt.x, pt.y));
  } finally {
    travelLook = null;
    win?.setBounds(home);
    roamState.busy = false;
    broadcastStatus();
  }
}

// ── Rare events ────────────────────────────────────────────────────────────
// A UFO, a portal or a meteor: about once per 45 minutes of working time at
// random, plus on milestones (10th, 50th, 100th, 500th session seen).
const seenSessions = new Set();
let lastEventAt = 0;
function maybeRandomEvent(st) {
  const config = loadConfig();
  if (!config.randomEvents || !win || !win.isVisible() || previewLook || travelLook) return;
  let milestone = false;
  for (const s of st.sessions) {
    if (!seenSessions.has(s.sessionId)) {
      seenSessions.add(s.sessionId);
      stats.sessionsSeen = (stats.sessionsSeen || 0) + 1;
      statsDirty = true;
      if ([10, 50, 100, 500, 1000].includes(stats.sessionsSeen)) milestone = true;
    }
  }
  const working = st.look.lamp === 'green' && !['ak47', 'sniper'].includes(st.look.pose);
  const chance = working ? 4 / (45 * 60) : 0;
  if (!milestone && (Date.now() - lastEventAt < 5 * 60 * 1000 || Math.random() > chance)) return;
  lastEventAt = Date.now();
  const names = ['ufo', 'portal', 'meteor'];
  win.webContents.send('event', milestone ? 'ufo' : names[Math.floor(Math.random() * names.length)]);
}

function createTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  const trayIconPath = path.join(__dirname, 'assets', IS_WIN ? 'tray-win.png' : 'trayTemplate.png');
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
    { label: 'Show Widget Now', click: () => { saveConfig({ showWidget: true }); clearTimeout(snoozeTimer); if (!win) createWindow(); win.showInactive(); createTray(); } },
    { label: 'Reset Widget Position', click: () => { const wa = screen.getPrimaryDisplay().workArea; if (!win) createWindow(); win.setBounds({ x: wa.x + wa.width - 140, y: wa.y + 46, width: 107, height: 137 }); win.showInactive(); } },
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
  tray.setToolTip('Claude Buddy');
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
ipcMain.handle('go-to-needing-session', async () => {
  const { sessions } = aggregateState();
  const needing = sessions
    .filter((s) => WAITING_SIGNALS.has(s.signal))
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  if (needing.length === 0) {
    cycleIndex = 0;
    return { opened: 'none', total: 0 };
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
  const before = loadConfig().askFromWidget;
  const next = saveConfig(partial);
  if ('askFromWidget' in partial && !!partial.askFromWidget !== !!before) installHooks();
  if ('showWidget' in partial) applyWidgetVisibility();
  if ('menuBarMode' in partial || 'showWidget' in partial) createTray();
  broadcastStatus();
  return next;
});

ipcMain.handle('get-stats', () => Stats.summary(stats));

// ── Costs, from ccusage (the same source as the user's cost alerts) ────────
let costCache = { at: 0, data: null };
function runCcusage(args) {
  return new Promise((resolve) => {
    execFile('ccusage', [...args, '--json', '--offline'], { env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` }, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}
async function getCosts() {
  if (Date.now() - costCache.at < 60000 && costCache.data) return costCache.data;
  const since = new Date(Date.now() - 6 * 86400000);
  const ymd = `${since.getFullYear()}${String(since.getMonth() + 1).padStart(2, '0')}${String(since.getDate()).padStart(2, '0')}`;
  const [daily, session] = await Promise.all([runCcusage(['daily', '--since', ymd]), runCcusage(['session', '--since', ymd])]);
  if (!daily && !session) { costCache = { at: Date.now(), data: { available: false } }; return costCache.data; }
  const days = {};
  for (const d of daily?.daily || []) days[d.period] = { cost: d.totalCost || 0, tokens: d.totalTokens || 0, models: (d.modelsUsed || []).map((m) => String(m).replace(/^claude-/, '')) };
  // Map ccusage sessions (keyed by session id) to project folders through
  // our own session files, which know each session's cwd.
  const cwdById = {};
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      try { const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); if (j.sessionId && j.cwd) cwdById[j.sessionId] = j.cwd; } catch { /* skip */ }
    }
  } catch { /* none */ }
  // Finished sessions have no session file any more; their transcript
  // (~/.claude/projects/<dir>/<id>.jsonl) records the cwd on its first lines.
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let transcriptDirs = [];
  try { transcriptDirs = fs.readdirSync(projectsRoot).map((d) => path.join(projectsRoot, d)); } catch { /* none */ }
  const cwdFromTranscript = (id) => {
    if (cwdById[id]) return cwdById[id];
    for (const dir of transcriptDirs) {
      const f = path.join(dir, `${id}.jsonl`);
      if (!fs.existsSync(f)) continue;
      try {
        const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd);
        const m = /"cwd":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
        cwdById[id] = m ? m[1] : null;
        return cwdById[id];
      } catch { return null; }
    }
    return null;
  };
  const projects = {};
  const sessions = [];
  for (const sname of session?.session || []) {
    const id = sname.period;
    const cwd = cwdFromTranscript(id) || (sname.metadata && (sname.metadata.projectPath || sname.metadata.cwd)) || null;
    const project = cwd ? String(cwd).split('/').filter(Boolean).pop() : (sname.metadata?.project || 'other');
    projects[project] = (projects[project] || 0) + (sname.totalCost || 0);
    sessions.push({ id, project, cost: sname.totalCost || 0 });
  }
  const data = { available: true, days, totals: daily?.totals || null, projects: Object.entries(projects).sort((a, b) => b[1] - a[1]).map(([name, cost]) => ({ name, cost })), sessions: sessions.sort((a, b) => b.cost - a.cost).slice(0, 8) };
  costCache = { at: Date.now(), data };
  return data;
}
ipcMain.handle('get-costs', () => getCosts());

// ── Gestures on the avatar → the action the current state programmed ──────
let snoozeTimer = null;
let cycleIndex = 0;
async function runAction(action, st) {
  const needing = st.sessions.filter((s) => WAITING_SIGNALS.has(s.signal)).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  const target = needing[0] || st.sessions[0] || null;
  const cwd = target?.cwd || null;
  const folderHint = cwd ? cwd.split('/').filter(Boolean).pop() : '';
  switch (action.type) {
    case 'jump': {
      if (!needing.length) return { react: { eyes: 'surprised', pose: 'bounce' }, feedback: 'boop' };
      const r = await jumpToNeeding();
      return { feedback: r };
    }
    case 'terminal': {
      const a = await activateTerminalApp(folderHint);
      return { feedback: a ? `→ ${a.app}` : 'no terminal running' };
    }
    case 'allow': case 'deny': {
      const req = st.pending && st.pending[0];
      if (!req) return { feedback: 'nothing to answer' };
      answerRequest(req.id, action.type);
      setTimeout(broadcastStatus, 250);
      return { feedback: action.type === 'allow' ? 'allowed' : 'denied' };
    }
    case 'poke': return { react: { eyes: 'surprised', pose: 'bounce' }, feedback: 'boop' };
    case 'pet': return { react: { eyes: 'heart', pose: 'nod' }, ms: 2000, feedback: 'purr' };
    case 'feed': return { react: { pose: 'munch', eyes: 'happy' }, ms: 1800, feedback: 'nom' };
    case 'lights': createLightsWindow(); return { feedback: 'Lights' };
    case 'stats': createLightsWindow(); lightsWin?.webContents.once('did-finish-load', () => lightsWin?.webContents.send('show-view', 'stats')); lightsWin?.webContents.send('show-view', 'stats'); return { feedback: 'Stats' };
    case 'finder': if (!cwd) return { feedback: 'no session folder' }; shell.openPath(cwd); return { feedback: `${IS_WIN ? 'Explorer' : 'Finder'} → ${folderHint}` };
    case 'editor': {
      if (!cwd) return { feedback: 'no session folder' };
      if (IS_WIN) execFile('cmd', ['/c', 'start', '', action.arg || 'code', cwd], () => {});
      else execFile('open', ['-a', action.arg || 'Visual Studio Code', cwd], () => {});
      return { feedback: `${action.arg || 'Visual Studio Code'} → ${folderHint}` };
    }
    case 'copy-path': if (!cwd) return { feedback: 'no session folder' }; clipboard.writeText(cwd); return { feedback: 'path copied' };
    case 'url': if (!/^https?:\/\//i.test(action.arg || '')) return { feedback: 'no URL set' }; shell.openExternal(action.arg); return { feedback: 'opened' };
    case 'shell': {
      if (!action.arg) return { feedback: 'no command set' };
      // The user's own command, run in their shell; the session folder is CLAUDE_CWD.
      if (IS_WIN) execFile('powershell', ['-NoProfile', '-c', action.arg], { env: { ...process.env, CLAUDE_CWD: cwd || '' } }, () => {});
      else execFile('/bin/zsh', ['-lc', action.arg], { env: { ...process.env, CLAUDE_CWD: cwd || '' } }, () => {});
      return { feedback: 'ran' };
    }
    case 'shortcut': if (IS_WIN) return { feedback: 'Shortcuts are macOS only' }; if (!action.arg) return { feedback: 'no shortcut set' }; execFile('shortcuts', ['run', action.arg], () => {}); return { feedback: `Shortcut: ${action.arg}` };
    case 'say': speak(action.arg || (target ? `${folderHint} needs you` : 'hello')); return { react: { pose: 'bubble' }, ms: 1500, feedback: 'said' };
    case 'snooze': {
      win?.hide();
      clearTimeout(snoozeTimer);
      snoozeTimer = setTimeout(() => { if (loadConfig().showWidget) win?.showInactive(); }, 30 * 60 * 1000);
      return { feedback: 'back in 30 min' };
    }
    default: return { feedback: '' };
  }
}

async function jumpToNeeding() {
  const { sessions } = aggregateState();
  const needing = sessions.filter((s) => WAITING_SIGNALS.has(s.signal)).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  if (!needing.length) return 'nothing waiting';
  const limits = needing.filter((s) => s.signal === 'limit-hit');
  const queue = limits.length > 0 ? limits : needing;
  cycleIndex = cycleIndex % queue.length;
  const target = queue[cycleIndex];
  const shownIndex = cycleIndex + 1;
  cycleIndex += 1;
  clipboard.writeText(target.cwd);
  const folderHint = target.cwd.split('/').filter(Boolean).pop() || '';
  const activated = await activateTerminalApp(folderHint);
  const badge = queue.length > 1 ? ` (${shownIndex}/${queue.length})` : '';
  return `→ ${folderHint}${badge}${activated?.exact ? ' · tab found' : ''} · path copied`;
}

ipcMain.handle('gesture', async (e, gesture) => {
  const st = aggregateState();
  if (st.reason === 'travel') return { feedback: '' };
  const action = (st.look.clicks && st.look.clicks[gesture]) || Rules.DEFAULT_CLICKS[gesture];
  if (!action) return { feedback: '' };
  try { return await runAction(action, st); } catch (err) { return { feedback: err.message }; }
});

ipcMain.handle('answer-request', (e, id, decision) => {
  const ok = answerRequest(String(id), String(decision));
  setTimeout(broadcastStatus, 250);
  return ok;
});

// The widget grows a strip of Allow / Deny buttons while a request waits.
const STRIP_PX = 46;
let stripShown = false;
function applyStrip(show) {
  if (!win || show === stripShown) return;
  stripShown = show;
  const b = win.getBounds();
  win.setAspectRatio(0);
  win.setBounds({ ...b, height: b.height + (show ? STRIP_PX : -STRIP_PX) });
  if (!show) win.setAspectRatio(WIDGET_ASPECT);
}

ipcMain.handle('preview-sound', (e, name) => playSound(name));

ipcMain.handle('export-rules', async (e, rules) => {
  const r = await dialog.showSaveDialog(lightsWin || undefined, { title: 'Export rules', defaultPath: path.join(app.getPath('documents'), 'claude-traffic-light-rules.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify({ v: 1, app: 'claude-traffic-light', rules: (rules || []).map(Rules.normalizeRule) }, null, 2));
  return r.filePath;
});

ipcMain.handle('import-rules', async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, { title: 'Import rules', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const rules = Array.isArray(parsed) ? parsed : parsed.rules;
    if (!Array.isArray(rules)) return { error: 'No rules in that file' };
    return { rules: rules.map(Rules.normalizeRule) };
  } catch (err) { return { error: `Could not read: ${err.message}` }; }
});

// Connect other agents: writes their hook config files.
ipcMain.handle('connect-agent', (e, which) => {
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const home = os.homedir();
  if (which === 'cursor') {
    const f = path.join(home, '.cursor', 'hooks.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(Hooks.installCursor(readJson(f), EMIT_SCRIPT), null, 2));
    return { ok: true, file: f };
  }
  if (which === 'codex') {
    const f = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* none */ }
    fs.writeFileSync(f, Hooks.installCodex(cur, EMIT_SCRIPT));
    return { ok: true, file: f };
  }
  if (which === 'gemini') {
    const f = path.join(home, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(Hooks.installGemini(readJson(f), EMIT_SCRIPT), null, 2));
    return { ok: true, file: f };
  }
  return { ok: false };
});
ipcMain.handle('signal-endpoint', () => ({ port: SIGNAL_PORT, emit: EMIT_SCRIPT }));

ipcMain.handle('choose-sound-file', async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, {
    title: 'Choose a sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['aiff', 'aif', 'wav', 'mp3', 'm4a', 'caf'] }],
  });
  return r.canceled || !r.filePaths[0] ? null : `file:${r.filePaths[0]}`;
});

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
  if (config.soundOnAmber && key && key !== lastSoundKey) playSound(look.sound);
  lastSoundKey = key;
}

// Dev captures (--shot, --playtest) and demos run beside the installed app,
// so they take their own userData (and therefore their own instance lock).
if (process.argv.includes('--shot') || process.argv.includes('--playtest') || process.argv.includes('--demo')) {
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
  startSignalServer();
  if (DEMO === 'weed') {
    // pots ×12 fetch+plant ≈ 25 s, grow 10 s, harvest ≈ 60 s, dry 25 s, deals 30 s each
    setTimeout(() => app.quit(), 8 * 60 * 1000);
  }
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

  setInterval(() => {
    if (!areHooksInstalled()) installHooks();
  }, 10 * 60 * 1000);
});

// Quitting must not be vetoed by the editor's unsaved-changes prompt.
app.on('before-quit', () => { flushStats(); lightsWin?.destroy(); settingsWin?.destroy(); });

app.on('activate', () => { if (!lightsWin && !settingsWin) win?.showInactive(); });

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
