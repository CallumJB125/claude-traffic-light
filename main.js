const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen, clipboard, systemPreferences, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const Rules = require('./rules.js');
const Hooks = require('./hooks/install.js');
const Stats = require('./stats.js');
const Usage = require('./usage.js');
// electron-builder drops a file from the asar when it is also an extraResource,
// and router.js must be an extraResource so plain node can run it for the shim.
const Router = require(fs.existsSync(path.join(__dirname, 'router.js')) ? './router.js' : path.join(process.resourcesPath, 'router.js'));
const RouterInstall = require('./router-install.js');
const DelegationInstall = require('./delegation-install.js');
const Delegate = require('./hooks/delegate.js');
const Agents = require('./agents.js');
const HostApp = require('./hostapp.js');
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
// `--demo agents`: a fake session running a ralph loop on iteration 7 with
// five other agents attached, so the chips, the roster and the ralph number
// can be seen without waiting for a real swarm.
if (DEMO === 'agents') {
  process.env.CLAUDE_TRAFFIC_LIGHT_HOME = path.join(os.tmpdir(), 'claude-traffic-light-demo-agents');
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT = '47181';
  fs.rmSync(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, 'config.json'), JSON.stringify({ rules: Rules.defaultRules(), roam: false, randomEvents: false, seasonal: false, showTasks: false, showAgents: true, agentRoster: true, agentKinds: { subagent: true, teammate: true, ralph: true, ultrawork: true }, agentChipSize: 'normal' }));
  const since = new Date().toISOString();
  const agent = (id, name, kind, status) => ({ id, name, kind, status, since, parent: 'demo' });
  writeJsonAtomic(path.join(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions', 'demo-agents.json'), {
    sessionId: 'demo', host: 'demo', cwd: '/demo/claude-buddy', signal: 'tool-use', tool: 'Agent',
    workingSince: since, tasks: { created: 0, done: 0 }, mode: 'ralph', iteration: 7,
    agents: [
      agent('a1', 'executor', 'subagent', 'working'),
      agent('a2', 'explore', 'subagent', 'working'),
      agent('a3', 'reliability', 'teammate', 'waiting'),
      agent('a4', 'stats', 'teammate', 'working'),
      agent('a5', 'verifier', 'ralph', 'done'),
    ],
    updatedAt: since,
  });
}

// `--demo knock`: walk to the terminal's Dock icon and knock, once, then quit.
if (DEMO === 'knock') {
  // Must NOT be the same directory as the demo's Chromium userData
  // (claude-buddy-demo-knock) — sharing it wedges the app before `ready`.
  process.env.CLAUDE_TRAFFIC_LIGHT_HOME = path.join(os.tmpdir(), 'claude-buddy-knock-home');
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT = '47181';
  fs.rmSync(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(process.env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions'), { recursive: true });
}

// `--diag`: once a second, print CPU, heap, live timer and window counts to
// stdout. Used to measure the app's idle cost before/after a change.
const DIAG = process.argv.includes('--diag');
// Dev runs (shots, playtests, demos) must never touch the real install: no
// hook writes, no login item, no stale lock left behind.
const IS_DEV_RUN = !!DEMO || process.argv.includes('--shot') || process.argv.includes('--playtest') || process.argv.includes('--lights');

// Every interval/timeout the app owns goes through these so --diag can count
// them and so nothing can leak a live timer on shutdown.
const liveTimers = new Set();
function every(ms, fn, label) {
  const id = setInterval(fn, ms);
  id.__label = label || 'interval';
  liveTimers.add(id);
  return id;
}
function stopTimer(id) {
  if (!id) return null;
  clearInterval(id);
  liveTimers.delete(id);
  return null;
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

// `preferApp`: the app the session's hook recorded (hostApp), tried first.
function activateTerminalApp(folderHint, preferApp = null) {
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
    const candidates = preferApp ? [preferApp, ...TERMINAL_APPS.filter((n) => n !== preferApp)] : TERMINAL_APPS;
    const script = `
      tell application "System Events"
        set names to name of every process
      end tell
      set targetApp to ""
      repeat with candidate in {${candidates.map((n) => `"${escapeForAppleScript(n)}"`).join(', ')}}
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

// Errors otherwise vanish: a packaged app has no visible terminal, so a
// crash left zero evidence. Tee console output to a small rotating file
// instead — capped so a busy session can't grow it unbounded.
if (!IS_DEV_RUN) {
  const LOG_FILE = path.join(ROOT_DIR, 'app.log');
  const LOG_MAX_BYTES = 512 * 1024;
  try { fs.mkdirSync(ROOT_DIR, { recursive: true }); } catch { /* already there */ }
  for (const method of ['log', 'warn', 'error']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      orig(...args);
      try {
        const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
        if (stat && stat.size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
        const line = `${new Date().toISOString()} [${method}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
        fs.appendFileSync(LOG_FILE, line);
      } catch { /* logging must never be why the app breaks */ }
    };
  }
}

const DEFAULT_CONFIG = {
  workingStaleMinutes: 6,
  waitingStaleHours: 4,
  soundOnAmber: true,
  showWidget: true,
  menuBarMode: false,
  seasonal: true,
  askFromWidget: false,
  showTasks: true,
  showAgents: true,
  agentRoster: true,
  agentKinds: { subagent: true, teammate: true, ralph: true, ultrawork: true },
  agentChipSize: 'normal',
  roam: true,
  randomEvents: true,
  // Best guess at who pays per token: no API key in the environment usually
  // means a subscription, where "% of your usage" reads better than dollars.
  routerSubscriberView: !process.env.ANTHROPIC_API_KEY,
  routerPolicy: 'balanced',
  routerProjects: {},
  // Mirrored to router/delegation.json, which is all hooks/delegate.js reads.
  routerDelegation: { ...Delegate.DEFAULTS },
};
const REQUESTS_DIR = path.join(ROOT_DIR, 'requests');
const STATS_FILE = path.join(ROOT_DIR, 'stats.json');

// loadConfig() is called several times per status broadcast (and a broadcast
// happens on every session-file write), so the parsed config is cached and
// only rebuilt when the file's mtime/size actually change.
let configCache = { key: null, value: null };
function loadConfig() {
  let stat = null;
  try { stat = fs.statSync(CONFIG_FILE); } catch { /* no config yet */ }
  const key = stat ? `${stat.mtimeMs}:${stat.size}` : 'none';
  if (configCache.value && configCache.key === key) return configCache.value;
  const value = buildConfig();
  configCache = { key, value };
  return value;
}

function buildConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // no config yet
  }
  const config = { ...DEFAULT_CONFIG, ...saved };
  config.agentKinds = { ...DEFAULT_CONFIG.agentKinds, ...(saved.agentKinds && typeof saved.agentKinds === 'object' ? saved.agentKinds : {}) };
  config.routerDelegation = Delegate.normalize({ ...DEFAULT_CONFIG.routerDelegation, ...(saved.routerDelegation && typeof saved.routerDelegation === 'object' ? saved.routerDelegation : {}) });
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
  configCache = { key: null, value: null }; // two writes inside one ms would share an mtime
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
// The shim runs router.js with plain node, which can't read inside app.asar,
// so the packaged copy is an extraResource like hooks/.
const ROUTER_SCRIPT = app.isPackaged ? path.join(process.resourcesPath, 'router.js') : path.join(__dirname, 'router.js');
// Dev runs never touch the real shell rc: switching routing on from one
// installs into a sandbox HOME instead.
const ROUTER_HOME = process.env.CLAUDE_TRAFFIC_LIGHT_ROUTER_HOME || (IS_DEV_RUN ? path.join(os.tmpdir(), 'claude-buddy-router-dev-home') : os.homedir());
const ROUTER_SANDBOXED = ROUTER_HOME !== os.homedir();
const ROUTER_ROOT = ROUTER_SANDBOXED ? path.join(ROUTER_HOME, '.claude-traffic-light') : ROOT_DIR;
function routerOpts() {
  return {
    home: ROUTER_HOME,
    root: ROUTER_ROOT,
    // A Finder-launched app may have no $SHELL; the passwd entry always does.
    shellPath: process.env.SHELL || os.userInfo().shell,
    env: ROUTER_SANDBOXED ? {} : process.env,
    routerScript: ROUTER_SCRIPT,
    electron: process.execPath,
    configPath: CONFIG_FILE,
  };
}
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
      const workingSince = d.signal === 'prompt-submit' ? now : Rules.TURN_END.has(d.signal) ? null : (prev?.workingSince || now);
      // A bare signal must not wipe what the agent poller and hooks stored.
      const keep = (key, ok) => (d[key] !== undefined && ok(d[key]) ? d[key] : prev?.[key]);
      writeJsonAtomic(file, {
        sessionId: session, host: os.hostname().split('.')[0], source,
        hostApp: keep('hostApp', (v) => typeof v === 'string'),
        cwd: typeof d.cwd === 'string' ? d.cwd.slice(0, 500) : '', signal: d.signal, tool: typeof d.tool === 'string' ? d.tool.slice(0, 80) : null, workingSince,
        tasks: keep('tasks', (v) => !!v && typeof v === 'object') || { created: 0, done: 0 },
        agents: keep('agents', Array.isArray),
        mode: keep('mode', (v) => typeof v === 'string'),
        iteration: keep('iteration', Number.isFinite),
        agentsAt: prev?.agentsAt,
        updatedAt: now,
      });
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
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
  } catch {
    return null;
  }
  // Bounds saved while a different (e.g. larger external) display was
  // connected can sit entirely outside every current display's work area,
  // making the widget invisible with no way to reach it. Clamp back on.
  const margin = 20;
  const onAnyDisplay = screen.getAllDisplays().some(({ workArea: wa }) => (
    saved.x + saved.width > wa.x + margin &&
    saved.x < wa.x + wa.width - margin &&
    saved.y + saved.height > wa.y + margin &&
    saved.y < wa.y + wa.height - margin
  ));
  if (onAnyDisplay) return saved;
  const wa = screen.getPrimaryDisplay().workArea;
  return { ...saved, x: wa.x + wa.width - saved.width - 40, y: wa.y + 80 };
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
// A busy turn rewrites its session file several times a second, and each
// write wakes a broadcast; re-reading and re-parsing every file every time is
// what made the app crawl with a few sessions open. Parsed files are cached by
// mtime+size, so a poll over unchanged files costs one stat each.
const sessionFileCache = new Map(); // name -> { key, data }
function readSessionFile(name) {
  const full = path.join(SESSIONS_DIR, name);
  let stat;
  try { stat = fs.statSync(full); } catch { sessionFileCache.delete(name); return null; }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = sessionFileCache.get(name);
  if (hit && hit.key === key) return hit.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { data = null; } // partial write
  sessionFileCache.set(name, { key, data });
  return data;
}

// Session files are rewritten by hooks and by the app at once; writing a temp
// file and renaming it over means no reader ever sees half a file. With
// `unchangedSince` (an mtimeMs), the rename is skipped if someone else wrote
// the file after we read it — their write is newer than our merge. The temp
// name carries the pid so it can't collide with a hook's own temp file.
function writeJsonAtomic(file, obj, unchangedSince = null) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (unchangedSince != null && fs.statSync(file).mtimeMs !== unchangedSince) {
      fs.rmSync(tmp, { force: true });
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}

// A finished turn whose subagents are still working stays live for as long as
// they plausibly are: a long agent can go quiet for well over the working
// window without having died.
const AGENT_KEEPALIVE_MS = 6 * 60 * 60 * 1000;
// Agent bookkeeping writes stamp `agentsAt`, not `updatedAt`, so it counts
// as activity here.
function workingAgentsStale(data, now, workingStaleMs) {
  let last = Math.max(Date.parse(data.updatedAt || '') || 0, Date.parse(data.agentsAt || '') || 0);
  let young = false;
  (Array.isArray(data.agents) ? data.agents : []).forEach((a, i) => {
    const n = Rules.normalizeAgent(a, i);
    if (!n || n.status !== 'working') return;
    const since = Date.parse(n.since || '') || 0;
    last = Math.max(last, since);
    if (since && now - since < AGENT_KEEPALIVE_MS) young = true;
  });
  return !young && now - last > workingStaleMs;
}

// Every change in what a session presents is logged, so a flicker report can
// be read off app.log. At most one line per session per TRANSITION_LOG_MS.
const TRANSITION_LOG_MS = 250;
const lastPresented = new Map(); // sessionId -> { signal, loggedAt, skipped }
function logTransition(data, signal, source, now) {
  const sid = String(data.sessionId || '?');
  const last = lastPresented.get(sid);
  if (last && last.signal === signal) return;
  const entry = { signal, loggedAt: last ? last.loggedAt : 0, skipped: last ? last.skipped : 0 };
  if (now - entry.loggedAt >= TRANSITION_LOG_MS) {
    const tail = String(data.cwd || '').split('/').filter(Boolean).slice(-2).join('/');
    console.log(`[state] ${sid.slice(0, 8)} ${tail} ${last ? last.signal : '—'} → ${signal} (${source})${entry.skipped ? ` +${entry.skipped} unlogged` : ''}`);
    entry.loggedAt = now;
    entry.skipped = 0;
  } else entry.skipped += 1;
  lastPresented.set(sid, entry);
}

// A held ask has to appear when its hold runs out even if nothing else
// happens; the regular poll is too slow for that.
let heldAskTimer = null;
function wakeWhenHoldEnds(data, now) {
  if (heldAskTimer) return;
  const since = Date.parse(data.signalSince || data.updatedAt || '') || now;
  // Past the 200 ms state memo, or the wake-up would just read the memo back.
  const ms = Math.max(250, Rules.TRANSIENT_ASK_MS - (now - since) + 50);
  heldAskTimer = setTimeout(() => { heldAskTimer = null; broadcastStatus(); }, ms);
}

function readSessions(config, pendingIds = []) {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  if (sessionFileCache.size > files.length) {
    const live = new Set(files);
    for (const k of sessionFileCache.keys()) if (!live.has(k)) sessionFileCache.delete(k);
  }
  const workingStaleMs = config.workingStaleMinutes * 60 * 1000;
  const waitingStaleMs = config.waitingStaleHours * 60 * 60 * 1000;
  const now = Date.now();
  const sessions = [];
  for (const f of files) {
    try {
      const data = readSessionFile(f);
      if (!data) continue;
      const signal = Rules.sessionSignal(data);
      if (!signal) continue;
      const presented = Rules.presentSignal(data, now, pendingIds);
      const held = presented !== signal;
      if (held) wakeWhenHoldEnds(data, now);
      const eff = Rules.effectiveSignal({ ...data, signal: presented });
      const source = held ? 'hysteresis-held' : eff.turnSignal ? 'promoted-agents' : (data.via || 'hook signal');
      if (eff.turnSignal) {
        if (workingAgentsStale(data, now, workingStaleMs)) continue;
        logTransition(data, eff.signal, source, now);
        sessions.push({ ...data, ...eff });
        continue;
      }
      const staleAfter = WAITING_SIGNALS.has(signal) ? waitingStaleMs : workingStaleMs;
      if (now - new Date(data.updatedAt).getTime() > staleAfter) continue;
      logTransition(data, presented, source, now);
      sessions.push({ ...data, signal: presented });
    } catch {
      // skip unreadable/partially-written file
    }
  }
  return sessions;
}

// ── Other agents: OMC modes and Claude Code teams ───────────────────────────
// agents.js reads them off disk (see it for the exact file layout and shapes).
// Poll every couple of seconds and merge what it finds into the session files,
// so the session file stays the one schema everything downstream reads.
const OMC_POLL_MS = 2000;

function syncAgents() {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of files) {
    const file = path.join(SESSIONS_DIR, f);
    let readAt;
    try { readAt = fs.statSync(file).mtimeMs; } catch { continue; }
    const s = Agents.readJson(file);
    if (!s || !s.sessionId) continue;
    const found = Agents.scanAgents(s);
    const next = { ...s, agents: Agents.mergeAgents(s.agents, found.agents), mode: found.mode, iteration: found.iteration };
    if (JSON.stringify(next) === JSON.stringify(s)) continue;
    try {
      writeJsonAtomic(file, next, readAt);
    } catch {
      // the session ended (file removed) mid-poll; the next poll picks it up
    }
  }
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

// One broadcast asks for the resolved state three or four times (the widget,
// the overlay, the garden, the roamer, the alert sound). Resolving it once and
// handing out the same object for 200 ms turns that back into one pass.
let stateMemo = { at: 0, key: null, value: null };
function aggregateState(opts = {}) {
  const key = `${!!opts.ignoreTravel}|${travelLook ? `${travelLook.name}:${travelLook.gardenAct}:${travelLook.pose}` : ''}|${previewLook ? previewLook.expiresAt : ''}`;
  if (stateMemo.value && stateMemo.key === key && Date.now() - stateMemo.at < 200) return stateMemo.value;
  const value = computeState(opts);
  stateMemo = { at: Date.now(), key, value };
  return value;
}

function computeState(opts = {}) {
  const config = loadConfig();
  const requests = readRequests();
  const sessions = withAdvice(readSessions(config, requests.map((r) => r.sessionId)), config);
  const pending = config.askFromWidget ? requests : [];
  const tasks = config.showTasks ? sumTasks(sessions.filter((s) => !WAITING_SIGNALS.has(s.signal) && s.signal !== 'idle-nudge')) : null;
  if (previewLook && Date.now() < previewLook.expiresAt) {
    return { look: previewLook.look, reason: 'preview', sessions, fired: [], pending: [], tasks: null };
  }
  if (travelLook && !opts.ignoreTravel) {
    return { look: { ...travelLook, tasks }, reason: 'travel', sessions, fired: [], pending, tasks };
  }
  const override = readManualOverride();
  if (override) {
    const synthetic = [{ signal: OVERRIDE_SIGNALS[override.state] || 'idle', cwd: '' }];
    const { look, fired, owned } = Rules.resolve(config.rules, synthetic);
    return { look: { ...look, tasks }, reason: 'manual', sessions, fired, owned, firedNames: Rules.firedNames(config.rules, fired, owned), pending, tasks };
  }
  const { look, fired, owned } = Rules.resolve(config.rules, sessions);
  const agentCount = Rules.liveAgents(sessions).length;
  if (config.seasonal) {
    if (look.costume === 'none') look.costume = Rules.seasonalCostume() || 'none';
    if (look.effect === 'none') look.effect = Rules.seasonalEffect() || 'none';
  }
  // A pending permission request is the "Needs your input" state, whatever
  // the session files say (the hook blocks before Notification fires).
  if (pending.length) {
    const asked = Rules.resolve(config.rules, [{ signal: 'permission-ask', cwd: pending[0].cwd }]);
    return { look: { ...asked.look, tasks }, reason: 'session', sessions, fired: ['permission'], owned, firedNames: Rules.firedNames(config.rules, asked.fired, asked.owned), agentCount, pending, tasks };
  }
  const minions = config.showAgents ? Rules.filterAgentKinds(Rules.liveAgents(sessions), config.agentKinds).slice(0, 32) : [];
  return { look: { ...withNumber(look, sessions, tasks), tasks, minions, agentRoster: config.agentRoster !== false, agentChipSize: config.agentChipSize }, reason: sessions.length ? 'session' : 'idle', sessions, fired, owned, firedNames: Rules.firedNames(config.rules, fired, owned), tool: currentTool(sessions), routed: routedModel(sessions), saved: savedToday(config), advice: pickAdvice(sessions), agentCount, pending, tasks, minions };
}

// ── Router advice for sessions that are already open ───────────────────────
// The router never switches a running session; when the pick for it now is
// cheaper than its model, it says so (Router tab, widget strip) and you type
// /model. sessionId → { model last seen, advice, kept }. Outside dev runs it
// is mirrored onto the session file, which set-status.js carries through.
const adviceState = new Map();
// { history, models, savings } from the last transcript read.
let usageDerived = null;

function withAdvice(sessions, config) {
  const on = !!config.routerEnabled && !!usageDerived;
  const live = new Set();
  const out = sessions.map((s) => {
    if (!s.sessionId || (s.source && s.source !== 'claude')) return s;
    live.add(s.sessionId);
    const seen = usageDerived && usageDerived.models.get(s.sessionId);
    const current = (seen && seen.model) || s.model || null;
    const st = adviceState.get(s.sessionId) || { model: null, advice: null, kept: !!s.adviceKept };
    if (st.model && current && Router.switchedDown(st.model, current)) console.log(`[router] ${String(s.sessionId).slice(0, 8)} switched to ${Router.family(current)}`);
    if (current) st.model = current;
    st.advice = on ? Router.advise({ current, cwd: s.cwd, route: s.route, escalated: !!s.escalated, history: usageDerived.history, config }) : null;
    adviceState.set(s.sessionId, st);
    if (!IS_DEV_RUN && (JSON.stringify(s.routerAdvice || null) !== JSON.stringify(st.advice) || !!s.adviceKept !== st.kept)) mirrorAdvice(s, st);
    return { ...s, routerAdvice: st.advice || undefined, adviceKept: st.kept || undefined };
  });
  for (const id of adviceState.keys()) if (!live.has(id)) adviceState.delete(id);
  return out;
}

function mirrorAdvice(s, st) {
  const file = path.join(SESSIONS_DIR, `${s.host}-${s.sessionId}.json`);
  let readAt;
  try { readAt = fs.statSync(file).mtimeMs; } catch { return; }
  const cur = Agents.readJson(file);
  if (!cur) return;
  try { writeJsonAtomic(file, { ...cur, routerAdvice: st.advice || undefined, adviceKept: st.kept || undefined }, readAt); } catch { /* the session ended mid-poll */ }
}

// The widget's strip offers the most recently active advised session.
function pickAdvice(sessions) {
  const s = sessions.filter((x) => x.routerAdvice && !x.adviceKept)
    .sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0))[0];
  return s ? { sessionId: s.sessionId, model: s.routerAdvice.model, reason: s.routerAdvice.reason, project: Router.projectKey(s.cwd) } : null;
}

// The tooltip's "saved $N today": the low end, so it never overclaims.
function savedToday(config) {
  const s = usageDerived && usageDerived.savings;
  if (!s || !s.on || !(s.today.low > 0)) return null;
  if (config.routerSubscriberView) {
    const pct = s.today.actual ? Math.round((s.today.low / (s.today.actual + s.today.low)) * 100) : 0;
    return pct >= 1 ? `kept ${pct}% of today's usage` : null;
  }
  return `saved ${s.today.low >= 10 ? `$${Math.round(s.today.low)}` : `$${s.today.low.toFixed(2)}`} today`;
}

// The cheap model the most recently active routed session started on.
function routedModel(sessions) {
  let best = null;
  for (const s of sessions) {
    if (!s.route || s.escalated || (s.route.model !== 'sonnet' && s.route.model !== 'haiku')) continue;
    if (!best || (Date.parse(s.updatedAt || '') || 0) > (Date.parse(best.updatedAt || '') || 0)) best = s;
  }
  return best ? (best.route.model === 'sonnet' ? 'Sonnet' : 'Haiku') : null;
}

// The tool of the most recently updated session that is using one.
function currentTool(sessions) {
  if (sessions.some((s) => s.signal === 'permission-ask' && s.askKind === 'question')) return 'asking you a question';
  let best = null;
  for (const s of sessions) {
    if ((s.signal !== 'tool-use' && s.signal !== 'tool-done') || !s.tool) continue;
    if (!best || (Date.parse(s.updatedAt || '') || 0) > (Date.parse(best.updatedAt || '') || 0)) best = s;
  }
  return best ? best.tool : null;
}

// Number mode: the digit the sign shows instead of a colour.
function withNumber(look, sessions, tasks) {
  if (!look.numberOf) return look;
  let n = null;
  if (look.numberOf === 'sessions') n = sessions.length;
  else if (look.numberOf === 'minutes') n = look.waitMinutes || 0;
  else if (look.numberOf === 'tasks') n = tasks ? Math.max(0, tasks.created - tasks.done) : 0;
  else if (look.numberOf === 'agents') n = Rules.liveAgents(sessions).length;
  else if (look.numberOf === 'ralph') n = Rules.ralphIteration(sessions);
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

  guardRenderer(win, 'widget', () => { win = null; createWindow(); });
  // A reload loses the widget's state; re-push it as soon as it's back.
  win.webContents.on('did-finish-load', () => { stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); });

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
  burstTimer = stopTimer(burstTimer);
  snipeTimer = stopTimer(snipeTimer);
  aimTimer = stopTimer(aimTimer);
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
// The spotlight beam needs the terminal's Dock icon, which costs two osascript
// calls. This runs from every broadcast while the effect is on, so it caches
// the target for a minute and never runs two lookups at once — otherwise it
// fans out exactly the way maybeRoam used to.
let spotlightCache = { at: 0, target: null };
let spotlightBusy = false;
async function pushScreenFx(fx) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const payload = { fx };
  if (fx === 'spotlight' && IS_MAC) {
    if (spotlightBusy) return;
    let icon = spotlightCache.target;
    if (!icon || Date.now() - spotlightCache.at > 60000) {
      spotlightBusy = true;
      try {
        const app = await runningTerminal();
        icon = app ? await dockIconRect(app) : null;
        spotlightCache = { at: Date.now(), target: icon };
      } finally {
        spotlightBusy = false;
      }
    }
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
    if (gun) aimTimer = every(120, pushAim, 'aim');
    if (gun === 'ak47') { fireBurst(); burstTimer = every(BURST_EVERY_MS, fireBurst, 'burst'); }
    else if (gun === 'sniper') { fireSnipe(); snipeTimer = every(SNIPE_EVERY_MS, fireSnipe, 'snipe'); }
    if (overlayFx !== 'none') pushScreenFx(overlayFx);
  });
  // If the overlay's renderer dies, tear the whole thing down rather than
  // leaving a transparent always-on-top window with a dead canvas on screen.
  guardRenderer(overlayWin, 'overlay', () => stopOverlay());
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

// capturePage() is expensive (an offscreen paint plus a PNG encode), so the
// menu-bar icon is only re-rendered when the look actually changes or an
// animated channel needs a new frame — not twice a second forever.
let trayLookKey = null;
let trayPainting = false;
const TRAY_ANIMATED = new Set(['pulse', 'strobe', 'breathe', 'flicker', 'chase', 'police', 'rainbow', 'sos']);
async function paintTray(force = false) {
  if (trayPainting) return;
  if (!tray || !trayRenderWin || trayRenderWin.isDestroyed() || trayRenderWin.webContents.isLoading()) return;
  const { look } = aggregateState();
  const key = JSON.stringify([look.lamp, look.lampColor, look.lampFx, look.eyes, look.pose, look.costume, look.body, look.number]);
  const animated = TRAY_ANIMATED.has(look.lampFx) || ['blink', 'nod', 'bounce', 'run', 'knock', 'spin', 'party'].includes(look.pose);
  if (!force && !animated && key === trayLookKey) return;
  trayLookKey = key;
  trayPainting = true;
  try {
    // No agent chips in the menu bar: 22px has no room for them.
    trayRenderWin.webContents.send('look', { ...look, minions: [], facing: 'right' });
    const img = await trayRenderWin.webContents.capturePage();
    const size = img.getSize();
    if (!size.width) return;
    const scale = size.width / 18;
    tray.setImage(nativeImage.createFromBuffer(img.toPNG(), { scaleFactor: scale }));
  } finally {
    trayPainting = false;
  }
}

function updateTrayMode() {
  const on = loadConfig().menuBarMode;
  if (on) {
    ensureTrayRenderer();
    trayLookKey = null;
    if (!trayTimer) trayTimer = every(500, () => paintTray().catch(() => {}), 'tray');
  } else {
    trayTimer = stopTimer(trayTimer);
    trayLookKey = null;
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
const GT = { FETCH: 240000 / GSPEED, PLANT: 360000 / GSPEED, GROW: 240000 / GSPEED, EAT_EVERY: 40000 / GSPEED, ROTATE: 900000 / GSPEED, DRY: 600000 / GSPEED, PROCESS: 90000 / GSPEED, SMASH_RUN: 7000 / GSPEED, CHILL: 600000 / GSPEED, HAMMOCK_FETCH: 20000 / GSPEED, DEAL: Number(process.env.CLAUDE_TRAFFIC_LIGHT_DEAL_MS || 40000 / GSPEED), POTS: 12, WEED_ONE_IN: Number(process.env.CLAUDE_TRAFFIC_LIGHT_WEED_ONE_IN || 30) };

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
  // `run` is declared before anything that can throw: the finally block below
  // reads it, and a throw from gardenGeometry() used to hit the temporal dead
  // zone there — masking the real error and leaving travelLook stuck, which
  // freezes the widget's look until a restart.
  let run = null;
  let geo;
  try {
    geo = gardenGeometry();
  } catch (e) {
    console.log('[garden] could not lay out the garden:', e.message);
    travelLook = null;
    gardenRun = null;
    broadcastStatus();
    return;
  }
  gardenRun = { base, home: win.getBounds(), pots: [], firstBite: null, lastBite: 0, rotations: 0, stop: false, label: 'Gardening', geo, planted: 0 };
  run = gardenRun;
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
        dried.state = 'processing';
        // take it down off the rack, then work it into a jar at the table
        gardenAct('walking', { facing: facingTo(stand.x) });
        await moveWidget(stand.x, stand.y, 2500);
        if (!alive()) break;
        gardenAct('carrying', { facing: 'right' });
        overlayGarden({ op: 'unrack', i });
        await wait(2000);
        gardenAct('processing', { facing: 'right' });
        overlayGarden({ op: 'process', i, ms: GT.PROCESS });
        await wait(GT.PROCESS);
        if (!alive()) break;
        overlayGarden({ op: 'jar', i });
        gardenAct(null, { facing: 'right' });
        dried.state = 'jarred';
        await wait(1500);
        continue;
      }
      const jarred = run.pots.find((p) => p.state === 'jarred');
      if (jarred) {
        const i = run.pots.indexOf(jarred);
        jarred.state = 'dealing';
        const stand = standAt(jarred);
        gardenAct('walking', { facing: facingTo(stand.x) });
        await moveWidget(stand.x, stand.y, 1500);
        if (!alive()) break;
        gardenAct(null, { facing: 'right' });
        // every buyer is generated fresh: a random look each time
        overlayGarden({ op: 'deal', i, ms: GT.DEAL, seed: Math.floor(Math.random() * 1e9), claude: { x: win.getBounds().x, y: win.getBounds().y, w: geo.width, h: geo.height } });
        await wait(GT.DEAL);
        if (!alive()) break;
        gardenAct('thumbs');
        await wait(1500);
        gardenAct(null);
        jarred.crop = null; jarred.state = 'empty';
        overlayGarden({ op: 'clearpot', i });
        // ── paid: off to fetch a hammock, light the joint, and sleep on it.
        // The garden goes untended meanwhile — overgrowth, then animals.
        const edgeX = win.getBounds().x < geo.wa.x + geo.wa.width / 2 ? geo.wa.x - geo.width + 12 : geo.wa.x + geo.wa.width - 12;
        gardenAct('walking', { facing: facingTo(edgeX) });
        await moveWidget(edgeX, geo.floorY, GT.HAMMOCK_FETCH * 0.45);
        if (!alive()) break;
        const spot = { x: geo.homeX, y: geo.floorY };
        gardenAct('carrying', { facing: facingTo(spot.x) });
        await moveWidget(spot.x, spot.y, GT.HAMMOCK_FETCH * 0.55);
        if (!alive()) break;
        overlayGarden({ op: 'hammock', x: spot.x + Math.round(geo.width / 2), y: spot.y + geo.height - 8, w: Math.round(geo.width * 1.6) });
        gardenAct('lounging', { facing: 'right' });
        overlayGarden({ op: 'neglect', ms: GT.CHILL });
        const chillEnd = Date.now() + GT.CHILL;
        while (alive() && Date.now() < chillEnd) await wait(1000);
        overlayGarden({ op: 'wake' });
        gardenAct(null);
        run.lastBite = Date.now();
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
      // Teardown: run to every pot (7 s each), smash it with a hammer, watch
      // it blow apart, then go home.
      try {
        for (const pot of run.pots) {
          if (gardenRun !== run || !win || win.isDestroyed()) break;
          const stand = standAt(pot);
          gardenAct('walking', { facing: facingTo(stand.x) });
          await moveWidget(stand.x, stand.y, GT.SMASH_RUN);
          gardenAct('smashing', { facing: 'right' });
          await wait(1100);
          overlayGarden({ op: 'smash', i: run.pots.indexOf(pot) });
          await wait(700);
        }
      } catch (e) { console.log('[garden] teardown', e.message); }
      gardenAct(null);
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
  // Judge by the state underneath any travel override, or a state change
  // during gardening would never be seen.
  const real = gardenRun ? aggregateState({ ignoreTravel: true }) : st;
  const wants = real.look.effect === 'garden' && win && win.isVisible() && real.reason !== 'preview';
  if (wants && !gardenRun && !roamState.busy) {
    runGarden(real.look).catch((e) => console.log('[garden]', e.message));
  } else if (!wants && gardenRun && !gardenRun.stop) {
    console.log('[garden] stopping: reason', real.reason, 'effect', real.look.effect);
    gardenRun.stop = true;
  }
}

function broadcastStatus() {
  // travelLook is only ever legitimate while the garden or a roam is running.
  // If one of those died (a throw, a crashed renderer, a closed window) the
  // widget would otherwise be frozen on a walk pose forever — this is the one
  // place that can always see it, so it always clears it.
  if (travelLook && !gardenRun && !roamState.busy) {
    console.log('[status] clearing a stranded travelLook');
    travelLook = null;
    stateMemo = { at: 0, key: null, value: null };
  }
  // A renderer that died without firing render-process-gone (seen with a
  // Chromium font-stack fatal) leaves the widget blank forever; recreate it
  // here, since this loop is the one thing guaranteed to keep running.
  if (win && !win.isDestroyed() && win.webContents.isCrashed()) {
    console.log('[watchdog] widget renderer is dead — recreating');
    try { win.destroy(); } catch { /* already gone */ }
    win = null;
    createWindow();
  }
  win?.webContents.send('status-changed');
  lightsWin?.webContents.send('status-changed');
  try {
    const st = aggregateState();
    updateOverlay(st.look);
    applyStrip(!!((st.pending && st.pending.length) || st.advice) && !travelLook);
    updateGarden(st);
    maybeRoam(st);
    maybeRandomEvent(st);
  } catch (e) { console.log('[status]', e.message); }
}

// ── Roaming: walk to the terminal's Dock icon and knock ────────────────────
// When something needs you and the terminal isn't the front app, Claude runs
// along the screen to that app's Dock icon, knocks, and runs home. Once per
// waiting episode, then every 10 minutes while still ignored.
let roamState = { lastKnock: 0, lastProbe: 0, probing: false, waitingSince: null, busy: false, home: null };

// Serialised, time-boxed AppleScript. System Events can stall for minutes
// (Automation prompt, busy Dock), and an unbounded osascript per status tick
// once piled up 1,750 processes and exhausted the machine's process table.
// One in flight at a time; a second caller shares the pending result; hung
// scripts are killed at 4s.
const osaInflight = new Map();
function osa(script) {
  if (osaInflight.has(script)) return osaInflight.get(script);
  const p = new Promise((resolve) => {
    const child = execFile('osascript', ['-e', script], { timeout: 4000, killSignal: 'SIGKILL' }, (err, out) => resolve(err ? null : out.trim()));
    child.on('error', () => resolve(null));
  }).finally(() => osaInflight.delete(script));
  osaInflight.set(script, p);
  return p;
}

async function frontmostApp() {
  return osa('tell application "System Events" to get name of first application process whose frontmost is true');
}

// The Dock lists items under their *display* name ("Ghostty"), which is not
// always the process name ("ghostty") — so the lookup is case-insensitive and
// falls back to scanning the list. Returns the icon's screen rect plus how the
// Dock is arranged, so a hidden Dock still gives us somewhere to knock.
async function dockIconRect(appName) {
  const safe = escapeForAppleScript(appName);
  let out = await osa(`tell application "System Events" to tell process "Dock" to get {position, size} of UI element "${safe}" of list 1`);
  if (!out) {
    // Case or punctuation mismatch: find the matching item by name instead.
    const names = await osa('tell application "System Events" to tell process "Dock" to get name of every UI element of list 1');
    if (!names) return null;
    const want = appName.toLowerCase();
    const hit = names.split(',').map((x) => x.trim()).find((n) => n.toLowerCase() === want)
      || names.split(',').map((x) => x.trim()).find((n) => n.toLowerCase().startsWith(want) || want.startsWith(n.toLowerCase()));
    if (!hit || hit === 'missing value') return null;
    out = await osa(`tell application "System Events" to tell process "Dock" to get {position, size} of UI element "${escapeForAppleScript(hit)}" of list 1`);
    if (!out) return null;
  }
  const n = out.split(',').map((x) => Number(x.trim()));
  if (n.length < 4 || n.some(Number.isNaN)) return null;
  const rect = { x: n[0], y: n[1], w: n[2], h: n[3] };
  if (rect.w < 2 || rect.h < 2) return null;
  return clampToDisplay(rect);
}

// A hidden Dock reports its icons off the bottom (or side) of the screen, and
// an icon on a second display is simply outside the primary. Either way, walk
// to the nearest point that is actually on a display, so the knock is visible.
function clampToDisplay(rect) {
  return HostApp.clampRectToDisplays(rect, screen.getAllDisplays());
}

// "get name of every process" is the slowest call we make (it can take
// seconds on a loaded machine) and the answer barely changes, so it is cached
// for 30 s on top of osa()'s single-flight guard.
let processNameCache = { at: 0, names: null };
async function runningProcessNames() {
  if (processNameCache.names && Date.now() - processNameCache.at < 30000) return processNameCache.names;
  const names = await osa('tell application "System Events" to get name of every process');
  if (!names) return processNameCache.names; // keep the last good answer rather than failing the roam
  processNameCache = { at: Date.now(), names: names.split(',').map((x) => x.trim()).filter(Boolean) };
  return processNameCache.names;
}

// Which app should Claude knock on? The session that needs you knows, because
// the hook recorded it (`hostApp`). Only if nothing recorded one — an old
// session file, or another agent posting over the HTTP endpoint — do we fall
// back to "whatever terminal happens to be running".
async function terminalForSessions(sessions = []) {
  const running = await runningProcessNames();
  if (!running) return null;
  return HostApp.pickTerminal(sessions, running, (sig) => WAITING_SIGNALS.has(sig), TERMINAL_APPS);
}

async function runningTerminal() {
  return terminalForSessions(aggregateState().sessions);
}

function tween(from, to, ms, onStep) {
  const nums = [from?.x, from?.y, to?.x, to?.y, ms];
  if (!nums.every(Number.isFinite)) { console.log('[tween] skipped, non-finite input', JSON.stringify({ from, to, ms })); return Promise.resolve(); }
  return new Promise((resolve) => {
    const t0 = Date.now();
    // A tween that outlives its window (quit, crash, reload) must not keep a
    // 60 Hz interval alive forever, and a throwing step must still clear it.
    const id = every(16, () => {
      if (!win || win.isDestroyed()) { stopTimer(id); resolve(); return; }
      const p = Math.min(1, (Date.now() - t0) / ms);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      try {
        onStep({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e) });
      } catch (err) {
        console.log('[tween] step failed:', err.message);
        stopTimer(id); resolve(); return;
      }
      if (p >= 1) { stopTimer(id); resolve(); }
    }, 'tween');
  });
}

// The Dock gives no API for making another app's icon bounce, so the bounce
// the user sees is Claude physically hopping on the icon. Our own Dock tile is
// asked to bounce too, which is a no-op while the tile is hidden but shows up
// for anyone running with the Dock icon visible.
function bounceOwnDock() {
  if (!IS_MAC || !app.dock) return;
  try { app.dock.bounce('critical'); } catch { /* dock icon hidden */ }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The knock itself: three knocks, each with a hop on the icon and a sound,
// then "hey!" with the app's name in a speech bubble.
async function performKnock(appName, target, base) {
  const knockSound = loadConfig().soundOnAmber ? (base.sound || 'Tink') : null;
  for (let i = 0; i < 3; i += 1) {
    travelLook = { ...base, pose: 'knock', facing: 'right', aimAngle: 0, text: 'KNOCK', name: `Knocking on ${appName}` };
    broadcastStatus();
    if (knockSound) playSound(knockSound);
    bounceOwnDock();
    // hop up off the icon and land back on it
    await tween(target, { x: target.x, y: target.y - 16 }, 130, (pt) => win?.setPosition(pt.x, pt.y));
    await tween({ x: target.x, y: target.y - 16 }, target, 130, (pt) => win?.setPosition(pt.x, pt.y));
    await wait(220);
  }
  travelLook = { ...base, pose: 'bubble', facing: 'right', aimAngle: 0, text: `HEY! ${appName}`, name: `${appName} needs you` };
  broadcastStatus();
  await wait(1800);
}

// One roam: run to the Dock icon, knock, run home. `force` skips the "is it
// already the front app / is a knock due" checks, for the tray item and demo.
async function roamAndKnock(st, { force = false } = {}) {
  if (!IS_MAC) return { ok: false, why: 'macOS only' };
  if (!win) return { ok: false, why: 'no widget' };
  if (roamState.busy) return { ok: false, why: 'already roaming' };
  if (gardenRun) return { ok: false, why: 'gardening' };
  // busy goes up BEFORE the first await. Deciding whether to knock costs three
  // osascript calls, and claiming the flag only afterwards is what let every
  // status tick start another round while the previous one was still waiting —
  // thousands of hung osascript processes, and an exhausted process table.
  roamState.busy = true;
  const giveUp = (why) => { roamState.busy = false; return { ok: false, why }; };
  let appName = null;
  let icon = null;
  try {
    appName = await terminalForSessions(st.sessions);
    if (!appName) return giveUp('no terminal app running');
    if (!force && (await frontmostApp()) === appName) return giveUp('already the front app');
    icon = await dockIconRect(appName);
    if (!icon) return giveUp(`no Dock icon for ${appName}`);
  } catch (e) {
    return giveUp(`could not locate the Dock icon: ${e.message}`);
  }
  roamState.lastKnock = Date.now();
  const wasVisible = win.isVisible();
  if (!wasVisible) win.showInactive();
  const home = roamState.home || win.getBounds();
  roamState.home = home;
  const base = { ...st.look, effect: 'none' };
  // Stand on top of the icon, clamped so he never walks off the display.
  const wa = (icon.display || screen.getPrimaryDisplay()).workArea;
  const target = {
    x: Math.round(Math.max(wa.x, Math.min(wa.x + wa.width - home.width, icon.x + icon.w / 2 - home.width / 2))),
    y: Math.round(Math.max(wa.y, Math.min(wa.y + wa.height - home.height, icon.y - home.height + 6))),
  };
  const facing = target.x < home.x ? 'left' : 'right';
  try {
    travelLook = { ...base, pose: 'run', facing, aimAngle: 0, name: `Running to ${appName}` };
    broadcastStatus();
    await tween({ x: home.x, y: home.y }, target, 1400, (pt) => win?.setPosition(pt.x, pt.y));
    await performKnock(appName, target, base);
    travelLook = { ...base, pose: 'run', facing: facing === 'left' ? 'right' : 'left', aimAngle: 0, name: 'Running home' };
    broadcastStatus();
    await tween(target, { x: home.x, y: home.y }, 1400, (pt) => win?.setPosition(pt.x, pt.y));
    return { ok: true, app: appName, icon: { x: icon.x, y: icon.y, w: icon.w, h: icon.h, hidden: !!icon.hidden } };
  } catch (e) {
    // Whatever went wrong, the widget must not be left mid-walk.
    console.log('[roam] failed:', e.stack || e.message);
    return { ok: false, why: e.message };
  } finally {
    travelLook = null;
    try { if (win && !win.isDestroyed()) win.setBounds(home); } catch { /* window gone */ }
    if (!wasVisible) win?.hide();
    roamState.busy = false;
    stateMemo = { at: 0, key: null, value: null };
    broadcastStatus();
  }
}

// Tray → "Knock now", and `--demo knock`.
async function knockNow() {
  const st = aggregateState({ ignoreTravel: true });
  return roamAndKnock(st, { force: true });
}

function maybeRoam(st) {
  const config = loadConfig();
  if (!IS_MAC || !config.roam || !win || !win.isVisible() || roamState.busy || previewLook || gardenRun) return;
  const waiting = st.pending?.length || st.sessions.some((s) => WAITING_SIGNALS.has(s.signal));
  if (!waiting) { roamState.waitingSince = null; return; }
  if (!roamState.waitingSince) roamState.waitingSince = Date.now();
  const due = roamState.lastKnock === 0 || Date.now() - roamState.lastKnock > 10 * 60 * 1000;
  if (!due) return;
  // maybeRoam runs from every broadcast, and the checks above it are all
  // synchronous — but deciding whether to roam needs three osascript spawns.
  // Without this guard a waiting session fired a fresh trio of `osascript`
  // processes every 4 seconds (and on every session-file write), which is what
  // made the machine crawl while a permission prompt sat unanswered.
  if (roamState.probing) return;
  if (Date.now() - roamState.lastProbe < 20000) return;
  roamState.probing = true;
  roamState.lastProbe = Date.now();
  roamAndKnock(st)
    .then((r) => { if (!r.ok) console.log('[roam] skipped:', r.why); })
    .catch((e) => console.log('[roam]', e.message))
    .finally(() => { roamState.probing = false; });
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
    { label: 'Router…', click: () => { createLightsWindow(); lightsWin?.webContents.once('did-finish-load', () => lightsWin?.webContents.send('show-view', 'router')); lightsWin?.webContents.send('show-view', 'router'); } },
    { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: createSettingsWindow },
    { label: 'Knock now', enabled: IS_MAC, click: () => { knockNow().then((r) => console.log('[knock now]', JSON.stringify(r))); } },
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
  if ('routerDelegation' in partial) {
    const d = loadConfig().routerDelegation;
    try { DelegationInstall.writeFlag(delegationOpts(), d, d.enabled); } catch (err) { console.warn('[delegation] flag not written:', err.message); }
  }
  if ('showWidget' in partial) applyWidgetVisibility();
  if ('menuBarMode' in partial || 'showWidget' in partial) createTray();
  broadcastStatus();
  return next;
});

ipcMain.handle('get-stats', (_e, days) => Stats.summary(stats, Date.now(), Math.min(60, Math.max(1, Number(days) || 7))));

// Export the whole visible range as JSON or CSV, wherever the user points.
ipcMain.handle('export-stats', async (_e, format, days) => {
  const n = Math.min(60, Math.max(1, Number(days) || 7));
  const sum = Stats.summary(stats, Date.now(), n);
  const csv = format === 'csv';
  const name = `claude-buddy-stats-${Stats.dayKey(Date.now())}-${n}d.${csv ? 'csv' : 'json'}`;
  const r = await dialog.showSaveDialog(lightsWin || undefined, {
    title: 'Export stats',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [csv ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, csv ? Stats.toCsv(sum) : JSON.stringify(sum, null, 2));
  return { ok: true, path: r.filePath };
});

// ── Costs, from ccusage (the same source as the user's cost alerts) ────────
let costCache = { at: 0, data: null };
let costInFlight = null;
const COST_TTL_MS = 5 * 60 * 1000;
function runCcusage(args) {
  return new Promise((resolve) => {
    // ccusage walks every transcript on disk; it must never be allowed to run
    // forever or pile up, so it gets a hard timeout and is killed on expiry.
    execFile('ccusage', [...args, '--json', '--offline'], {
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 25000,
      killSignal: 'SIGKILL',
    }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}
// Never more than one ccusage pass at a time, and at most one per 5 minutes:
// the Stats tab used to be able to fan out a spawn per repaint.
function getCosts() {
  // Transcript costs are recomputed from the usage memo every time so Spend
  // never lags the Router; only a ccusage result is held for 5 minutes.
  if (Date.now() - costCache.at < COST_TTL_MS && costCache.data && costCache.data.source !== 'transcripts') return Promise.resolve(costCache.data);
  if (costInFlight) return costInFlight;
  costInFlight = computeCosts().finally(() => { costInFlight = null; });
  return costInFlight;
}
// ~/.claude/projects holds one directory per project and one .jsonl per
// session. The old code did an existsSync per (session × directory) on the
// main thread — thousands of blocking stats per Stats open. Instead each
// directory is listed once into a session-id → path map, cached by mtime, and
// the whole index is rebuilt at most once every 5 minutes.
let transcriptCache = { at: 0, dirKeys: '', index: new Map() };
function transcriptIndex() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch { return new Map(); }
  let dirKeys = '';
  for (const d of dirs) { try { dirKeys += `${d}:${fs.statSync(d).mtimeMs};`; } catch { /* vanished */ } }
  if (transcriptCache.index.size && transcriptCache.dirKeys === dirKeys && Date.now() - transcriptCache.at < COST_TTL_MS) return transcriptCache.index;
  const index = new Map();
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) index.set(f.slice(0, -6), path.join(dir, f));
  }
  transcriptCache = { at: Date.now(), dirKeys, index };
  return index;
}

let costSource = null;
function noteCostSource(source) {
  if (source !== costSource) console.log(`[costs] source: ${source}`);
  costSource = source;
}

async function computeCosts() {
  // The transcripts are the source of truth, so Spend always agrees with the
  // Router; ccusage is only asked when there are no transcripts to read.
  const turns = await getUsageTurns();
  if (turns.length) {
    noteCostSource('transcripts');
    const data = Usage.spend(turns);
    for (const [key, cost] of Object.entries(data.history)) Stats.recordCost(stats, key, cost);
    statsDirty = true;
    costCache = { at: Date.now(), data };
    return data;
  }
  noteCostSource('ccusage');
  const since = new Date(Date.now() - 6 * 86400000);
  const ymd = `${since.getFullYear()}${String(since.getMonth() + 1).padStart(2, '0')}${String(since.getDate()).padStart(2, '0')}`;
  const [daily, session] = await Promise.all([runCcusage(['daily', '--since', ymd]), runCcusage(['session', '--since', ymd])]);
  if (!daily && !session) { costCache = { at: Date.now(), data: { available: false, source: 'ccusage' } }; return costCache.data; }
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
  const index = transcriptIndex();
  const cwdFromTranscript = (id) => {
    if (cwdById[id] !== undefined && cwdById[id] !== null) return cwdById[id];
    const f = index.get(id);
    if (!f) return null;
    try {
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd);
      const m = /"cwd":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      cwdById[id] = m ? m[1] : null;
      return cwdById[id];
    } catch { return null; }
  };
  const projects = {};
  const sessions = [];
  for (const sname of session?.session || []) {
    const id = sname.period;
    const cwd = cwdFromTranscript(id) || (sname.metadata && (sname.metadata.projectPath || sname.metadata.cwd)) || null;
    const project = cwd ? String(cwd).split('/').filter(Boolean).pop() : (sname.metadata?.project || 'other');
    const tokens = sname.totalTokens || ((sname.inputTokens || 0) + (sname.outputTokens || 0) + (sname.cacheCreationTokens || 0) + (sname.cacheReadTokens || 0));
    if (!projects[project]) projects[project] = { cost: 0, tokens: 0 };
    projects[project].cost += sname.totalCost || 0;
    projects[project].tokens += tokens;
    sessions.push({ id, project, cost: sname.totalCost || 0, tokens });
  }
  const data = { available: true, source: 'ccusage', days, totals: daily?.totals || null, projects: Object.entries(projects).sort((a, b) => b[1].cost - a[1].cost).map(([name, v]) => ({ name, ...v })), sessions: sessions.sort((a, b) => b.cost - a.cost).slice(0, 8) };
  // Snapshot each day's spend into stats.json: ccusage only reports a rolling
  // window, but the Stats page can look back 60 days.
  for (const [key, d] of Object.entries(days)) Stats.recordCost(stats, key, d.cost);
  statsDirty = true;
  costCache = { at: Date.now(), data };
  return data;
}
ipcMain.handle('get-costs', () => getCosts());

// ── Router: per-turn usage read from the transcripts themselves ───────────
const USAGE_TTL_MS = 60 * 1000;
const ROUTER_BASELINE_FILE = path.join(ROOT_DIR, 'router-baseline.json');
const usageFileCache = new Map();
let usageMemo = { at: 0, turns: null };
let usageInFlight = null;
async function refreshUsage() {
  const t0 = Date.now();
  // 61 days covers the Stats page's 60-day lookback, which also spans the
  // Router's ranges and the 14-day baseline.
  const r = await Usage.readTurns({ since: Date.now() - 61 * 86400000, cache: usageFileCache });
  const ms = Date.now() - t0;
  // Live refreshes follow every burst of hook activity; only the first pass
  // and a slow one are worth a line.
  if (!usageMemo.turns || ms > 1000) console.log(`[usage] parsed ${r.parsed} files in ${ms} ms (${r.files} transcripts, ${r.turns.length} turns${r.skipped.length ? `, ${r.skipped.length} over the size cap` : ''})`);
  usageMemo = { at: Date.now(), turns: r.turns };
  deriveUsage(r.turns);
  // Nothing routes yet, so the baseline simply tracks the recent mix; once
  // routing can be switched on it has to be frozen at that moment instead.
  if (!IS_DEV_RUN) {
    try { fs.writeFileSync(ROUTER_BASELINE_FILE, JSON.stringify(Usage.summarise(r.turns, { days: 1 }).baseline, null, 2)); } catch (err) { console.warn('[usage] baseline not saved:', err.message); }
  }
  return r.turns;
}
function getUsageTurns() {
  if (usageMemo.turns && Date.now() - usageMemo.at < USAGE_TTL_MS) return Promise.resolve(usageMemo.turns);
  if (usageInFlight) return usageInFlight;
  usageInFlight = refreshUsage().finally(() => { usageInFlight = null; });
  return usageInFlight;
}
ipcMain.handle('get-usage-summary', async (_e, opts) => Usage.summarise(await getUsageTurns(), { days: Number(opts?.days) === 30 ? 30 : 7 }));

// What the advice, the tooltip and the Saved tile read between transcript
// passes; each part is a few ms over ~50k turns.
function deriveUsage(turns) {
  const config = loadConfig();
  let events = [];
  try { events = DelegationInstall.readLog(delegationOpts(), Date.now() - 8 * 86400000); } catch { /* no log yet */ }
  usageDerived = {
    history: Usage.projectHistory(turns),
    models: Usage.latestModels(turns),
    savings: Usage.savings(turns, {
      events,
      routing: !!config.routerEnabled,
      delegation: !!(config.routerDelegation && config.routerDelegation.enabled),
      enabledAt: Date.parse(config.routerEnabledAt || '') || null,
      switchedOnAt: Date.parse(config.routerSwitchedOnAt || '') || null,
      frozen: RouterInstall.readFrozen(routerOpts()),
    }),
  };
  return usageDerived;
}

// Hook activity is what moves spend and savings, so each burst of it gets a
// fresh read. The reader is incremental — a warm pass over ~500 transcripts
// measured 16 ms — so the floor between reads only has to absorb bursts.
const USAGE_LIVE_MS = 3000;
function refreshUsageLive() {
  if (usageInFlight || Date.now() - usageMemo.at < USAGE_LIVE_MS) return;
  const config = loadConfig();
  // The first read is cold (seconds); leave it to whoever asks, unless the
  // Router is on and the numbers are the point.
  if (!usageMemo.turns && !config.routerEnabled && !config.routerDelegation.enabled) return;
  const before = usageMemo.turns ? usageMemo.turns.length : -1;
  usageInFlight = refreshUsage().finally(() => { usageInFlight = null; });
  usageInFlight.then((turns) => {
    if (turns.length === before) return;
    stateMemo = { at: 0, key: null, value: null };
    broadcastStatus();
  }).catch((err) => console.warn('[usage] live refresh failed:', err.message));
}

// Routing or delegation changed: advice, savings and every window follow now.
function afterRoutingChange() {
  if (usageMemo.turns) deriveUsage(usageMemo.turns);
  stateMemo = { at: 0, key: null, value: null };
  broadcastStatus();
}

ipcMain.handle('get-savings', async () => {
  const turns = await getUsageTurns();
  const d = deriveUsage(turns);
  return { ...d.savings, subscriber: !!loadConfig().routerSubscriberView };
});

// ── Router, phase 1: the launcher shim ─────────────────────────────────────
// The shim reads history.json rather than the transcripts, so it has to be
// kept fresh from here.
const ROUTER_HISTORY_MS = 5 * 60 * 1000;
const routerFile = (name) => path.join(ROUTER_ROOT, 'router', name);

async function refreshRouterHistory() {
  const history = Usage.projectHistory(await getUsageTurns());
  fs.mkdirSync(path.join(ROUTER_ROOT, 'router'), { recursive: true });
  writeJsonAtomic(routerFile('history.json'), { at: history.at, days: history.days, projects: history.projects });
  markEscalations(history.escalated);
  return history;
}

// A session the router started cheap, whose transcript then moved up a
// model, gets `escalated` in its file — that is what the rules' 'escalated'
// signal reads. set-status.js carries the flag through its own writes.
function markEscalations(escalated) {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const file = path.join(SESSIONS_DIR, f);
    let readAt;
    try { readAt = fs.statSync(file).mtimeMs; } catch { continue; }
    const s = Agents.readJson(file);
    if (!s || s.escalated || !s.route || !escalated[s.sessionId] || !['sonnet', 'haiku'].includes(s.route.model)) continue;
    try { writeJsonAtomic(file, { ...s, escalated: true }, readAt); } catch { /* the session ended mid-poll */ }
  }
}

function routerStatus() {
  return { ...RouterInstall.status(routerOpts()), sandbox: ROUTER_SANDBOXED ? ROUTER_HOME : null, enabledAt: loadConfig().routerEnabledAt || null };
}

// Frozen once, on the first switch-on: the pre-routing mix every later
// "since you switched on" saving is priced against.
const baselineOf = (turns) => ({ ...Usage.summarise(turns, { days: 1 }).baseline, projects: Usage.projectMix(turns) });

// The launcher alone (Router → advanced).
ipcMain.handle('router-set-enabled', async (_e, on) => {
  const opts = routerOpts();
  if (!on) {
    RouterInstall.uninstall(opts);
    saveConfig({ routerEnabled: false });
    console.log('[router] launcher switched off');
    afterRoutingChange();
    return routerStatus();
  }
  const turns = await getUsageTurns();
  RouterInstall.freezeBaseline(opts, baselineOf(turns));
  const st = RouterInstall.install(opts);
  const now = new Date().toISOString();
  saveConfig({ routerEnabled: true, routerEnabledAt: loadConfig().routerEnabledAt || now, routerSwitchedOnAt: now });
  console.log('[router] launcher switched on', JSON.stringify({ shell: st.shell, rc: st.rcFile, shim: st.shim }));
  await refreshRouterHistory();
  afterRoutingChange();
  return routerStatus();
});

// "Route my sessions": launcher and delegation together, in the order that
// reaches the open sessions first — freeze the baseline, write the flag (the
// open sessions' hooks act on it at their next tool call), write the agents,
// install the shim (new sessions), then advice and a broadcast.
ipcMain.handle('router-switch', async (_e, on) => {
  const opts = routerOpts();
  if (!on) {
    RouterInstall.uninstall(opts);
    let error = null;
    try { DelegationInstall.uninstall(delegationOpts()); } catch (err) { error = err.message; }
    saveConfig({ routerEnabled: false, routerDelegation: { ...loadConfig().routerDelegation, enabled: false } });
    console.log('[router] switched off: launcher and delegation');
    afterRoutingChange();
    return { status: routerStatus(), delegation: delegationStatus(), error };
  }
  const turns = await getUsageTurns();
  RouterInstall.freezeBaseline(opts, baselineOf(turns));
  let deleg;
  try { deleg = DelegationInstall.install(delegationOpts()); } catch (err) { deleg = { error: err.message }; }
  const st = RouterInstall.install(opts);
  const now = new Date().toISOString();
  saveConfig({ routerEnabled: true, routerEnabledAt: loadConfig().routerEnabledAt || now, routerSwitchedOnAt: now, routerDelegation: { ...loadConfig().routerDelegation, enabled: !deleg.error } });
  console.log('[router] switched on', JSON.stringify({ shell: st.shell, rc: st.rcFile, shim: st.shim, delegation: deleg.error || 'on', conflicts: deleg.conflicts || [] }));
  await refreshRouterHistory();
  afterRoutingChange();
  return { status: routerStatus(), delegation: delegationStatus(), error: deleg.error || null, conflicts: deleg.conflicts || [] };
});

// "Switch this one": puts `/model <pick>` on the clipboard and brings that
// session's terminal forward. You paste it; nothing is typed for you.
async function copyModelSwitch(sessionId) {
  const s = aggregateState({ ignoreTravel: true }).sessions.find((x) => x.sessionId === sessionId);
  const st = adviceState.get(sessionId);
  if (!s || !st || !st.advice) return { ok: false, feedback: 'nothing to switch' };
  const command = `/model ${st.advice.model}`;
  clipboard.writeText(command);
  const activated = await activateTerminalApp(String(s.cwd || '').split('/').filter(Boolean).pop() || '', s.hostApp || null);
  console.log(`[router] ${String(sessionId).slice(0, 8)} copied ${command}${activated ? ` → ${activated.app}` : ''}`);
  return { ok: true, command, app: activated ? activated.app : null, feedback: 'Pasted? Press Enter.' };
}
ipcMain.handle('router-switch-session', (_e, sessionId) => copyModelSwitch(String(sessionId)));

// "Keep": this session stays on its model and the strip stops asking.
ipcMain.handle('advice-keep', (_e, sessionId) => {
  const st = adviceState.get(String(sessionId));
  if (!st) return false;
  st.kept = true;
  afterRoutingChange();
  return true;
});

ipcMain.handle('router-reveal-shim', () => {
  const st = RouterInstall.status(routerOpts());
  if (!st.shimExists) return false;
  shell.showItemInFolder(st.shim);
  return true;
});

ipcMain.handle('router-overview', async () => {
  const config = loadConfig();
  const turns = await getUsageTurns();
  const history = Usage.projectHistory(turns);
  const projects = Object.entries(history.projects)
    .filter(([, p]) => p.sessions)
    .map(([name, p]) => ({ name, ...p, override: config.routerProjects?.[name] || 'auto', pick: Router.decide({ cwd: name, history, config }) }))
    .sort((a, b) => b.sessions - a.sessions || b.turns - a.turns);
  const sessions = aggregateState({ ignoreTravel: true }).sessions
    .filter((s) => !s.source || s.source === 'claude')
    .map((s) => {
      const a = adviceState.get(s.sessionId) || {};
      return { sessionId: s.sessionId, project: Router.projectKey(s.cwd), route: s.route || null, escalated: !!s.escalated, signal: s.signal, model: Router.family(a.model), advice: a.advice || null, kept: !!a.kept, delegating: !!s.delegating };
    });
  const frozen = RouterInstall.readFrozen(routerOpts());
  const since = config.routerEnabledAt ? Usage.sinceRouting(turns, { since: Date.parse(config.routerEnabledAt), frozen }) : null;
  const status = routerStatus();
  const flag = DelegationInstall.readFlag(delegationOpts());
  const summary = Router.summaryLine({ launcher: status.shimExists, delegation: !!(flag && flag.enabled), sessions });
  return { status, policy: config.routerPolicy, projects, sessions, decisions: Router.readDecisions(routerFile('decisions.jsonl'), 20), since, summary, delegationOn: !!(flag && flag.enabled) };
});

// ── Router, phase 2: delegation ────────────────────────────────────────────
// Subagents in ~/.claude/agents, delegate.js hooks in ~/.claude/settings.json
// and the flag file. Dev runs install into the router's sandbox HOME, so they
// never touch the real ~/.claude.
function delegationOpts() {
  return { home: ROUTER_HOME, root: ROUTER_ROOT, scriptPath: path.join(HOOKS_DIR, 'delegate.js'), config: loadConfig().routerDelegation };
}

function delegationStatus() {
  return { ...DelegationInstall.status(delegationOpts()), sandbox: ROUTER_SANDBOXED ? ROUTER_HOME : null };
}

ipcMain.handle('delegation-set-enabled', (_e, on) => {
  const opts = delegationOpts();
  try {
    const r = on ? DelegationInstall.install(opts) : DelegationInstall.uninstall(opts);
    saveConfig({ routerDelegation: { ...loadConfig().routerDelegation, enabled: !!on }, ...(on ? { routerSwitchedOnAt: new Date().toISOString() } : {}) });
    console.log(`[delegation] switched ${on ? 'on' : 'off'}`, JSON.stringify({ agents: r.agentsDir, conflicts: r.conflicts || [], legacyHooksRemoved: !!r.settingsChanged }));
    afterRoutingChange();
    return { ...delegationStatus(), conflicts: r.conflicts || [] };
  } catch (err) {
    console.warn('[delegation] switch failed:', err.message);
    return { ...delegationStatus(), error: err.message };
  }
});

// Status and log are instant; the diet waits on the transcripts, so it is
// fetched on its own and the switch and knobs never sit behind a parse.
ipcMain.handle('delegation-overview', () => ({ status: delegationStatus(), presets: Delegate.PRESETS, log: DelegationInstall.readLog(delegationOpts(), Date.now() - 30 * 86400000).slice(-20).reverse() }));

ipcMain.handle('delegation-diet', async (_e, opts) => {
  const days = Number(opts?.days) === 30 ? 30 : 7;
  const turns = await getUsageTurns();
  const diet = Usage.contextDiet(DelegationInstall.readLog(delegationOpts(), Date.now() - days * 86400000), turns, { days });
  return { ...diet, actual: Usage.summarise(turns, { days }).total.cost };
});

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
// Dev runs (shots, playtests, demos) each get their OWN profile, keyed by pid.
//
// They used to share one fixed dev profile, which meant: a run that was killed
// (^C, a failed playtest, a crash) left Chromium's Singleton* files behind and
// the next run quietly quit at requestSingleInstanceLock — and worse, while an
// earlier dev instance was still alive the new run handed its flags to that
// dying instance through `second-instance`, whose `new BrowserWindow` throws,
// so the new process exited having printed nothing at all. That is the "the
// test just does nothing" failure. A per-pid profile cannot collide, cannot
// inherit a stale lock, and is deleted on the way out.
const DEV_PROFILE = IS_DEV_RUN ? path.join(os.tmpdir(), `claude-buddy-dev-${process.pid}`) : null;
if (DEV_PROFILE) {
  app.setPath('userData', DEV_PROFILE);
  const sweep = () => { try { fs.rmSync(DEV_PROFILE, { recursive: true, force: true }); } catch { /* already gone */ } };
  app.on('will-quit', sweep);
  process.on('exit', sweep);
  // Sweep profiles orphaned by a hard kill, so /tmp doesn't fill up.
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      const m = /^claude-buddy-dev-(\d+)$/.exec(d);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); continue; } catch { /* that pid is gone */ }
      fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    }
  } catch { /* nothing to sweep */ }
}

// A prior run killed abnormally (force-quit, a crash, macOS reclaiming
// memory) can leave the Singleton* files behind even though the process
// they name is long dead. Electron doesn't always notice on macOS, so the
// next launch fails requestSingleInstanceLock() and silently app.quit()s —
// no window, no dock icon, no error: it just looks like the app "won't
// open". Clear the lock ourselves first when the pid it names isn't alive.
function clearStaleSingletonLock() {
  const userData = app.getPath('userData');
  let target;
  try {
    target = fs.readlinkSync(path.join(userData, 'SingletonLock'));
  } catch {
    return; // no lock file, or it's not a symlink — nothing to clear
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (pid) {
    try { process.kill(pid, 0); return; } catch { /* that pid is gone: stale */ }
  }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(userData, f), { force: true }); } catch { /* already gone */ }
  }
  console.error('[startup] cleared a stale singleton lock left by pid', pid || target);
}
clearStaleSingletonLock();

// One widget, one tray. A second launch (e.g. `open -a … --args --lights`)
// hands its flags to the running instance instead of starting another.
const gotLock = app.requestSingleInstanceLock();
console.error('[startup]', JSON.stringify({ demo: DEMO, gotLock, userData: app.getPath('userData') }));
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    // This fires on an instance that may be mid-teardown, where opening a
    // window throws — and an uncaught throw here took the whole app down.
    try {
      if (argv.includes('--lights')) createLightsWindow();
      else win?.show();
    } catch (err) {
      console.error('[second-instance] could not surface a window:', err.message);
    }
  });
}

app.whenReady().then(() => {
  if (DEMO || DIAG) console.error('[startup] ready');
  if (process.platform === 'darwin') app.dock.hide();
  // Dev runs share the machine with a real install: they must not rewrite the
  // user's hooks or claim Open at Login out from under it.
  if (!IS_DEV_RUN && !areHooksInstalled()) installHooks();
  // A moved or updated .app changes delegate.js's path; reinstalling is a
  // no-op when nothing moved.
  if (!IS_DEV_RUN && loadConfig().routerDelegation.enabled) {
    try { DelegationInstall.install(delegationOpts()); } catch (err) { console.warn('[delegation] not refreshed:', err.message); }
  }

  const autoLaunchMarker = path.join(ROOT_DIR, '.auto-launch-configured');
  if (!IS_DEV_RUN && !fs.existsSync(autoLaunchMarker)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.writeFileSync(autoLaunchMarker, new Date().toISOString());
  }

  createWindow();
  createTray();
  startSignalServer();
  if (DEMO === 'weed') {
    // pots ×12 fetch+plant ≈ 25 s, grow 10 s, harvest ≈ 60 s, dry 25 s, trim, deals 30 s each;
    // at 6½ min a fake session appears so the state changes and the hammer teardown plays.
    setTimeout(() => {
      writeJsonAtomic(path.join(SESSIONS_DIR, 'demo-session.json'), { sessionId: 'demo', host: 'demo', cwd: '/demo', signal: 'tool-use', tool: 'Bash', updatedAt: new Date().toISOString() });
      broadcastStatus();
    }, 6.5 * 60 * 1000);
    setTimeout(() => app.quit(), 9 * 60 * 1000);
  }
  if (process.argv.includes('--lights')) createLightsWindow();

  // A busy turn writes its session file many times a second and every write
  // fires this watcher — coalesce them into at most one refresh per 200 ms.
  let watchTimer = null;
  fs.watch(SESSIONS_DIR, { persistent: true }, () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      broadcastStatus();
      maybePlayAlertSound();
      refreshUsageLive();
    }, 200);
  });

  every(4000, () => {
    broadcastStatus();
    maybePlayAlertSound();
    tickStats(readSessions(loadConfig()));
  }, 'poll');
  every(30000, flushStats, 'stats-flush');
  // Other agents live on disk, not in hooks: poll for them.
  if (!DEMO) { syncAgents(); every(OMC_POLL_MS, syncAgents, 'omc-agents'); }

  if (!IS_DEV_RUN) every(10 * 60 * 1000, () => { if (!areHooksInstalled()) installHooks(); }, 'hooks');
  // Only while the shim exists: nothing reads history.json otherwise.
  const routerTick = () => {
    if (!RouterInstall.status(routerOpts()).shimExists) return;
    refreshRouterHistory().catch((err) => console.warn('[router] history not refreshed:', err.message));
  };
  if (!DEMO) { setTimeout(routerTick, 15000); every(ROUTER_HISTORY_MS, routerTick, 'router-history'); }
  // Advice and live savings need one transcript pass behind them.
  if (!DEMO && (loadConfig().routerEnabled || loadConfig().routerDelegation.enabled)) setTimeout(() => getUsageTurns().then(afterRoutingChange).catch((err) => console.warn('[usage] warm-up failed:', err.message)), 5000);

  if (DIAG) startDiag();
  if (DEMO === 'knock') {
    // A session that is waiting on you, running in whatever terminal launched
    // the demo — exactly the situation the roamer exists for.
    writeJsonAtomic(path.join(SESSIONS_DIR, 'demo-knock.json'), {
      sessionId: 'demo-knock', host: 'demo', hostApp: process.env.CLAUDE_BUDDY_DEMO_APP || null,
      cwd: process.cwd(), signal: 'permission-ask', tool: 'Bash', updatedAt: new Date().toISOString(),
    });
    setTimeout(async () => {
      const report = { sessions: [], terminal: null, result: null };
      try {
        const st = aggregateState({ ignoreTravel: true });
        report.sessions = st.sessions.map((s) => ({ hostApp: s.hostApp, signal: s.signal }));
        report.terminal = await terminalForSessions(st.sessions);
        report.result = await knockNow();
      } catch (e) {
        report.error = e.stack || e.message;
      }
      // stderr, and a file: a GUI Electron process does not reliably deliver
      // stdout to a redirected shell.
      console.error('[demo knock]', JSON.stringify(report, null, 2));
      try { fs.writeFileSync(path.join(os.tmpdir(), 'claude-buddy-knock-demo.json'), JSON.stringify(report, null, 2)); } catch { /* ignore */ }
      setTimeout(() => app.quit(), 2500);
    }, 2000);
  }
}).catch((e) => {
  // Without this the app can come up half-initialised and simply sit there —
  // no widget, no tray, no polling, and nothing in the log to say why.
  console.error('[startup] failed:', e.stack || e.message);
});

// Same for anything that escapes a promise anywhere else: log it instead of
// letting it kill a listener silently.
process.on('unhandledRejection', (e) => console.error('[unhandled rejection]', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('[uncaught]', (e && e.stack) || e));

// ── --diag: what the app is actually costing, once a second ────────────────
function startDiag() {
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  every(1000, () => {
    const cpu = process.cpuUsage();
    const now = Date.now();
    const elapsedUs = Math.max(1, (now - lastAt) * 1000);
    const pct = ((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / elapsedUs) * 100;
    lastCpu = cpu; lastAt = now;
    const mem = process.memoryUsage();
    console.log('[diag] ' + JSON.stringify({
      cpuPct: Number(pct.toFixed(1)),
      heapMB: Number((mem.heapUsed / 1048576).toFixed(1)),
      rssMB: Number((mem.rss / 1048576).toFixed(1)),
      timers: liveTimers.size,
      windows: BrowserWindow.getAllWindows().length,
      sessionCache: sessionFileCache.size,
      overlay: !!overlayWin,
      garden: !!gardenRun,
      travel: !!travelLook,
    }));
  }, 'diag');
}

// ── Watchdog: a wedged or crashed renderer gets reloaded, not left frozen ──
function guardRenderer(w, name, recreate) {
  if (!w) return;
  w.webContents.on('unresponsive', () => {
    console.log(`[watchdog] ${name} unresponsive — reloading`);
    try { w.webContents.reloadIgnoringCache(); } catch { /* gone */ }
  });
  w.webContents.on('render-process-gone', (e, details) => {
    console.log(`[watchdog] ${name} render process gone:`, details.reason);
    if (w.isDestroyed()) { recreate?.(); return; }
    try { w.webContents.reloadIgnoringCache(); } catch { recreate?.(); }
  });
}

// Quitting must not be vetoed by the editor's unsaved-changes prompt.
app.on('before-quit', () => { flushStats(); lightsWin?.destroy(); settingsWin?.destroy(); });

app.on('activate', () => { if (!lightsWin && !settingsWin) win?.showInactive(); });

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
