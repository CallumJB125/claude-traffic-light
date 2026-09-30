const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen, clipboard, systemPreferences, nativeImage, dialog, net, powerMonitor, Notification, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const Rules = require('./rules.js');
const Adapters = require('./adapters/index.js');
const Stats = require('./stats.js');
const Usage = require('./usage.js');
const Spend = require('./spend.js');
const SessionState = require('./hooks/session-state.js');
const Agents = require('./agents.js');
const HostApp = require('./hostapp.js');
const Motion = require('./motion.js');
const Cameos = require('./cameos.js');
const McpInstall = require('./mcp-install.js');
const Setup = require('./setup.js');
const LeftoverShim = require('./src/leftover-shim.js');
const Help = require('./help.js');
const GitSignals = require('./src/github-signals.js');
const Voice = require('./src/voice.js');
const http = require('http');
const crypto = require('crypto');
const Terminal = require('./src/terminal.js')({ getSessions: () => aggregateState().sessions, getRootDir: () => ROOT_DIR, getLocalHost: () => LOCAL_HOST });
const {
  TERMINAL_APPS, escapeForAppleScript, activateTerminalApp, jumpToSession, isRemote, osa, frontmostApp,
  dockIconRect, clampToDisplay, runningProcessNames, terminalForSessions,
  runningTerminal, bounceOwnDock,
} = Terminal;

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
const IS_DEV_RUN = !!DEMO || process.argv.includes('--shot') || process.argv.includes('--shot-help') || process.argv.includes('--help-window') || process.argv.includes('--playtest') || process.argv.includes('--lights') || process.argv.includes('--buddy');

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

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const BOUNDS_FILE = path.join(ROOT_DIR, 'window-bounds.json');
const MANUAL_OVERRIDE_FILE = path.join(ROOT_DIR, 'manual-override.json');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

require('./src/logging.js').installFileLogging({ rootDir: ROOT_DIR, isDevRun: IS_DEV_RUN });

const DEFAULT_CONFIG = {
  workingStaleMinutes: 6,
  waitingStaleHours: 4,
  soundOnAmber: true,
  // macOS notifications for the states that matter when the widget is out of sight.
  notifyOnStates: true,
  notifyStates: { ...Help.NOTIFY_DEFAULTS },
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
  // Git and CI signals: on, but idle until `gh` is installed and logged in.
  gitSignals: true,
  gitRepos: [],
  gitDeployWorkflows: [],
  spend: { ...Spend.DEFAULTS },
  // Busy sources (F5): hold non-urgent pings while you're in a meeting or a Focus.
  busyHold: true,
  busyCalendar: false, // off until ticked in Settings, which is what asks macOS for access
  busyCalendarTitles: false,
  busyIcsUrl: '',
  busyFocus: true,
  busyFocusShortcut: '',
  voice: { ...Voice.DEFAULTS },
};
const REQUESTS_DIR = path.join(ROOT_DIR, 'requests');
const git = GitSignals.create({ stateFile: path.join(ROOT_DIR, 'git-signals.json'), log: (m) => console.log(m) });
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
  // Keys of removed features (the router, delegation) are dropped, so an old
  // config neither crashes nor carries them forward on the next save.
  const config = { ...DEFAULT_CONFIG, ...Setup.dropRemovedKeys(saved) };
  config.agentKinds = { ...DEFAULT_CONFIG.agentKinds, ...(saved.agentKinds && typeof saved.agentKinds === 'object' ? saved.agentKinds : {}) };
  config.notifyStates = { ...DEFAULT_CONFIG.notifyStates, ...(saved.notifyStates && typeof saved.notifyStates === 'object' ? saved.notifyStates : {}) };
  config.spend = Spend.normalize(saved.spend);
  config.voice = Voice.normalizeConfig(saved.voice);
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
  if (Array.isArray(saved.rules)) config.rules = Rules.migrateRules(config.rules, Number(saved.rulesVersion) || 0);
  config.rulesVersion = Rules.RULES_VERSION;
  config.presets = (Array.isArray(saved.presets) ? saved.presets : [])
    .filter((p) => p && typeof p.name === 'string' && Array.isArray(p.rules))
    .map((p) => ({ id: String(p.id || Rules.uid()), name: p.name.slice(0, 30), rules: Rules.migrateRules(p.rules.map(Rules.normalizeRule), Rules.rulesVersionOf(p)), rulesVersion: Rules.RULES_VERSION }));
  return config;
}

function saveConfig(partial) {
  const next = Setup.dropRemovedKeys({ ...loadConfig(), ...partial });
  if (partial.rules) next.rules = partial.rules.map(Rules.normalizeRule);
  // Presets reach here from loadConfig or Lights, so their rules are current.
  if (partial.presets) next.presets = partial.presets.map((p) => ({ ...p, rulesVersion: Rules.RULES_VERSION }));
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
const EMIT_SCRIPT = path.join(HOOKS_DIR, 'emit.js');
// Hooks run the app's own binary as Node (ELECTRON_RUN_AS_NODE), so a machine
// without node still lights up. An unpackaged dev run has no app binary worth
// pinning into agent configs and falls back to plain `node`.
const HOOK_RUNTIME = Adapters.Runtime.make({ execPath: app.isPackaged ? process.execPath : null, hooksDir: HOOKS_DIR, dataDir: ROOT_DIR });
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function claudeHookOpts() {
  return { home: os.homedir(), runtime: HOOK_RUNTIME, askFromWidget: !!loadConfig().askFromWidget };
}

function areHooksInstalled() {
  return Adapters.get('claude').isInstalled(claudeHookOpts());
}

// An unparsable settings.json is left alone rather than written over.
function installHooks() {
  try { Adapters.get('claude').install(claudeHookOpts()); } catch (err) { console.warn(`[hooks] ${CLAUDE_SETTINGS_PATH} not updated:`, err.message); }
}

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(REQUESTS_DIR, { recursive: true });

// ── Local endpoint: any local agent can POST a signal ──────────────────────
//   curl -X POST http://127.0.0.1:47172/signal -H 'content-type: application/json' \
//        -H "x-buddy-token: $(cat ~/.claude-traffic-light/token)" \
//        -d '{"source":"chatgpt","session":"abc","signal":"tool-use","tool":"Bash","cwd":"/x"}'
// Not for browsers: no CORS, and a request carrying an Origin (or a Host
// that isn't loopback — DNS rebinding) is refused, since /status lists every
// session's folder. POST also needs the per-install token, written 0600 next
// to the port file, so only something that can read your files can move a
// light.
const { SIGNAL_PORT, startSignalServer, readRequests, answerRequest } = require('./src/signal-server.js')({
  rootDir: ROOT_DIR,
  sessionsDir: SESSIONS_DIR,
  requestsDir: REQUESTS_DIR,
  aggregateState: (...a) => aggregateState(...a),
  broadcastStatus: (...a) => broadcastStatus(...a),
});

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
const LOCAL_HOST = os.hostname().split('.')[0];
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
// `unchangedSince` (an mtimeMs), the write is a merge onto what was read: it
// happens under the session lock the hooks take, and is skipped if someone
// else wrote the file after we read it (their write is newer than our merge)
// or holds the lock right now. Either way the next poll merges again.
function writeJsonAtomic(file, obj, unchangedSince = null) {
  if (unchangedSince == null) {
    SessionState.writeJsonAtomic(file, obj);
    return true;
  }
  const wrote = SessionState.withLockOrSkip(file, () => {
    if (fs.statSync(file).mtimeMs !== unchangedSince) return false;
    SessionState.writeJsonAtomic(file, obj);
    return true;
  });
  return wrote === true;
}

// A finished turn whose subagents are still working stays live for as long as
// they plausibly are (session-machine.js agentsStaleInMs).
const AGENT_KEEPALIVE_MS = Rules.AGENT_KEEPALIVE_MS;

// readSessions only hides stale files; this deletes them once no stale window
// could show them any more (a file's mtime is never older than the times it
// holds), with half a day's margin on top.
const SESSION_SWEEP_MARGIN_MS = 12 * 60 * 60 * 1000;
function sweepSessionFiles() {
  const c = loadConfig();
  const maxAge = Math.max(c.waitingStaleHours * 3600000 || 0, c.workingStaleMinutes * 60000 || 0, AGENT_KEEPALIVE_MS) + SESSION_SWEEP_MARGIN_MS;
  const removed = Agents.sweepStaleFiles(SESSIONS_DIR, maxAge);
  if (removed.length) console.log(`[sweep] removed ${removed.length} stale session file(s)`);
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
    const why = signal === 'turn-failed' ? ` [${data.failKind || 'error'}]` : '';
    console.log(`[state] ${sid.slice(0, 8)} ${tail} ${last ? last.signal : '—'} → ${signal}${why} (${source})${entry.skipped ? ` +${entry.skipped} unlogged` : ''}`);
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
      // The reader half of the session state machine (hooks/session-machine.js).
      const c = Rules.classifySession(data, { now, pendingIds, isGone: () => SessionState.processGone(data, LOCAL_HOST), workingStaleMs, waitingStaleMs });
      if (c.dropped === 'gone') logTransition(data, 'gone', 'process exited', now);
      if (c.held) wakeWhenHoldEnds(data, now);
      if (!c.live) continue;
      logTransition(data, c.presented, c.source, now);
      sessions.push(c.session);
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
const OVERRIDE_SIGNALS = { green: 'tool-use', amber: 'idle-nudge', red: 'limit-hit' };

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

// A dropped network otherwise only shows up as a failed turn, and Claude
// Code's idle nudge a minute later used to paper over even that.
let online = true;
function checkOnline() {
  const now = net.isOnline();
  if (now === online) return;
  online = now;
  console.log(online ? '[net] online again' : '[net] offline');
  stateMemo = { at: 0, key: null, value: null };
  broadcastStatus();
}

function aggregateState(opts = {}) {
  const key = `${!!opts.ignoreTravel}|${travelLook ? `${travelLook.name}:${travelLook.gardenAct}:${travelLook.pose}` : ''}|${previewLook ? previewLook.expiresAt : ''}`;
  if (stateMemo.value && stateMemo.key === key && Date.now() - stateMemo.at < 200) return stateMemo.value;
  const value = computeState(opts);
  // The active cameo's photo rides along with the look, so the widget, the
  // tray and the editor's live view render it without a file:// load.
  const photo = value.look && cameoPhotos()[value.look.cameo];
  if (photo) value.look = { ...value.look, cameoPhoto: photo };
  stateMemo = { at: Date.now(), key, value };
  return value;
}

// ── Photo cameos (cameos.js) ────────────────────────────────────────────────
const CAMEO_DIR = path.join(ROOT_DIR, 'cameos');
// The shipped built-in photos (scripts/build-cameos.py); the user's override them.
const CAMEO_BUILT_DIR = path.join(__dirname, 'assets', 'cameos', 'built');
// id → { id, rev, name, shape, eyes, mouth, src (data: URL) }, read once per change.
let cameoCache = null;
function cameoPhotos() {
  if (cameoCache) return cameoCache;
  cameoCache = {};
  for (const dir of [CAMEO_BUILT_DIR, CAMEO_DIR]) {
    for (const [id, e] of Object.entries(Cameos.loadIndex(dir))) {
      try { cameoCache[id] = { id, rev: e.addedAt, name: e.name, shape: e.shape, eyes: e.eyes, mouth: e.mouth, src: Cameos.photoDataUrl(dir, id) }; } catch { /* unreadable: the next source, the drawing, or none */ }
    }
  }
  return cameoCache;
}
function cameoListing() {
  const photos = cameoPhotos();
  return Cameos.listing(Cameos.loadIndex(CAMEO_DIR), Cameos.loadIndex(CAMEO_BUILT_DIR)).map((c) => ({ ...c, src: photos[c.id]?.src || null }));
}
function cameosChanged() {
  cameoCache = null;
  stateMemo = { at: 0, key: null, value: null };
  broadcastStatus();
  return cameoListing();
}

function computeState(opts = {}) {
  const config = loadConfig();
  const requests = readRequests();
  const sessions = readSessions(config, requests.map((r) => r.sessionId));
  const pending = config.askFromWidget ? requests : [];
  const tasks = config.showTasks ? sumTasks(sessions.filter((s) => !WAITING_SIGNALS.has(s.signal) && s.signal !== 'idle-nudge')) : null;
  if (previewLook && Date.now() < previewLook.expiresAt) {
    return { look: previewLook.look, reason: 'preview', sessions, fired: [], pending: [], tasks: null };
  }
  if (travelLook && !opts.ignoreTravel) {
    return { look: { ...travelLook, tasks }, reason: 'travel', sessions, fired: [], pending, tasks, away: BusyWatch.recap() };
  }
  const override = readManualOverride();
  if (override) {
    const synthetic = [{ signal: OVERRIDE_SIGNALS[override.state] || 'idle', cwd: '' }];
    const { look, fired, owned } = Rules.resolve(config.rules, synthetic);
    return { look: { ...look, tasks }, reason: 'manual', sessions, fired, owned, firedNames: Rules.firedNames(config.rules, fired, owned), pending, tasks };
  }
  // A pending permission request is the "Needs your input" state, whatever
  // the session files say (the hook blocks before Notification fires). It
  // replaces the look only; the chips, number and season still apply.
  const spend = spendSnapshot(config);
  const env = { offline: !online, ...BusyWatch.env(), git: config.gitSignals !== false ? git.active() : [], spend };
  const { look, fired, owned } = pending.length
    ? Rules.resolve(config.rules, [{ signal: 'permission-ask', cwd: pending[0].cwd }], Date.now(), env)
    : Rules.resolve(config.rules, sessions, Date.now(), env);
  const agentCount = Rules.liveAgents(sessions).length;
  if (config.seasonal) {
    if (look.costume === 'none') look.costume = Rules.seasonalCostume() || 'none';
    if (look.effect === 'none') look.effect = Rules.seasonalEffect() || 'none';
  }
  const minions = config.showAgents ? Rules.filterAgentKinds(Rules.liveAgents(sessions), config.agentKinds).slice(0, 32) : [];
  return { look: { ...withNumber(look, sessions, tasks), tasks, minions, agentRoster: config.agentRoster !== false, agentChipSize: config.agentChipSize }, reason: sessions.length ? 'session' : 'idle', sessions, fired, owned, firedNames: Rules.firedNames(config.rules, fired, owned), tool: currentTool(sessions), agentCount, pending, tasks, minions, spend, spendNote: spendNote(config.rules, fired, sessions, spend), away: BusyWatch.recap(), busy: BusyWatch.holding() };
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
const { playSound, speak } = require('./src/sound.js')({ getWin: () => win });

// ── Busy / free (F5) ────────────────────────────────────────────────────────
// Calendar, ICS and Focus decide whether you're busy; while you are, pings
// (sounds, notifications, knocks) wait unless the rule behind them lets them
// through, and the lamps carry on as normal. src/busy-watch.js has the rest.
const BusyWatch = require('./src/busy-watch.js')({
  rootDir: ROOT_DIR,
  home: os.homedir(),
  helperPath: app.isPackaged ? path.join(process.resourcesPath, 'calendar-helper', 'buddy-calendar') : path.join(__dirname, 'native', 'bin', 'buddy-calendar'),
  loadConfig,
  isDevRun: IS_DEV_RUN,
  fakeFile: IS_DEV_RUN ? process.env.CLAUDE_BUDDY_FAKE_BUSY || null : null,
  tickMs: IS_DEV_RUN && Number(process.env.CLAUDE_BUDDY_BUSY_TICK_MS) ? Number(process.env.CLAUDE_BUDDY_BUSY_TICK_MS) : undefined,
  exec: (file, args, timeout) => new Promise((resolve, reject) => execFile(file, args, { timeout }, (err, out) => (err ? reject(err) : resolve(out)))),
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  writeFile: (f, text) => { fs.mkdirSync(ROOT_DIR, { recursive: true }); fs.writeFileSync(f, text); },
  removeFile: (f) => fs.rmSync(f, { force: true }),
  exists: (f) => fs.existsSync(f),
  fetch: (url) => net.fetch(url),
  log: (...a) => console.log(...a),
  onChange: () => { stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); },
});

// Whether a ping from this rule may sound now. Not busy: always.
// Every ping that waits is noted by rule and signal for the recap; any
// feature with a ping of its own (a budget warning, say) goes through here.
function pingAllowed(ruleId, opts = {}) {
  if (!BusyWatch.holding()) return true;
  const rule = loadConfig().rules.find((r) => r.id === ruleId);
  if (Rules.pingsWhileBusy(rule, opts)) return true;
  BusyWatch.noteHeld(rule ? rule.name : null, opts.signal || firedSignal(rule));
  return false;
}
// Which of a rule's signals is live right now (a virtual one, like
// long-running, isn't in the session list: then its first signal).
function firedSignal(rule) {
  if (!rule) return null;
  const live = new Set(aggregateState({ ignoreTravel: true }).sessions.map((s) => s.signal));
  return rule.when.signal.find((x) => live.has(x)) || rule.when.signal[0] || null;
}
// A notification kind is a signal; the first enabled rule listening for it
// decides, so "Needs your input" follows that rule's busy setting.
function notificationAllowed(n) {
  if (!BusyWatch.holding()) return true;
  const rule = Rules.orderedRules(loadConfig().rules).find((r) => r.enabled && r.when.signal.includes(n.kind));
  const ok = rule ? Rules.pingsWhileBusy(rule, { session: n.session }) : n.kind !== 'turn-failed';
  if (!ok) BusyWatch.noteHeld(rule ? rule.name : n.title, n.kind);
  return ok;
}

// The recap as the widget and the summary notification show it.
function showAwayRecap(recap) {
  console.log(`[busy] back — ${recap.headline}`);
  const config = loadConfig();
  if (IS_DEV_RUN || config.notifyOnStates === false || !Notification.isSupported()) return;
  const note = new Notification({ title: 'While you were away', body: recap.headline, silent: true });
  liveNotifications.add(note);
  note.on('click', () => { liveNotifications.delete(note); openAwayItem(0); });
  note.on('close', () => liveNotifications.delete(note));
  note.show();
}
async function openAwayItem(i) {
  const recap = BusyWatch.recap();
  const item = recap && recap.items[Number(i) || 0];
  if (!item) return { opened: 'none' };
  if (item.cwd) clipboard.writeText(item.cwd);
  const activated = await activateTerminalApp(item.folder, item.hostApp || undefined);
  return { opened: activated?.app || 'none-found', folder: item.folder };
}
ipcMain.handle('away-open', (_e, i) => openAwayItem(i));
ipcMain.handle('away-dismiss', () => { BusyWatch.dismiss(); stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); });
ipcMain.handle('busy-status', () => BusyWatch.status());
// Settings' "Reconnect calendar": macOS forgot an earlier grant, so ask again.
ipcMain.handle('busy-reconnect-calendar', async () => { await BusyWatch.enableCalendar(); return BusyWatch.status(); });
ipcMain.handle('busy-open-privacy', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'));

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
  win.on('move', () => { if (!glideTimer) saveBounds(); });
  // backgroundThrottling is off, so the page never learns it's hidden: tell
  // it, so the rig's clocks (idle loops, blinks) stop while nobody can see.
  const visibility = (on) => () => { if (win && !win.isDestroyed()) win.webContents.send('visibility', on); };
  win.on('show', visibility(true));
  win.on('restore', visibility(true));
  win.on('hide', visibility(false));
  win.on('minimize', visibility(false));
  // Those only fire on a change; a widget that loads hidden (showWidget off)
  // would otherwise run its clocks until its first hide.
  win.webContents.on('did-finish-load', () => { if (win && !win.isDestroyed()) visibility(win.isVisible() && !win.isMinimized())(); });
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
    if (process.platform === 'darwin' && !lightsWin && !buddyWin?.isOpen()) app.dock.hide();
  });
}

// The Buddy main window (board, views, integrations…): buddy-window/.
const { createBuddyWindow } = require('./buddy-window');
let buddyWin = null;
function openBuddy(page = null) {
  if (!buddyWin) {
    buddyWin = createBuddyWindow({
      openWindow: (which) => {
        if (which === 'lights') createLightsWindow();
        else if (which === 'settings') createSettingsWindow();
        else if (which === 'mix') { createLightsWindow(); lightsWin?.webContents.once('did-finish-load', () => lightsWin?.webContents.send('show-view', 'mix')); lightsWin?.webContents.send('show-view', 'mix'); }
      },
      onClosed: () => { if (IS_MAC && !lightsWin && !settingsWin) app.dock.hide(); },
    });
  }
  if (IS_MAC) app.dock.show();
  buddyWin.open(page);
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
  for (const k of ['costume', 'cameo', 'body', 'effect', 'pet', 'eyes', 'event', 'scroll', 'lampfx', 'sign', 'shape', 'signfx', 'number', 'speed']) if (arg(`--${k}`)) query[k] = arg(`--${k}`);
  // `--fast-smoke <ms>` (with --pose smoke) shortens each cigarette from 5 min
  // to <ms> so the flick/stomp/relight can be captured; dev captures only.
  if (arg('--fast-smoke')) query.fastSmoke = arg('--fast-smoke');
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
          const script = fs.readFileSync(arg('--playtest-script') || path.join(__dirname, 'test', 'playtest.js'), 'utf8');
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
    if (process.platform === 'darwin' && !settingsWin && !buddyWin?.isOpen()) app.dock.hide();
  });
}

// ── Help: "what am I looking at?" ──────────────────────────────────────────
// A small panel beside the widget that explains the current state in plain
// words. Opened from the widget's "?" and the tray; once on first run.
let helpWin = null;

function createHelpWindow() {
  if (helpWin) {
    helpWin.show();
    helpWin.focus();
    return;
  }
  const W = 340, H = 520;
  const wb = win?.getBounds();
  const wa = screen.getDisplayMatching(wb || { x: 0, y: 0, width: 1, height: 1 }).workArea;
  // Beside the widget, on whichever side has room.
  const x = wb ? (wb.x - W - 12 >= wa.x ? wb.x - W - 12 : Math.min(wb.x + wb.width + 12, wa.x + wa.width - W)) : wa.x + wa.width - W - 40;
  const y = wb ? Math.max(wa.y, Math.min(wb.y, wa.y + wa.height - H)) : wa.y + 80;
  helpWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(x),
    y: Math.round(y),
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'What is Claude doing?',
    backgroundColor: '#1c1a1f',
    webPreferences: {
      preload: path.join(__dirname, 'help-preload.js'),
      contextIsolation: true,
    },
  });
  helpWin.setMenuBarVisibility(false);
  helpWin.loadFile('help.html');
  // Dev: `--shot-help out.png` captures the panel and quits.
  const shotAt = process.argv.indexOf('--shot-help');
  if (shotAt > 0 && process.argv[shotAt + 1]) {
    helpWin.webContents.once('did-finish-load', () => setTimeout(async () => {
      fs.writeFileSync(process.argv[shotAt + 1], (await helpWin.webContents.capturePage()).toPNG());
      console.log('[shot] help', JSON.stringify(helpState()));
      app.quit();
    }, 1500));
  }
  helpWin.on('closed', () => { helpWin = null; });
}

function helpState() {
  const real = aggregateState({ ignoreTravel: true });
  return Help.explain(real, loadConfig().rules, { travel: travelLook ? travelLook.name : null, busy: BusyWatch.status() });
}

ipcMain.handle('open-help', createHelpWindow);
ipcMain.handle('get-help', () => helpState());

function maybeAutoShowHelp() {
  const marker = path.join(ROOT_DIR, Help.MARKER);
  if (!Help.shouldAutoShow({ markerExists: fs.existsSync(marker), devRun: IS_DEV_RUN })) return;
  try {
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) { console.warn('[help] could not write the first-run marker:', e.message); }
  createHelpWindow();
}

// ── Notifications for states that need you ─────────────────────────────────
// Help.notifications decides (once per state entry); this only shows them.
let notifyKeys = null;
const liveNotifications = new Set(); // held so a click still reaches its handler after GC
function maybeNotify(st) {
  // A preview empties the pending list; skipping it keeps that from reading as a new ask.
  if (st.reason === 'preview') return;
  const { keys, fire } = Help.notifications(notifyKeys, { sessions: st.sessions, pending: st.pending, offline: !online, spend: st.spend }, loadConfig());
  notifyKeys = keys;
  for (const n of fire) {
    if (!notificationAllowed({ ...n, session: st.sessions.find((s) => n.key.endsWith(`:${s.sessionId}`)) || null })) { console.log(`[notify] held while busy: ${n.key}`); continue; }
    console.log(`[notify] ${n.key} — ${n.title}`);
    if (IS_DEV_RUN || !Notification.isSupported()) continue;
    // Silent: the widget's own sound channel already speaks for these states.
    const stop = n.kind === 'runaway' ? runawayStoppers.get(n.sessionId) : null;
    const note = new Notification({ title: n.title, body: n.body, silent: true, ...(stop ? { actions: [{ type: 'button', text: 'Stop session' }] } : {}) });
    liveNotifications.add(note);
    if (stop) note.on('action', () => { liveNotifications.delete(note); Promise.resolve().then(stop).catch((err) => console.warn('[spend] stop failed:', err.message)); });
    note.on('click', () => {
      liveNotifications.delete(note);
      // A runaway's whole point is the jump, so it goes even without a known host app.
      const s = n.sessionId ? aggregateState().sessions.find((x) => x.sessionId === n.sessionId) : null;
      // Another machine's session: nothing on this Mac to jump to.
      if (isRemote(s) || isRemote({ sessionId: n.sessionId })) return;
      if (n.hostApp || n.kind === 'runaway') {
        jumpToSession(s, String(n.cwd || '').split('/').filter(Boolean).pop() || '', n.hostApp).catch((err) => console.warn('[jump] failed:', err.message));
      }
    });
    note.on('close', () => liveNotifications.delete(note));
    note.show();
  }
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
  // A replaced overlay lingers ~2.5 s while it fades; its events must not act
  // on its successor (a stale 'closed' orphaned the new window, a stale
  // 'ready-to-show' started a second set of timers on it).
  const w = overlayWin;
  w.once('ready-to-show', () => {
    if (overlayWin !== w) return;
    w.showInactive();
    w.setBounds(m.display.bounds);
    if (gun) aimTimer = every(120, pushAim, 'aim');
    if (gun === 'ak47') { fireBurst(); burstTimer = every(BURST_EVERY_MS, fireBurst, 'burst'); }
    else if (gun === 'sniper') { fireSnipe(); snipeTimer = every(SNIPE_EVERY_MS, fireSnipe, 'snipe'); }
    if (overlayFx !== 'none') pushScreenFx(overlayFx);
  });
  // If the overlay's renderer dies, tear the whole thing down rather than
  // leaving a transparent always-on-top window with a dead canvas on screen.
  guardRenderer(w, 'overlay', () => { if (overlayWin === w) stopOverlay(); });
  w.on('closed', () => { if (overlayWin === w) overlayWin = null; });
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
  const key = JSON.stringify([look.lamp, look.lampColor, look.lampFx, look.eyes, look.pose, look.costume, look.cameo, look.cameoPhoto?.rev, look.body, look.number]);
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
  helpWin?.webContents.send('status-changed');
  try {
    const st = aggregateState();
    const recap = BusyWatch.observe(st.sessions);
    if (recap) { stateMemo = { at: 0, key: null, value: null }; showAwayRecap(recap); }
    maybeNotify(st);
    updateOverlay(st.look);
    applyStrip(!!(st.pending && st.pending.length) && !travelLook, !!st.away && !travelLook);
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

// The renderer reports prefers-reduced-motion; while it holds, travel snaps
// to its destination (keeping the pacing) and nothing roams, hops or glides.
let reducedMotion = false;

const easeInOutQuad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

// `at(p)` overrides the path (default: eased straight line from → to).
function tween(from, to, ms, onStep, at = null) {
  const nums = [from?.x, from?.y, to?.x, to?.y, ms];
  if (!nums.every(Number.isFinite)) { console.log('[tween] skipped, non-finite input', JSON.stringify({ from, to, ms })); return Promise.resolve(); }
  stopGlide();
  const pointAt = at || ((p) => { const e = easeInOutQuad(p); return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }; });
  if (reducedMotion) {
    try { onStep({ x: Math.round(to.x), y: Math.round(to.y) }); } catch (err) { console.log('[tween] step failed:', err.message); }
    return wait(ms);
  }
  return new Promise((resolve) => {
    const t0 = Date.now();
    // A tween that outlives its window (quit, crash, reload) must not keep a
    // 60 Hz interval alive forever, and a throwing step must still clear it.
    const id = every(16, () => {
      if (!win || win.isDestroyed()) { stopTimer(id); resolve(); return; }
      const p = Math.min(1, (Date.now() - t0) / ms);
      try {
        const pt = pointAt(p);
        onStep({ x: Math.round(pt.x), y: Math.round(pt.y) });
      } catch (err) {
        console.log('[tween] step failed:', err.message);
        stopTimer(id); resolve(); return;
      }
      if (p >= 1) { stopTimer(id); resolve(); }
    }, 'tween');
  });
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
    // hop up off the icon and land back on it: one gravity arc, then a squash;
    // the sign lags the take-off and swings on the landing
    const hop = Motion.MOTION.hop;
    if (reducedMotion) await wait(hop.ms);
    else {
      if (win && !win.isDestroyed()) win.webContents.send('sway', -0.6 * Motion.MOTION.pendulum.kick);
      await tween(target, target, hop.ms, (pt) => win?.setPosition(pt.x, pt.y), (p) => ({ x: target.x, y: target.y - Motion.hopHeight(p, hop.height) }));
      if (win && !win.isDestroyed()) win.webContents.send('land', 0.6);
    }
    await wait(hop.gapMs);
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
    // The sign trails the run at its average speed, and swings when it stops.
    const runSpeed = (target.x - home.x) / 1.4;
    sendLean(runSpeed);
    await tween({ x: home.x, y: home.y }, target, 1400, (pt) => win?.setPosition(pt.x, pt.y));
    sendLean(0);
    await performKnock(appName, target, base);
    travelLook = { ...base, pose: 'run', facing: facing === 'left' ? 'right' : 'left', aimAngle: 0, name: 'Running home' };
    broadcastStatus();
    sendLean(-runSpeed);
    await tween(target, { x: home.x, y: home.y }, 1400, (pt) => win?.setPosition(pt.x, pt.y));
    sendLean(0);
    return { ok: true, app: appName, icon: { x: icon.x, y: icon.y, w: icon.w, h: icon.h, hidden: !!icon.hidden } };
  } catch (e) {
    // Whatever went wrong, the widget must not be left mid-walk.
    console.log('[roam] failed:', e.stack || e.message);
    return { ok: false, why: e.message };
  } finally {
    travelLook = null;
    sendLean(0);
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
  if (!IS_MAC || !config.roam || reducedMotion || !win || !win.isVisible() || roamState.busy || previewLook || gardenRun) return;
  const waiting = st.pending?.length || st.sessions.some((s) => WAITING_SIGNALS.has(s.signal));
  if (!waiting) { roamState.waitingSince = null; return; }
  if (!roamState.waitingSince) roamState.waitingSince = Date.now();
  const due = roamState.lastKnock === 0 || Date.now() - roamState.lastKnock > 10 * 60 * 1000;
  if (!due) return;
  // A knock is a ping: while you're busy only the lamp owner's rule can send
  // one. Noted once per waiting spell, not on every broadcast.
  if (BusyWatch.holding()) {
    const rule = loadConfig().rules.find((r) => r.id === (st.owned && st.owned.lamp));
    if (!Rules.pingsWhileBusy(rule, { lamp: st.look.lamp })) {
      if (roamState.heldFor !== roamState.waitingSince) { roamState.heldFor = roamState.waitingSince; BusyWatch.noteHeld(rule ? `${rule.name} (knock)` : 'Knock', firedSignal(rule)); }
      return;
    }
  }
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
    { label: 'Open Buddy…', accelerator: 'CmdOrCtrl+B', click: () => openBuddy() },
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
    { label: 'What does this mean?…', click: createHelpWindow },
    { label: 'Lights…', accelerator: 'CmdOrCtrl+L', click: createLightsWindow },
    { label: 'Model mix…', click: () => { createLightsWindow(); lightsWin?.webContents.once('did-finish-load', () => lightsWin?.webContents.send('show-view', 'mix')); lightsWin?.webContents.send('show-view', 'mix'); } },
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

ipcMain.handle('cursor-in-window', () => {
  if (!win || win.isDestroyed()) return null;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return { x: c.x - b.x, y: c.y - b.y };
});
ipcMain.handle('get-window-position', () => {
  const [x, y] = win?.getPosition() || [0, 0];
  return { x, y };
});

ipcMain.on('set-window-position', (e, x, y) => {
  stopGlide();
  win?.setPosition(Math.round(x), Math.round(y));
});

// ── Drag release: coast on the flick's momentum, then land ─────────────────
// A spring per axis from the release point, seeded with the pointer's
// velocity, toward where that flick would coast. The work-area edges are
// walls: a glide that reaches one squashes against it and bounces back a
// little (MOTION.edge.restitution) instead of stopping dead, and the walls,
// not the target, are what keep it on screen.
let glideTimer = null;
function stopGlide() { glideTimer = stopTimer(glideTimer); }

function glideFrom(vx, vy) {
  stopGlide();
  if (!win || win.isDestroyed() || gardenRun || roamState.busy) return false;
  const G = Motion.MOTION.glide;
  const E = Motion.MOTION.edge;
  const speed = Math.hypot(vx, vy);
  // slower than minSpeed is a placement, not a throw
  if (reducedMotion || !Number.isFinite(speed) || speed < G.minSpeed) return false;
  const k = Math.min(1, G.maxSpeed / speed);
  const v = { x: vx * k, y: vy * k };
  const b = win.getBounds();
  const target = { x: b.x + Motion.project(v.x, G.decel), y: b.y + Motion.project(v.y, G.decel) };
  const fit = HostApp.clampRectToDisplays({ x: target.x, y: target.y, w: b.width, h: b.height }, screen.getAllDisplays());
  const wa = fit.display ? fit.display.workArea : null;
  // Widened to wherever the widget already is, so one parked half off an
  // edge is neither pushed further out nor yanked back in.
  const walls = wa ? {
    x: [Math.min(wa.x, b.x), Math.max(wa.x + wa.width - b.width, b.x)],
    y: [Math.min(wa.y, b.y), Math.max(wa.y + wa.height - b.height, b.y)],
  } : null;
  const spring = Motion.springParams(G.response, G.damping);
  const axes = [{ s: { x: b.x, v: v.x }, key: 'x', sides: ['left', 'right'] }, { s: { x: b.y, v: v.y }, key: 'y', sides: ['top', 'bottom'] }];
  let last = Date.now();
  glideTimer = every(16, () => {
    if (!win || win.isDestroyed()) { stopGlide(); return; }
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    for (const a of axes) {
      a.s = Motion.springStep(a.s, target[a.key], dt, spring);
      if (!walls) continue;
      const [lo, hi] = walls[a.key];
      const impactSpeed = Math.abs(a.s.v);
      const hit = Motion.bounceAxis(a.s, lo, hi, E.restitution);
      if (!hit.hit) continue;
      a.s = { x: hit.x, v: hit.v };
      target[a.key] = Math.min(hi, Math.max(lo, Motion.reboundTarget(hit.x, hit.v, G.decel, E.maxRebound)));
      const strength = Math.min(1, impactSpeed / 2000);
      if (strength > 0.05 && !win.isDestroyed()) win.webContents.send('impact', a.sides[hit.hit > 0 ? 1 : 0], strength);
    }
    const [ax, ay] = axes;
    const done = Motion.springSettled(ax.s, target.x) && Motion.springSettled(ay.s, target.y);
    try { win.setPosition(Math.round(done ? target.x : ax.s.x), Math.round(done ? target.y : ay.s.x)); } catch { stopGlide(); return; }
    if (done) {
      stopGlide();
      saveBounds();
      if (!win.isDestroyed()) win.webContents.send('land', Math.min(1, Math.max(0.35, speed / 2000)));
    }
  }, 'glide');
  return true;
}

// The sign on the widget trails body motion the renderer can't see (the run
// to the Dock): vx px/s, 0 when it stops.
function sendLean(vx) {
  if (!reducedMotion && win && !win.isDestroyed()) win.webContents.send('lean', vx);
}

// ── Eyes: follow the cursor ────────────────────────────────────────────────
// Sampled here (the renderer only sees the cursor over its own window) and
// sent only when the whole-unit offset changes. A cursor at rest for
// MOTION.eyes.holdMs gets the eyes back to straight ahead, so a still desk
// (or a test run) always shows the same face.
let eyeLast = null;
let eyeMovedAt = 0;
let eyeSent = '0,0';
function eyeTick() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const E = Motion.MOTION.eyes;
  const p = screen.getCursorScreenPoint();
  const now = Date.now();
  const moved = eyeLast && Math.abs(p.x - eyeLast.x) + Math.abs(p.y - eyeLast.y) > 2;
  eyeLast = p;
  if (moved) eyeMovedAt = now;
  let off = { x: 0, y: 0 };
  if (!reducedMotion && eyeMovedAt && now - eyeMovedAt < E.holdMs) {
    // the eyes sit at (32, 45.75) of the 64×82 rig, inside the 12px padding
    const b = win.getBounds();
    off = Motion.eyeOffset(p.x - (b.x + b.width / 2), p.y - (b.y + 12 + ((b.height - 24) * 45.75) / 82), E.range, E.deadzone);
  }
  const key = `${off.x},${off.y}`;
  if (key === eyeSent) return;
  eyeSent = key;
  win.webContents.send('eyes', off.x, off.y);
}

ipcMain.on('drag-start', () => stopGlide());
ipcMain.on('drag-end', (e, vx, vy) => {
  if (glideFrom(Number(vx), Number(vy))) return;
  saveBounds();
  if (!reducedMotion && win && !win.isDestroyed()) win.webContents.send('land', 0.3);
});
ipcMain.on('reduced-motion', (e, on) => {
  reducedMotion = !!on;
  if (reducedMotion) stopGlide();
});

// The widget window is a transparent rectangle; the renderer reports whether
// the cursor is over something drawn so clicks on empty space fall through.
ipcMain.on('set-click-through', (e, ignore) => {
  try { win?.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch { /* window gone */ }
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
  const activated = await jumpToSession(target, folderHint);
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
  try { return commitConfig(partial); } catch (err) {
    console.warn('[save-config]', err.message);
    return { error: `Could not save: ${err.message}` };
  }
});
// saveConfig plus everything a changed setting has to reach outside config.json.
function commitConfig(partial) {
  const prev = loadConfig();
  const before = prev.askFromWidget;
  const next = saveConfig(partial);
  if ('askFromWidget' in partial && !!partial.askFromWidget !== !!before) installHooks();
  if (partial.busyCalendar === true && !prev.busyCalendar) BusyWatch.enableCalendar().catch((err) => console.warn('[busy]', err.message));
  if ('showWidget' in partial) applyWidgetVisibility();
  if ('menuBarMode' in partial || 'showWidget' in partial) createTray();
  if ('voice' in partial) applyVoiceHotkey();
  broadcastStatus();
  return next;
}

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
  // never lags the Model mix; only a ccusage result is held for 5 minutes.
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
  // Model mix; ccusage is only asked when there are no transcripts to read.
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

// ── Usage: per-turn tokens read from the transcripts themselves ───────────
const USAGE_TTL_MS = 60 * 1000;
// The visual tests point this at a fixture folder; everyone else reads Claude Code's.
const PROJECTS_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_PROJECTS || null;
const usageFileCache = new Map();
let usageMemo = { at: 0, turns: null };
let usageInFlight = null;
async function refreshUsage() {
  const t0 = Date.now();
  // 61 days covers the Stats page's 60-day lookback.
  const r = await Usage.readTurns({ since: Date.now() - 61 * 86400000, cache: usageFileCache, ...(PROJECTS_DIR ? { root: PROJECTS_DIR } : {}) });
  const ms = Date.now() - t0;
  // Live refreshes follow every burst of hook activity; only the first pass
  // and a slow one are worth a line.
  if (!usageMemo.turns || ms > 1000) console.log(`[usage] parsed ${r.parsed} files in ${ms} ms (${r.files} transcripts, ${r.turns.length} turns${r.skipped.length ? `, ${r.skipped.length} over the size cap` : ''})`);
  usageMemo = { at: Date.now(), turns: r.turns };
  return r.turns;
}
function getUsageTurns() {
  if (usageMemo.turns && Date.now() - usageMemo.at < USAGE_TTL_MS) return Promise.resolve(usageMemo.turns);
  if (usageInFlight) return usageInFlight;
  usageInFlight = refreshUsage().finally(() => { usageInFlight = null; });
  return usageInFlight;
}

// The Model mix card: read-only — which models your turns ran on, what they
// cost, one recommendation line, and a note if an old router shim is still
// in a shell rc (never edited from here).
ipcMain.handle('model-mix', async () => ({ ...Usage.modelMix(await getUsageTurns()), leftoverShim: LeftoverShim.detect({ home: os.homedir(), env: process.env, root: ROOT_DIR }) }));

// Hook activity is what moves spend, so each burst of it gets a fresh read
// once something has asked for usage. The reader is incremental — a warm
// pass over ~500 transcripts measured 16 ms — so the floor between reads
// only has to absorb bursts.
const USAGE_LIVE_MS = 3000;
function refreshUsageLive() {
  if (!usageMemo.turns || usageInFlight || Date.now() - usageMemo.at < USAGE_LIVE_MS) return;
  usageInFlight = refreshUsage().finally(() => { usageInFlight = null; });
  usageInFlight.catch((err) => console.warn('[usage] live refresh failed:', err.message));
}

// ── F1 spend: budgets and runaway sessions (spend.js) ─────────────────────
// Its own transcript read, this week only, in a worker thread with its own
// incremental cache: the main thread only receives turns when a file
// changed. Nothing here ever types into a terminal or stops a session you
// started.
let spendTurns = { version: 0, turns: null };
let spendWorker = null; // null: not started; false: unavailable, read inline
const spendFileCache = new Map();
const spendPending = new Map();
let spendReqId = 0;
function spendRead(since) {
  if (spendWorker === null) {
    try {
      spendWorker = new Worker(path.join(__dirname, 'src', 'usage-worker.js'));
      spendWorker.unref();
      spendWorker.on('message', (m) => { const p = spendPending.get(m.id); spendPending.delete(m.id); if (p) (m.error ? p.reject(new Error(m.error)) : p.resolve(m)); });
      spendWorker.on('error', (err) => {
        console.warn('[spend] worker failed, reading inline:', err.message);
        spendWorker = false;
        for (const p of spendPending.values()) p.reject(err);
        spendPending.clear();
      });
    } catch (err) {
      console.warn('[spend] no worker, reading inline:', err.message);
      spendWorker = false;
    }
  }
  if (spendWorker === false) return Usage.readTurns({ since, cache: spendFileCache, ...(PROJECTS_DIR ? { root: PROJECTS_DIR } : {}) }).then((r) => ({ turns: r.turns, parsed: r.parsed, unchanged: false }));
  const id = ++spendReqId;
  return new Promise((resolve, reject) => {
    spendPending.set(id, { resolve, reject });
    spendWorker.postMessage({ id, root: PROJECTS_DIR, since });
  });
}
let spendInFlight = null;
let spendReadAt = 0;
const SPEND_POLL_MS = 15000;
const SPEND_LIVE_MS = 3000;
function refreshSpend(minGap = SPEND_POLL_MS - 1000) {
  if (spendInFlight || Date.now() - spendReadAt < minGap) return;
  const t0 = Date.now();
  spendInFlight = spendRead(Spend.readSince(loadConfig().spend))
    .then((r) => {
      spendReadAt = Date.now();
      if (!spendTurns.turns || Date.now() - t0 > 1000) console.log(`[spend] read ${r.parsed} files in ${Date.now() - t0} ms${spendWorker ? ' (worker)' : ''}`);
      if (r.unchanged && spendTurns.turns) return;
      spendTurns = { version: spendTurns.version + 1, turns: r.turns };
      stateMemo = { at: 0, key: null, value: null };
      broadcastStatus();
    })
    .catch((err) => { spendReadAt = Date.now(); console.warn('[spend] refresh failed:', err.message); })
    .finally(() => { spendInFlight = null; });
}
// Memoized per turns version, spend settings and minute, with the runaway
// latch carried between recomputes (one notification per episode).
const spendTracker = Spend.tracker();
// The visual tests hand in a snapshot they priced against a fixed clock, so a
// baseline never waits on the refresh or on how many minutes have passed.
const SPEND_FIXTURE = DEMO === 'visual' ? path.join(ROOT_DIR, 'spend-snapshot.json') : null;
function spendSnapshot(config) {
  if (SPEND_FIXTURE && fs.existsSync(SPEND_FIXTURE)) return JSON.parse(fs.readFileSync(SPEND_FIXTURE, 'utf8'));
  return spendTurns.turns ? spendTracker.snapshot(spendTurns.turns, spendTurns.version, config.spend) : null;
}
// What the tooltip adds after the spend rule that fired: the burn rate or
// how far over budget.
function spendNote(rules, fired, sessions, spend) {
  if (!spend) return null;
  for (const id of fired) {
    const rule = rules.find((r) => r.id === id);
    const sig = rule ? rule.when.signal : [];
    if (sig.includes('runaway')) {
      const v = Rules.spendSessions(sessions, { spend }).find((x) => x.signal === 'runaway');
      if (v) return { rule: rule.name, text: `${v.burn}${v.cwd ? ` in ${v.cwd.split('/').filter(Boolean).pop()}` : ''}` };
    }
    if ((sig.includes('budget-exceeded') || sig.includes('budget-warning')) && spend.budgetText) return { rule: rule.name, text: spend.budgetText };
  }
  return null;
}
// Hook point for the board runner (later): a runner that spawned a session
// registers `sessionId → stop()` here, and that session's runaway
// notification gets a Stop button that calls it (killing the supervised
// process). Interactive sessions never register, so they only ever get the
// notification and the jump to their terminal.
const runawayStoppers = new Map();
ipcMain.handle('get-spend', () => {
  const snap = spendSnapshot(loadConfig());
  return snap ? { ...snap, latch: undefined } : null;
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
      const a = await jumpToSession(target, folderHint);
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
  const activated = await jumpToSession(target, folderHint);
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

// ── Voice: push-to-talk questions (F7 step 1, src/voice.js) ──────────────────
// Hold the hotkey (none until picked in Preferences) or press and hold the
// widget; the on-device helper turns the question into text, Buddy answers
// out loud and his mouth moves while he talks. Questions only: nothing here
// changes any state. The mic is only open while the key or the press is held,
// and the widget shows a mic badge the whole time.
const VOICE_HELPER = app.isPackaged ? path.join(process.resourcesPath, 'voice', 'buddy-listen') : path.join(__dirname, 'native', 'voice', 'build', 'buddy-listen');
const McpServer = require('./mcp-server.js');
const sendVoice = (st) => win?.webContents.send('voice-state', st);
const VoiceHelper = require('./src/voice-helper.js');
const { spawn } = require('child_process');
const flow = VoiceHelper.createFlow({ reply: voiceReply, speak, send: sendVoice, speakable: Voice.speakable });
const listener = VoiceHelper.createListener({
  spawn, helperPath: VOICE_HELPER, exists: fs.existsSync,
  onState: sendVoice, onFinal: (text) => { flow.question(text).catch((err) => console.warn('[voice]', err.message)); }, log: console.log,
});
// The last stretch the screen was locked or the Mac asleep: "while I was out".
let awayFrom = null;
let lastAway = null;
const AWAY_FRESH_MS = 12 * 3600000;

async function voiceReply(text, onCancel) {
  const intent = Voice.parseIntent(text);
  const cfg = Voice.normalizeConfig(loadConfig().voice);
  const free = intent.intent === 'unknown' && cfg.askClaude;
  // The transcript itself stays out of app.log; the intent is enough to debug.
  console.log(`[voice] intent ${intent.intent}${free ? ' (asking claude)' : ''}`);
  const st = aggregateState({ ignoreTravel: true });
  const now = Date.now();
  const ctx = { sessions: st.sessions || [], pending: st.pending || [], now };
  if (intent.intent === 'spend' || free) ctx.turns = await getUsageTurns();
  if (intent.intent === 'away' || free) {
    ctx.transitions = McpServer.buddyRecentTransitions({ root: ROOT_DIR, limit: 500 }).transitions;
    const away = lastAway && now - lastAway.to < AWAY_FRESH_MS ? lastAway : null;
    ctx.since = away ? away.from : undefined;
    ctx.awayKnown = !!away;
  }
  if (free) {
    const ask = VoiceHelper.askClaude({
      spawn, fs, tmpdir: os.tmpdir(), args: Voice.claudeArgs(), prompt: Voice.claudePrompt(text, Voice.snapshot(ctx)),
      env: Voice.claudeEnv(process.env, `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin`),
    });
    onCancel(ask.cancel);
    const said = await ask.promise;
    if (said) return said;
  }
  return Voice.answer(intent, ctx);
}

function startListening(holdKey) {
  flow.interrupt();
  const r = listener.start({ holdKey });
  if (!r.ok && r.reason !== 'already listening') sendVoice({ state: 'error', error: r.reason });
  return r;
}

let voiceHotkey = null;
let voiceHotkeyTaken = null;
function applyVoiceHotkey() {
  if (voiceHotkey) { globalShortcut.unregister(voiceHotkey); voiceHotkey = null; }
  voiceHotkeyTaken = null;
  if (!IS_MAC || IS_DEV_RUN) return;
  const hk = Voice.hotkey(Voice.normalizeConfig(loadConfig().voice).hotkey);
  if (!hk) return;
  // Held: the helper sees the key come up (and gives up if it can't read it).
  const ok = globalShortcut.register(hk.accelerator, () => {
    if (!listener.listening) startListening(hk.keyCode);
  });
  if (ok) voiceHotkey = hk.accelerator;
  else { voiceHotkeyTaken = hk.accelerator; console.warn(`[voice] ${hk.accelerator} is already taken by another app`); }
}

function initVoice() {
  powerMonitor.on('lock-screen', () => { awayFrom = awayFrom || Date.now(); });
  powerMonitor.on('suspend', () => { awayFrom = awayFrom || Date.now(); });
  const back = () => { if (awayFrom) lastAway = { from: awayFrom, to: Date.now() }; awayFrom = null; };
  powerMonitor.on('unlock-screen', back);
  powerMonitor.on('resume', back);
  applyVoiceHotkey();
  app.on('will-quit', () => { globalShortcut.unregisterAll(); listener.cancel(); });
}

// A long-press where voice can't work (not a Mac, helper not bundled) stays
// an ordinary click: no tooltip, nothing swallowed.
ipcMain.handle('voice-start', () => {
  if (!listener.available() || !Voice.normalizeConfig(loadConfig().voice).longPress) return { ok: false, reason: 'off' };
  return startListening(null);
});
ipcMain.handle('voice-enabled', () => listener.available() && Voice.normalizeConfig(loadConfig().voice).longPress);
ipcMain.handle('voice-stop', () => listener.stop());
ipcMain.handle('voice-status', () => ({
  available: listener.available(),
  reason: listener.available() ? null : listener.unavailableReason(),
  hotkeys: Voice.HOTKEYS.map(({ accelerator, label }) => ({ accelerator, label })),
  hotkeyTaken: voiceHotkeyTaken,
}));

ipcMain.handle('answer-request', (e, id, decision) => {
  const ok = answerRequest(String(id), String(decision));
  setTimeout(broadcastStatus, 250);
  return ok;
});

// The widget grows a strip of Allow / Deny buttons while a request waits,
// or the "While you were away" recap once a busy spell ends. The ask wins:
// it is the one that blocks a session.
const STRIP_PX = 46;
const AWAY_PX = 64;
let stripPx = 0;
function applyStrip(asking, away = false) {
  const px = asking ? STRIP_PX : away ? AWAY_PX : 0;
  if (!win || px === stripPx) return;
  const b = win.getBounds();
  win.setAspectRatio(0);
  win.setBounds({ ...b, height: b.height + px - stripPx });
  stripPx = px;
  if (!px) win.setAspectRatio(WIDGET_ASPECT);
}

ipcMain.handle('preview-sound', (e, name) => playSound(name));

ipcMain.handle('export-rules', async (e, rules) => {
  const r = await dialog.showSaveDialog(lightsWin || undefined, { title: 'Export rules', defaultPath: path.join(app.getPath('documents'), 'claude-traffic-light-rules.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify({ v: 1, app: 'claude-traffic-light', rulesVersion: Rules.RULES_VERSION, rules: (rules || []).map(Rules.normalizeRule) }, null, 2));
  return r.filePath;
});

ipcMain.handle('import-rules', async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, { title: 'Import rules', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const rules = Array.isArray(parsed) ? parsed : parsed.rules;
    if (!Array.isArray(rules)) return { error: 'No rules in that file' };
    return { rules: Rules.migrateRules(rules.map(Rules.normalizeRule), Rules.rulesVersionOf(parsed)) };
  } catch (err) { return { error: `Could not read: ${err.message}` }; }
});

// Claude integration: registers mcp-server.js in ~/.claude.json (user scope).
// Dev runs register into a sandbox HOME.
function mcpOpts() {
  return {
    home: IS_DEV_RUN ? path.join(os.tmpdir(), 'claude-buddy-mcp-dev-home') : os.homedir(),
    entry: McpInstall.launch({ packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), dir: __dirname, root: process.env.CLAUDE_TRAFFIC_LIGHT_HOME }),
  };
}
ipcMain.handle('mcp-status', () => McpInstall.status(mcpOpts()));
ipcMain.handle('mcp-set-enabled', (_e, on) => {
  try {
    const r = on ? McpInstall.install(mcpOpts()) : McpInstall.uninstall(mcpOpts());
    console.log(`[mcp] ${on ? 'registered' : 'unregistered'} in ${r.path}${r.changed ? '' : ' (no change)'}`);
    return McpInstall.status(mcpOpts());
  } catch (err) {
    console.warn('[mcp] registration failed:', err.message);
    return { ...McpInstall.status(mcpOpts()), error: err.message };
  }
});

// Connect other agents: each adapter writes its own hook config.
ipcMain.handle('connect-agent', (e, which) => {
  const adapter = which === 'claude' ? null : Adapters.get(which);
  if (!adapter) return { ok: false };
  try {
    const r = adapter.install({ home: os.homedir(), runtime: HOOK_RUNTIME });
    return r.ok ? { ok: true, file: r.file } : { ok: false, file: r.file, error: r.error };
  } catch (err) {
    return { ok: false, file: adapter.configPath(os.homedir()), error: err.message };
  }
});
ipcMain.handle('git-status', () => ({ ...git.status(), enabled: loadConfig().gitSignals !== false }));
ipcMain.handle('signal-endpoint', () => ({ port: SIGNAL_PORT, emit: EMIT_SCRIPT, token: path.join(ROOT_DIR, 'token') }));

ipcMain.handle('choose-sound-file', async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, {
    title: 'Choose a sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['aiff', 'aif', 'wav', 'mp3', 'm4a', 'caf'] }],
  });
  return r.canceled || !r.filePaths[0] ? null : `file:${r.filePaths[0]}`;
});

ipcMain.handle('cameos-list', () => cameoListing());
ipcMain.handle('cameos-choose-file', async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, {
    title: 'Choose a photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return Cameos.readSource(nativeImage, r.filePaths[0]); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('cameos-add', (_e, p) => {
  const res = Cameos.addPhoto({ dir: CAMEO_DIR, nativeImage, source: p?.source, rect: p?.rect, shape: p?.shape, name: p?.name, replace: p?.replace, eyes: p?.eyes, mouth: p?.mouth });
  if (res.error) return { error: res.error };
  return { id: res.id, list: cameosChanged() };
});
ipcMain.handle('cameos-remove', (_e, id) => {
  try {
    Cameos.removePhoto(CAMEO_DIR, String(id));
    return cameosChanged();
  } catch (err) { return { error: err.message }; }
});

// The whole setup (setup.js) as one file. Import is two steps so the user sees
// what's in the file before choosing replace or merge; the parsed file waits
// here in between.
const readCameoPng = (id) => fs.readFileSync(path.join(CAMEO_DIR, `${id}.png`));
let pendingSetup = null;
ipcMain.handle('setup-export', async () => {
  const r = await dialog.showSaveDialog(lightsWin || undefined, { title: 'Export setup', defaultPath: path.join(app.getPath('documents'), 'claude-buddy-setup.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  try {
    const bundle = Setup.exportSetup({ config: loadConfig(), cameoIndex: Cameos.loadIndex(CAMEO_DIR), readPng: readCameoPng });
    fs.writeFileSync(r.filePath, JSON.stringify(bundle, null, 2));
    return { file: r.filePath, cameos: bundle.cameos.length };
  } catch (err) { return { error: `Could not export: ${err.message}` }; }
});
ipcMain.handle('setup-import-pick', async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, { title: 'Import setup', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    if (fs.statSync(r.filePaths[0]).size > Setup.MAX_BYTES) return { error: 'That file is over 32 MB — too big to be a setup.' };
    const parsed = Setup.readSetup(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (parsed.error) return parsed;
    pendingSetup = parsed;
    return Setup.summarize(parsed);
  } catch (err) { return { error: `Could not read: ${err.message}` }; }
});
ipcMain.handle('setup-import-apply', (_e, mode) => {
  if (!pendingSetup) return { error: 'Choose a setup file first.' };
  const plan = Setup.planImport(pendingSetup, { config: loadConfig(), cameoIndex: Cameos.loadIndex(CAMEO_DIR), readPng: readCameoPng }, mode === 'replace' ? 'replace' : 'merge');
  pendingSetup = null;
  // Faces first, so rules that wear them resolve on the first broadcast.
  for (const id of plan.remove) Cameos.removePhoto(CAMEO_DIR, id);
  const failed = plan.add.map((c) => Cameos.importPhoto(CAMEO_DIR, c)).filter((x) => x.error).map((x) => x.error);
  const cameos = cameosChanged();
  return { config: commitConfig(plan.partial), cameos, failed };
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
  const { key, restored } = GitSignals.soundKey(look, owned, config.rules, config.gitSignals !== false ? git.active() : []);
  // F5: a git rule's sound is held while you're busy like any other rule's.
  if (config.soundOnAmber && key && key !== lastSoundKey && !restored && pingAllowed(owned.sound, { lamp: look.lamp })) playSound(look.sound);
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
      else if (argv.includes('--buddy')) openBuddy();
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
  // Dev: `electron . --buddy [page] [--buddy-shot out-prefix]` opens the Buddy
  // window (optionally on a page) and can capture both halves, then quit.
  if (process.argv.includes('--buddy')) {
    const at = process.argv.indexOf('--buddy');
    const page = process.argv[at + 1]?.startsWith('--') ? null : process.argv[at + 1] ?? null;
    openBuddy(page);
    const shotAt = app.isPackaged ? -1 : process.argv.indexOf('--buddy-shot');
    if (shotAt > 0 && process.argv[shotAt + 1]) {
      setTimeout(async () => {
        const shots = await buddyWin.capture();
        const prefix = process.argv[shotAt + 1];
        fs.writeFileSync(`${prefix}-sidebar.png`, shots.sidebar.toPNG());
        if (shots.content) fs.writeFileSync(`${prefix}-content.png`, shots.content.toPNG());
        console.log('[buddy-shot]', JSON.stringify(buddyWin.status()));
        app.quit();
      }, Number(process.env.BUDDY_SHOT_DELAY_MS ?? 6000));
    }
  }
  // After the widget has had time to appear, so the panel can sit beside it.
  if (process.argv.includes('--help-window') || process.argv.includes('--shot-help')) setTimeout(createHelpWindow, 1200);
  else setTimeout(maybeAutoShowHelp, 2500);

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
      refreshSpend(SPEND_LIVE_MS);
    }, 200);
  });

  every(4000, () => {
    broadcastStatus();
    maybePlayAlertSound();
    tickStats(readSessions(loadConfig()));
  }, 'poll');
  every(30000, flushStats, 'stats-flush');
  // GitHub is asked at most once a poll interval (github-signals decides);
  // dev runs never call gh, but still show saved events.
  if (IS_DEV_RUN) git.pause('dev-run');
  else {
    const gitTick = () => {
      const config = loadConfig();
      if (!git.due(config)) return;
      git.tick({ sessions: readSessions(config), config }).then((fired) => {
        if (!fired.length) return;
        stateMemo = { at: 0, key: null, value: null };
        broadcastStatus();
        maybePlayAlertSound();
      }).catch((e) => console.log('[git]', e.message));
    };
    setTimeout(gitTick, 5000);
    every(15000, gitTick, 'git');
  }
  refreshSpend();
  every(SPEND_POLL_MS, refreshSpend, 'spend');
  // The visual tests screenshot a still face; a live cursor would shift it.
  if (DEMO !== 'visual') every(Motion.MOTION.eyes.pollMs, eyeTick, 'eyes');
  sweepSessionFiles();
  every(10 * 60 * 1000, sweepSessionFiles, 'session-sweep');
  checkOnline();
  every(5000, checkOnline, 'net');
  BusyWatch.start();
  powerMonitor.on('resume', checkOnline);
  initVoice();
  // Other agents live on disk, not in hooks: poll for them.
  if (!DEMO) { syncAgents(); every(OMC_POLL_MS, syncAgents, 'omc-agents'); }

  if (!IS_DEV_RUN) every(10 * 60 * 1000, () => { if (!areHooksInstalled()) installHooks(); }, 'hooks');
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
// The embedded board hub gets SIGTERM and a grace period to close its DB
// before we exit, once; a second quit goes straight through.
let hubStopped = false;
app.on('before-quit', (e) => {
  if (hubStopped || !buddyWin) return;
  e.preventDefault();
  hubStopped = true;
  buddyWin.stop().finally(() => app.quit());
});

app.on('activate', () => { if (!lightsWin && !settingsWin) win?.showInactive(); });

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
