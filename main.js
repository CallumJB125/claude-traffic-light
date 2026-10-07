// Windows hook commands in argv form run the exe with --buddy-hook: the hook
// script runs here and the process exits before any of the app starts.
if (process.argv.includes('--buddy-hook')) require('./src/buddy-hook-runner.js').run(process.argv);
// `--uninstall-hooks`: the Windows uninstaller runs this to take Buddy's
// entries out of the agents' configs before the binary goes, then exits
// before any window, lock or data folder is touched (the .deb's prerm runs
// the same code through hooks/uninstall-hooks.js).
if (process.argv.includes('--uninstall-hooks')) {
  const results = require('./hooks/uninstall-hooks.js').main({ mcp: require('./mcp-install.js') });
  process.exit(require('./hooks/uninstall-hooks.js').exitCode(results));
}
// `--rename-dry-run`: prints what the first launch after the rename from Claude Buddy
// would do on this machine, writes nothing and exits, before anything creates
// the userData folder (Electron is never asked for it; no crash reporter, log file or lock).
if (process.argv.includes('--rename-dry-run')) {
  require('./src/rename-dry-run.js').main();
  process.exit(0);
}
const { onQuit } = require('./src/quit-handlers');
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, screen, clipboard, systemPreferences, nativeImage, dialog, net, powerMonitor, powerSaveBlocker, Notification, globalShortcut } = require('electron'); // privacy-flow: ics-feed
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const Rules = require('./rules.js');
const Brand = require('./brand.js');
const Adapters = require('./adapters/index.js');
const Stats = require('./stats.js');
const Usage = require('./usage.js');
const UsageHistory = require('./usage-history.js');
const Spend = require('./spend.js');
const SessionState = require('./hooks/session-state.js');
const Agents = require('./agents.js');
const HostApp = require('./hostapp.js');
const Motion = require('./motion.js');
const Cameos = require('./cameos.js');
const McpInstall = require('./mcp-install.js');
const NativeBoard = require('./native-board/service');
const Setup = require('./setup.js');
const Help = require('./help.js');
const GitSignals = require('./src/github-signals.js');
const Voice = require('./src/voice.js');
const Compaction = require('./src/compaction.js');
const Health = require('./src/health.js');
const Backups = require('./src/backups.js');
const { applyConfigSideEffects } = require('./src/config-effects.js');
const { trayLookAnimated, trayTimerAction } = require('./src/tray-anim.js');
const { resolveLowPower } = require('./src/low-power.js');
const { windowAnimStepMs, createPointDedupe, eyePollMs } = require('./src/anim-step.js');
const { spendMinGap } = require('./src/spend-poll.js');
const { createStatusGate } = require('./src/status-gate.js');
const { syncBackgroundThrottling, createMotionGate, staleMachineReasons, askKey, statusPushWanted } = require('./src/motion-gate.js');
const { createAwayFeeds } = require('./src/away-feeds.js');
const { createProbeBackoff } = require('./src/probe-backoff.js');
const UpdateView = require('./src/update-view.js');
const Feedback = require('./src/feedback');
const http = require('http'); // privacy-flow: local-server
const crypto = require('crypto');
const Terminal = require('./src/terminal.js')({ getSessions: () => localSessions(aggregateState().sessions), getRootDir: () => ROOT_DIR, getLocalHost: () => LOCAL_HOST });
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
    sessionId: 'demo', host: 'demo', cwd: '/demo/plexiform', signal: 'tool-use', tool: 'Agent',
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
  // (plexiform-demo-knock) — sharing it wedges the app before `ready`.
  process.env.CLAUDE_TRAFFIC_LIGHT_HOME = path.join(os.tmpdir(), 'plexiform-knock-home');
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
// The visual tests launch a fresh copy of the app each time; on macOS every one
// that showed in the Dock left a stray Dock icon and LaunchServices entry
// behind. A test run is unpackaged and passes `--demo visual`.
const NO_DOCK = DEMO === 'visual' && !app.isPackaged;
const { stayOnPage: stayOnOwnPage } = require('./src/nav-guard.js');
const stayOnPage = (file) => stayOnOwnPage(__dirname, file);
function showDock() { if (IS_MAC && !NO_DOCK) app.dock.show(); }

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
  // The bubble or the recap has grown the window past the widget's shape; the
  // update row just rides along under the resized widget.
  if (!win || WidgetStrip.blocksTravel(strip)) return;
  const cur = win.getBounds();
  const r = WidgetStrip.resizeBase(cur, strip, factor, { minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH, aspect: WIDGET_ASPECT }, screen.getDisplayMatching(cur).workArea);
  if (!strip.kind) { win.setBounds(r.bounds); return; }
  applyingStrip = true;
  strip = r.strip;
  try {
    win.setMaximumSize(Math.max(MAX_WIDTH, r.bounds.width), Math.round(MAX_WIDTH / WIDGET_ASPECT) + r.strip.px);
    win.setBounds(r.bounds);
  } finally { applyingStrip = false; }
  saveBounds();
}

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SPEND_FIXTURE = DEMO === 'visual' ? path.join(ROOT_DIR, 'spend-snapshot.json') : null;
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const BOUNDS_FILE = path.join(ROOT_DIR, 'window-bounds.json');
const MANUAL_OVERRIDE_FILE = path.join(ROOT_DIR, 'manual-override.json');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

require('./src/logging.js').installFileLogging({ rootDir: ROOT_DIR, isDevRun: IS_DEV_RUN });

// First launch after the rename from Claude Buddy: copy the old userData
// across before anything opens it (the instance lock, safeStorage, the
// updater, the team window). Only for the installed app in its own folder:
// not dev runs, a checkout, or a --user-data-dir run such as the smoke test.
// The folder is worked out, not asked for: asking Electron for it creates it.
const RenameMigration = require('./src/rename-migration.js');
const RENAME_MIGRATES = app.isPackaged && !IS_DEV_RUN && !app.commandLine.hasSwitch('user-data-dir');
const listOldProcesses = () => RenameMigration.listProcesses(process.platform);
// process.kill on Windows is TerminateProcess; taskkill without /F asks the app to close.
const killOld = process.platform === 'win32'
  ? (pid) => require('child_process').execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  : process.kill;
const OLD_USER_DATA = path.join(app.getPath('appData'), RenameMigration.OLD.userDataName);
const quitOldOpts = { platform: process.platform, home: os.homedir(), listProcesses: listOldProcesses, kill: killOld, oldUserData: OLD_USER_DATA };
// The old app is asked to quit first, so its databases aren't copied mid-write; if it won't, the copy waits for the next launch.
const renameCopy = RENAME_MIGRATES ? RenameMigration.copyUserData({
  appData: app.getPath('appData'),
  userData: path.join(app.getPath('appData'), app.getName()),
  quitOld: () => RenameMigration.quitOldInstance(quitOldOpts).running.length === 0,
}) : null;
const copied = !!renameCopy?.copied;
if (copied) RenameMigration.setAsideSealedSecret({ file: path.join(ROOT_DIR, 'approval-secret.json') });

const DEFAULT_CONFIG = {
  // The one character every rule shows (rules pick pose, eyes and the rest, never the body).
  character: { body: 'claude', bodyColor: null },
  workingStaleMinutes: 6,
  // Minutes of silence before a working session reads "Stuck?" (0 = off); see hooks/session-machine.js stuckOf.
  stuckMinutes: 5,
  waitingStaleHours: 4,
  // Every sound the app plays: rule sounds and the knock.
  sounds: true,
  // macOS notifications for the states that matter when the widget is out of sight.
  notifyOnStates: true,
  notifyStates: { ...Help.NOTIFY_DEFAULTS },
  // Notification controls (src/quiet.js): they hold sounds, notifications and knocks, never the light.
  snoozeUntil: 0,
  quietHours: { enabled: false, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
  mutedProjects: [],
  // Enter approves a read-only permission request (src/one-key.js). Strictly opt-in.
  oneKeyApprove: false,
  showWidget: true,
  menuBarMode: false,
  // 'auto' | 'on' | 'off': trims non-essential motion (src/low-power.js).
  lowPower: 'auto',
  // Hooks hand frequent events to the running app (src/hook-socket.js). Off by default.
  fastHook: false,
  // 'off' | 'app' | 'ac' | 'always': keep this Mac awake while AI works (src/keep-awake-ipc.js).
  keepAwake: 'off',
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
  // the widget tooltip's "Today $X · Y% above your usual" line
  paceTooltip: true,
  // Busy sources (F5): hold non-urgent pings while you're in a meeting or a Focus.
  busyHold: true,
  busyCalendar: false, // off until ticked in Settings, which is what asks macOS for access
  busyCalendarTitles: false,
  busyIcsUrl: '',
  // Focus and the Calendar helper are macOS-only readers.
  busyFocus: process.platform === 'darwin',
  busyFocusShortcut: '',
  voice: { ...Voice.DEFAULTS },
  // In-app compactor for Plexiform-owned sessions only (src/compaction.js); off until turned on.
  compaction: Compaction.normalizeSettings(null),
  // Accept paired devices' events on the Tailscale address too (loopback
  // only otherwise, which an ssh -R tunnel reaches).
  remoteTailscale: false,
  // Remote interaction host: off until ticked in Preferences.
  remoteInteractionHost: false,
  teamSessionSharing: true,
  // A role reset the team hub never acknowledged ({origin, userId}; no token): retried at start.
  remoteInteractionResetPending: null,
  // Existing Codex CLI sessions on Codex's shared daemon (src/codex-daemon.js): off until ticked in Preferences.
  codexDaemonMessaging: false,
  // Auto-answer rules (src/auto-rules.js). Saved and shown in Lights; nothing
  // answers from them until the hook side evaluates them.
  autoAnswer: { v: 1, sealed: null, rules: [] },
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
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // a config that is null, a list or a bare value must not take every read down with it
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {
    // no config yet
  }
  // Keys of removed features (the router, delegation) are dropped, so an old
  // config neither crashes nor carries them forward on the next save.
  const config = { ...DEFAULT_CONFIG, ...Setup.dropRemovedKeys(saved) };
  // soundOnAmber was the old name of `sounds` (it always covered every sound).
  if (typeof saved.sounds !== 'boolean' && typeof saved.soundOnAmber === 'boolean') config.sounds = saved.soundOnAmber;
  delete config.soundOnAmber;
  config.agentKinds = { ...DEFAULT_CONFIG.agentKinds, ...(saved.agentKinds && typeof saved.agentKinds === 'object' ? saved.agentKinds : {}) };
  config.notifyStates = { ...DEFAULT_CONFIG.notifyStates, ...(saved.notifyStates && typeof saved.notifyStates === 'object' ? saved.notifyStates : {}) };
  config.spend = Spend.normalize(saved.spend);
  config.voice = Voice.normalizeConfig(saved.voice);
  config.compaction = Compaction.normalizeSettings(saved.compaction);
  // Rules are stored whole; a config from before rules existed gets the
  // defaults, which reproduce the old fixed behaviour exactly.
  config.rules = (Array.isArray(saved.rules) ? saved.rules : Rules.defaultRules()).map(Rules.normalizeRule);
  // Before v11 each rule could pick a body; keep the user's most common one as the single character.
  config.character = saved.character ? Rules.normalizeCharacter(saved.character) : Rules.characterFromRules(saved.rules);
  // Migration: configs saved before the idle nudge became a waiting signal
  // have no rule for it, and the widget would go dark after a finished turn.
  // Slot the default "Waiting for you" rule in just above "Nothing running".
  if (!config.rules.some((r) => r.when.signal.includes('idle-nudge'))) {
    const nudge = Rules.defaultRules().find((r) => r.id === 'nudge');
    const at = config.rules.findIndex((r) => r.when.signal.includes('idle'));
    config.rules.splice(at < 0 ? config.rules.length : at, 0, Rules.normalizeRule(nudge));
  }
  if (Array.isArray(saved.rules)) config.rules = Rules.migrateRules(config.rules, Number(saved.rulesVersion) || 0, saved.template);
  config.rulesVersion = Rules.RULES_VERSION;
  // Re-checked on every read: config.json is a file anyone running as you can edit.
  config.autoAnswer = { v: 1, sealed: null, rules: AutoRules.sanitize(saved.autoAnswer && saved.autoAnswer.rules).rules };
  config.presets = (Array.isArray(saved.presets) ? saved.presets : [])
    .filter((p) => p && typeof p.name === 'string' && Array.isArray(p.rules))
    .map((p) => ({ id: String(p.id || Rules.uid()), name: p.name.slice(0, 30), rules: Rules.migrateRules(p.rules.map(Rules.normalizeRule), Rules.rulesVersionOf(p)), rulesVersion: Rules.RULES_VERSION }));
  return config;
}

function saveConfig(partial) {
  const next = Setup.dropRemovedKeys({ ...loadConfig(), ...partial });
  if (partial.rules) next.rules = partial.rules.map(Rules.normalizeRule);
  if (partial.character) next.character = Rules.normalizeCharacter(partial.character);
  // A template only describes the rules it saved them with.
  if (partial.rules && !('template' in partial)) next.template = null;
  // Presets reach here from loadConfig or Lights, so their rules are current.
  if (partial.presets) next.presets = partial.presets.map((p) => ({ ...p, rulesVersion: Rules.RULES_VERSION }));
  // A renderer can't save a rule the UI would refuse.
  // `sealed` is reserved for the rules' safeStorage HMAC (src/auto-rules.js); null until the evaluator ships.
  if (partial.autoAnswer) next.autoAnswer = { v: 1, sealed: null, rules: AutoRules.sanitize(partial.autoAnswer.rules).rules };
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  configCache = { key: null, value: null }; // two writes inside one ms would share an mtime
  backups?.onSave();
  return next;
}

// Outside the data folder, so deleting that folder doesn't take the backups
// (src/backups.js). A dev run without its own folder makes none: it must not
// write into the real install's backups.
const BACKUPS_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_BACKUPS || (IS_DEV_RUN ? null : path.join(app.getPath('appData'), `${Brand.name} Backups`));
const backups = BACKUPS_DIR ? Backups.create({ dataDir: ROOT_DIR, backupsDir: BACKUPS_DIR, appVersion: app.getVersion(), log: (m) => console.warn(m), clickCommands: Rules.clickCommands }) : null;
// Before anything that deletes or replaces what the user made. A failed backup
// is logged, not fatal: a full disk must not make Reset impossible.
function backupFirst() {
  const r = backups ? backups.snapshotSafe('manual') : { taken: false };
  if (r.error) console.warn('[backups] manual snapshot failed:', r.error);
  return r;
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
// the checked-out hooks/ dir next to main.js. A Linux AppImage copies it out
// to a path that survives a relaunch (src/hook-paths.js).
const HookPaths = require('./src/hook-paths.js');
const HOOK_PATHS = HookPaths.forApp(app, ROOT_DIR);
const HOOKS_DIR = HOOK_PATHS.hooksDir;
const EMIT_SCRIPT = path.join(HOOKS_DIR, 'emit.js');
// Hooks run the app's own binary as Node (ELECTRON_RUN_AS_NODE), so a machine
// without node still lights up. An unpackaged dev run has no app binary worth
// pinning into agent configs and falls back to plain `node`.
const HOOK_RUNTIME = Adapters.Runtime.make({ execPath: HOOK_PATHS.execPath, hooksDir: HOOKS_DIR, dataDir: ROOT_DIR });
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
// Linux panels are often dark and don't recolour template images, so it gets its own colour icon.
const TRAY_ICON = IS_WIN ? 'tray-win.png' : IS_LINUX ? 'tray-linux.png' : 'trayTemplate.png';
require('./src/spellcheck.js').keepOffline({ app, getDefaultSession: () => require('electron').session.defaultSession });
require('./src/desktop-shell.js').setup({ app, Menu });

function claudeHookOpts() {
  return { home: os.homedir(), runtime: HOOK_RUNTIME, askFromWidget: !!loadConfig().askFromWidget };
}

function areHooksInstalled() {
  return Adapters.get('claude').isInstalled(claudeHookOpts());
}

// An unparsable settings.json is left alone rather than written over.
// Returns the error message, or null. narrow: while the rename's hooks step
// is pending (and once the old app has quit), only the old app's entries and
// this app's are replaced, never a look-alike script or a dev checkout's.
function installHooks({ narrow = RENAME_MIGRATES && RenameMigration.pending(app.getPath('userData')).includes('hooks') } = {}) {
  const opts = claudeHookOpts();
  try { Adapters.get('claude').install({ ...opts, strip: narrow ? RenameMigration.renameStrip(Adapters.get('claude'), opts) : undefined }); return null; } catch (err) { console.warn(`[hooks] ${CLAUDE_SETTINGS_PATH} not updated:`, err.message); return err.message; }
}
// Opened straight from Downloads, macOS runs a random read-only copy; run
// from a mounted disk image, the app is gone once it is ejected. Hooks pinned
// to either break, so none are written (Health says why).
const EPHEMERAL = RenameMigration.EPHEMERAL_PATH.test(process.execPath);
const AUTO_INSTALL_HOOKS = !IS_DEV_RUN && !EPHEMERAL;

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
// Paired machines report their sessions over POST /remote/event, signed per
// device, on a port of their own that serves nothing else (src/remote-devices.js,
// docs/remote-reporter.md). Their writes land outside SESSIONS_DIR, so the
// watcher there doesn't see them: onChange does.
const RemoteDevices = require('./src/remote-devices.js')({
  rootDir: ROOT_DIR,
  onChange: () => { stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); },
  log: (m) => console.log(m),
});
const Smoke = require('./src/smoke.js');
const WindowLaunch = require('./src/window-launch.js');
const STARTED_AT = Date.now();
// One place for the inputs, so launch, activate and second-instance decide alike.
const windowLaunchInput = (event) => ({ event, devRun: IS_DEV_RUN, atLogin: WindowLaunch.launchedAtLogin({ app }), hookLaunch: process.argv.includes('--buddy-hook'), windowVisible: !!buddyWin?.isVisible(), sinceLaunchMs: Date.now() - STARTED_AT });
const Updater = require('./src/updater/index.js');
const { SIGNAL_PORT, startSignalServer, readRequests, answerRequest, keyFor } = require('./src/signal-server.js')({
  rootDir: ROOT_DIR,
  sessionsDir: SESSIONS_DIR,
  requestsDir: REQUESTS_DIR,
  aggregateState: (...a) => aggregateState(...a),
  broadcastStatus: (...a) => broadcastStatus(...a),
});
// A remote session's folder names a directory on another machine: it is
// shown, never opened, copied as a path, knocked on or used to find a
// terminal here.
const { localSessions } = require('./src/remote-devices.js');

// ── Waiting inputs (P3+): every ask, answerable or not, as one list
// (state.inputs; schema in docs/waiting-inputs.md). Dialogs no hook can see
// are read off the session's tmux pane, read-only and rate-limited.
const PendingInputs = require('./src/pending-inputs.js');
// Work scope (accounts contract §C2): src/work-scope.js is the core's module
// and may not exist yet. Without it every session's scope is null and the
// widget shows nothing about scope.
let WorkScope = null;
// Only the module itself missing is "no core yet"; a missing dependency of a
// present module is a real error.
try { WorkScope = require('./src/work-scope.js'); } catch (e) { if (!(e.code === 'MODULE_NOT_FOUND' && /Cannot find module '\.\/src\/work-scope\.js'/.test(e.message))) throw e; }
// Specs inject scope states through a mock that is never packaged.
if (IS_DEV_RUN && !app.isPackaged && process.env.CLAUDE_TRAFFIC_LIGHT_WORK_SCOPE_MOCK) WorkScope = require('./test-visual/work-scope-mock.js').create(process.env.CLAUDE_TRAFFIC_LIGHT_WORK_SCOPE_MOCK);
const WorkScopeView = require('./src/work-scope-view.js');
function withScope(sessions) {
  if (typeof WorkScope?.scopeFor !== 'function') return sessions;
  const linked = typeof WorkScope.linkedRepos === 'function' ? WorkScope.linkedRepos() : undefined;
  return sessions.map((s) => {
    if (s.remote) return { ...s, scope: null };
    let scope = null;
    try { scope = WorkScope.scopeFor(s, linked) || null; } catch { scope = null; }
    return { ...s, scope };
  });
}
const AutoRules = require('./src/auto-rules.js');
const ApprovalNudge = require('./src/approval-nudge.js');
// The counter's keys are HMACs under a per-install secret (src/nudge-secret.js).
const nudgeSecret = require('./src/nudge-secret.js').createSecretStore({
  file: path.join(ROOT_DIR, 'approval-secret.json'),
  safeStorage: require('electron').safeStorage,
  log: (m) => console.warn('[nudge]', m),
});
const nudger = ApprovalNudge.createNudgeCounter({ file: path.join(ROOT_DIR, 'approval-counts.json'), secret: nudgeSecret });
// The "make it a rule?" card stays hidden while auto-answer is off: a rule
// that nothing applies would only mislead. Nothing is counted either: the
// counter's secret lives in the keychain, and on an ad-hoc-signed build
// reading it on every answer made macOS ask for the password, blocking main.
const SHOW_RULE_NUDGE = false;
// Why a permission request needs a careful look (deny-list or destructive):
// shown as a warning. enterAllow: Enter may allow it only when nothing is
// flagged AND it is on the allow-list (src/enter-allow.js); the widget still
// shows Allow either way, Enter just never stands in for that click.
const EnterAllow = require('./src/enter-allow.js');
const OneKey = require('./src/one-key.js');
function withDanger(inputs, requests) {
  const byId = new Map(requests.map((r) => [r.id, r]));
  return inputs.map((i) => {
    if (i.kind !== 'permission' || !byId.has(i.id)) return i;
    const req = byId.get(i.id);
    let danger;
    try { danger = AutoRules.danger(req); } catch { danger = 'it could not be checked'; }
    const skip = danger === null ? EnterAllow.enterBlockedReason(req) : null;
    const oneKey = danger === null && skip === null ? OneKey.reason(req, { enabled: loadConfig().oneKeyApprove }) : null;
    const note = skip !== null ? EnterAllow.widgetWording(skip) : oneKey;
    return { ...i, danger, enterAllow: danger === null && skip === null && oneKey === null, enterNote: note };
  });
}
const PaneDialogs = require('./src/pane-dialogs.js');
const Owned = require('./hooks/owned.js');
const AnswerFile = require('./hooks/answer-file.js');
let paneDialogs = [];
let paneDetector = null;
async function scanPaneDialogs() {
  if (process.platform === 'win32') return;
  const Focus = require('./src/focus/index.js');
  paneDetector = paneDetector || PaneDialogs.createDetector({ exec: Focus.exec, serverOk: Focus.tmuxServerOk, tmuxBin: Focus.which(require('./src/focus/tmux.js').BINS) });
  const st = aggregateState();
  const pendingSessionIds = new Set((st.pending || []).map((r) => r.sessionId));
  const next = await paneDetector.scan({ sessions: st.sessions || [], pendingSessionIds, launches: Owned.unclaimedLaunches(ROOT_DIR) });
  const sig = (list) => list.map((d) => `${d.key}:${d.dialog}:${d.options.length}`).join('|');
  if (sig(next) !== sig(paneDialogs)) {
    paneDialogs = next;
    stateMemo = { at: 0, key: null, value: null };
    broadcastStatus();
  } else paneDialogs = next;
}

let win;
let tray;
let signalServer = null;
let signalServerError = null;

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
  // The widget's own size, without the bubble or the recap under it.
  if (applyingStrip) return; // applyStrip saves the base once it is done
  fs.writeFileSync(BOUNDS_FILE, JSON.stringify(WidgetStrip.baseOf(win.getBounds(), strip), null, 2));
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
  for (const dir of RemoteDevices.deviceDirs()) removed.push(...Agents.sweepStaleFiles(dir, maxAge));
  if (removed.length) console.log(`[sweep] removed ${removed.length} stale session file(s)`);
}

// Hooks write session files themselves and SessionEnd deletes them, so the
// newest hook stamp is saved (at most every 30 s) for Health's "last hook
// event" to outlive the session.
const LAST_HOOK_FILE = path.join(ROOT_DIR, Health.LAST_HOOK_FILE);
let lastHookSaved = 0;
try { lastHookSaved = Date.parse(JSON.parse(fs.readFileSync(LAST_HOOK_FILE, 'utf8')).at) || 0; } catch { /* none yet */ }
function saveLastHook() {
  const ev = Health.newestHookAt([...sessionFileCache.values()].map((e) => e.data));
  if (!ev || ev.at - lastHookSaved < 30000) return;
  lastHookSaved = ev.at;
  try { SessionState.writeJsonAtomic(LAST_HOOK_FILE, { at: new Date(ev.at).toISOString(), source: ev.source }); } catch { /* the next event retries */ }
}

// Every change in what a session presents is logged, so a flicker report can
// be read off app.log. At most one line per session per TRANSITION_LOG_MS.
const TRANSITION_LOG_MS = 250;
const lastPresented = new Map(); // sessionId -> { signal, loggedAt, skipped }
function logTransition(data, signal, source, now) {
  const sid = String(data.sessionId || '?');
  const last = lastPresented.get(sid);
  // Remote ids are minted elsewhere; don't let them grow this without bound.
  if (!last && lastPresented.size >= 1000) lastPresented.delete(lastPresented.keys().next().value);
  if (last && last.signal === signal) return;
  const entry = { signal, loggedAt: last ? last.loggedAt : 0, skipped: last ? last.skipped : 0 };
  if (now - entry.loggedAt >= TRANSITION_LOG_MS) {
    const tail = String(data.cwd || '').split('/').filter(Boolean).slice(-2).join('/');
    const why = signal === 'turn-failed' ? ` [${data.failKind || 'error'}]` : '';
    console.log(`[state] ${data.logId || sid.slice(0, 8)} ${tail} ${last ? last.signal : '—'} → ${signal}${why} (${source})${entry.skipped ? ` +${entry.skipped} unlogged` : ''}`);
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
  const stuckMs = (Number(config.stuckMinutes) || 0) * 60 * 1000;
  const now = Date.now();
  const sessions = [];
  for (const f of files) {
    try {
      const data = readSessionFile(f);
      if (!data) continue;
      // The reader half of the session state machine (hooks/session-machine.js).
      const c = Rules.classifySession(data, { now, pendingIds, isGone: () => SessionState.processGone(data, LOCAL_HOST), workingStaleMs, waitingStaleMs, stuckMs });
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

// Paired devices' sessions, through the same reader machine; liveness is the
// device's heartbeat (a pid on another machine can't be checked from here).
function readRemoteSessions(config) {
  const workingStaleMs = config.workingStaleMinutes * 60 * 1000;
  const waitingStaleMs = config.waitingStaleHours * 60 * 60 * 1000;
  const now = Date.now();
  const sessions = [];
  for (const data of RemoteDevices.readSessions()) {
    const c = Rules.classifySession(data, { now, isGone: () => RemoteDevices.isGone(data, now), workingStaleMs, waitingStaleMs });
    if (c.dropped === 'gone') logTransition(data, 'gone', 'heartbeat lapsed', now);
    if (c.held) wakeWhenHoldEnds(data, now);
    if (!c.live) continue;
    logTransition(data, c.presented, c.source, now);
    sessions.push(c.session);
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
// id → { id, rev, name, shape, eyes, mouth, src (data: URL) }, read once per change.
let cameoCache = null;
function cameoPhotos() {
  if (cameoCache) return cameoCache;
  cameoCache = {};
  for (const [id, e] of Object.entries(Cameos.loadIndex(CAMEO_DIR))) {
    try { cameoCache[id] = { id, rev: e.addedAt, name: e.name, shape: e.shape, eyes: e.eyes, mouth: e.mouth, src: Cameos.photoDataUrl(CAMEO_DIR, id) }; } catch { /* unreadable: the drawing, or none */ }
  }
  return cameoCache;
}
function cameoListing() {
  const photos = cameoPhotos();
  return Cameos.listing(Cameos.loadIndex(CAMEO_DIR)).map((c) => ({ ...c, src: photos[c.id]?.src || null }));
}
function cameosChanged() {
  backups?.onSave();
  cameoCache = null;
  stateMemo = { at: 0, key: null, value: null };
  broadcastStatus();
  return cameoListing();
}

const budgetView = () => budgetNotices.list().map((n) => ({ runId: n.runId, text: BudgetNotice.text(n) }));

const Stuck = require('./src/stuck.js');
const Quiet = require('./src/quiet.js');
function computeState(opts = {}) {
  const config = loadConfig();
  const requests = readRequests();
  const sessions = withScope(readSessions(config, requests.map((r) => r.sessionId)).concat(readRemoteSessions(config)));
  const pending = config.askFromWidget ? requests : [];
  const tasks = config.showTasks ? sumTasks(sessions.filter((s) => !WAITING_SIGNALS.has(s.signal) && s.signal !== 'idle-nudge')) : null;
  const inputs = withDanger(PendingInputs.collect({ requests: pending, sessions, dialogs: paneDialogs }), pending);
  if (previewLook && Date.now() < previewLook.expiresAt) {
    return { look: previewLook.look, reason: 'preview', sessions, fired: [], pending: [], tasks: null };
  }
  if (travelLook && !opts.ignoreTravel) {
    return { look: { ...travelLook, tasks }, reason: 'travel', sessions, fired: [], pending, inputs, tasks, away: BusyWatch.recap(), budget: null };
  }
  const override = readManualOverride();
  if (override) {
    const synthetic = [{ signal: OVERRIDE_SIGNALS[override.state] || 'idle', cwd: '' }];
    const { look, fired, owned } = Rules.resolve(config.rules, synthetic, Date.now(), { character: config.character });
    return { look: { ...look, tasks }, reason: 'manual', sessions, fired, owned, firedNames: Rules.firedNames(config.rules, fired, owned), pending, inputs, tasks };
  }
  // A pending permission request is the "Needs your input" state, whatever
  // the session files say (the hook blocks before Notification fires). It
  // replaces the look only; the chips, number and season still apply.
  const spend = spendSnapshot(config);
  const env = { character: config.character, offline: !online, ...BusyWatch.env(), git: config.gitSignals !== false ? git.active() : [], spend };
  const { look, fired, owned } = pending.length
    ? Rules.resolve(config.rules, [{ signal: 'permission-ask', cwd: pending[0].cwd }], Date.now(), env)
    : Rules.resolve(config.rules, sessions, Date.now(), env);
  const agentCount = Rules.liveAgents(sessions).length;
  if (config.seasonal) {
    if (look.costume === 'none') look.costume = Rules.seasonalCostume() || 'none';
    if (look.effect === 'none') look.effect = Rules.seasonalEffect() || 'none';
  }
  const minions = config.showAgents ? Rules.filterAgentKinds(Rules.liveAgents(sessions), config.agentKinds).slice(0, 32) : [];
  const sNote = spendNote(config.rules, fired, sessions, spend);
  const stuck = Stuck.summary(sessions);
  return { stuck, look: { ...Stuck.applyStuck(withNumber(look, sessions, tasks), stuck), tasks, minions, agentRoster: config.agentRoster !== false, agentChipSize: config.agentChipSize }, reason: sessions.length ? 'session' : 'idle', sessions, fired, owned, firedNames: Rules.firedNames(config.rules, fired, owned), tool: currentTool(sessions), agentCount, pending, inputs, tasks, minions, spend, spendNote: sNote, paceLine: config.paceTooltip !== false && spend && spend.pace && spend.pace.noteworthy && !sNote ? spend.pace.text : null, away: BusyWatch.recap(), budget: budgetView(), busy: BusyWatch.holding() };
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
  exec: (file, args, timeout) => new Promise((resolve, reject) => execFile(file, args, { timeout }, (err, out) => (err ? reject(err) : resolve(out)))), // privacy-flow: calendar-helper
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  writeFile: (f, text) => { fs.mkdirSync(ROOT_DIR, { recursive: true }); fs.writeFileSync(f, text); },
  removeFile: (f) => fs.rmSync(f, { force: true }),
  exists: (f) => fs.existsSync(f),
  fetch: (url) => net.fetch(url), // privacy-flow: ics-feed
  log: (...a) => console.log(...a),
  onChange: () => { stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); },
});

// Whether a ping from this rule may sound now. Not busy: always.
// Every ping that waits is noted by rule and signal for the recap; any
// feature with a ping of its own (a budget warning, say) goes through here.
function pingAllowed(ruleId, opts = {}) {
  if (quietHolds(null)) return false;
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
// Snooze, quiet hours and project mutes (src/quiet.js): why this ping stays
// quiet, or null. With no cwd, a project mute counts only when every live
// session is muted.
function quietHolds(cwd) {
  const config = loadConfig();
  const now = Date.now();
  const why = Quiet.reason(config, { now, cwd });
  if (why) return why;
  return !cwd && Quiet.allMuted(config, aggregateState({ ignoreTravel: true }).sessions) ? 'project' : null;
}
// The one thing quiet still does: a silent badge count of asks waiting on you.
function syncQuietBadge(st) {
  const config = loadConfig();
  const now = Date.now();
  const timed = Quiet.reason(config, { now });
  const asking = new Map();
  for (const s of st.sessions || []) if (s.signal === 'permission-ask') asking.set(s.sessionId, s.cwd);
  for (const r of st.pending || []) if (r && r.sessionId) asking.set(r.sessionId, r.cwd);
  let n = 0;
  for (const cwd of asking.values()) if (Quiet.badgeFor(timed || Quiet.reason(config, { now, cwd }), 'permission-ask')) n += 1;
  try { app.setBadgeCount(n); } catch { /* no badge on this platform */ }
}
function notificationAllowed(n) {
  const quiet = quietHolds((n.session && n.session.cwd) || n.cwd || null);
  if (quiet) { console.log(`[notify] held (${quiet}): ${n.key}`); return false; }
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
const AwayOpen = require('./src/away-open.js');
async function openAwayItem(i) {
  const recap = BusyWatch.recap();
  const item = recap && recap.items[Number(i) || 0];
  if (!item) return { opened: 'none' };
  if (item.cwd) clipboard.writeText(item.cwd);
  return AwayOpen.openAway({ item, sessions: aggregateState().sessions || [], jump: jumpToSession, isRemote });
}
ipcMain.handle('away-open', (_e, i) => openAwayItem(i));
ipcMain.handle('away-dismiss', () => { BusyWatch.dismiss(); stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); });
// ── Budget notice (src/budget-notice.js) ───────────────────────────────────
// A Give-to-Claude run stopped at its budget. Any such event is for the
// signed-in person (runs execute only on their runner). The widget row, the
// tray item and one notification all open the board card through the Plexiform
// window's fragment; this process never reads the hub token or calls the hub.
const BudgetNotice = require('./src/budget-notice.js');
const budgetNotices = BudgetNotice.createNotices();
const BUDGET_TRAY_ITEMS = 3;
const budgetChanged = () => { stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); refreshTrayMenu(); };
function handleBudgetEvent(ev) {
  const r = budgetNotices.handle(ev);
  if (!r.changed) return;
  if (r.notify) notifyBudget(r.notice);
  budgetChanged();
}
function notifyBudget(n) {
  console.log(`[budget] ${n.runId} — ${BudgetNotice.text(n)}`);
  if (IS_DEV_RUN || loadConfig().notifyOnStates === false || !Notification.isSupported()) return;
  // The widget row and tray item still show it; only the notification waits.
  if (!pingAllowed(null, { signal: 'budget' })) return;
  const note = new Notification({ title: 'Run reached its budget', body: BudgetNotice.text(n), silent: true });
  liveNotifications.add(note);
  note.on('click', () => { liveNotifications.delete(note); openBudgetNotice(n.runId).then((r) => { if (!r || !r.ok) openBuddy(BudgetNotice.CONTRACT.boardPage); }); });
  note.on('close', () => liveNotifications.delete(note));
  note.show();
}
// The Plexiform window may not offer a fragment opener yet (and a dev spec can
// stand one in): then the answer is {ok:false} and the widget says where to go.
async function openBudgetNotice(runId) {
  const n = budgetNotices.get(runId);
  if (!n) return { ok: false };
  const spy = IS_DEV_RUN && !app.isPackaged && process.env.CLAUDE_BUDDY_BUDGET_HOOK === '1' ? global.__budgetOpenWithFragment : null;
  try {
    const open = spy || (devMockReady ? getBuddy()[BudgetNotice.CONTRACT.openMethod]?.bind(getBuddy()) : null);
    if (typeof open !== 'function') return { ok: false };
    showDock();
    const r = await open(BudgetNotice.CONTRACT.boardPage, BudgetNotice.fragment(n));
    return { ok: !(r && r.ok === false) };
  } catch (err) { console.warn('[budget] open failed:', err.message); return { ok: false }; }
}
ipcMain.handle('budget-notice', (e, msg) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return { ok: false };
  const runId = msg && typeof msg.runId === 'string' ? msg.runId : '';
  if (msg && msg.action === 'dismiss') { budgetNotices.dismiss(runId); budgetChanged(); return { ok: true }; }
  if (msg && msg.action === 'board') { openBuddy(BudgetNotice.CONTRACT.boardPage); return { ok: true }; }
  if (msg && msg.action === 'open') return openBudgetNotice(runId);
  return { ok: false };
});
if (IS_DEV_RUN && !app.isPackaged && process.env.CLAUDE_BUDDY_BUDGET_HOOK === '1') global.__budgetInject = handleBudgetEvent;
utilityHandle('busy-status', e => settingsOnly(e), () => BusyWatch.status());
// Settings' "Reconnect calendar": macOS forgot an earlier grant, so ask again.
utilityHandle('busy-reconnect-calendar', e => settingsOnly(e), async () => { await BusyWatch.enableCalendar(); return BusyWatch.status(); });
utilityHandle('busy-open-privacy', e => settingsOnly(e), () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'));

// ── Motion gate ────────────────────────────────────────────────────────────
// backgroundThrottling is off, so Chromium never tells a page nobody can see
// it. Every reason the widget can't be seen (hidden, minimised, screen locked,
// asleep, displays off) feeds one gate — menu-bar-only mode (item 10) will
// call setMotionPaused('menu-bar', …); while it holds, the renderer stops its
// clocks and main stops the cursor poll, the overlay, the garden, roaming and
// status pushes.
const widgetMotion = createMotionGate((paused) => {
  if (win && !win.isDestroyed()) { win.webContents.send('motion-paused', paused); syncBackgroundThrottling(win.webContents, paused); }
  syncEyePoll();
  // Whatever changed while paused lands the moment it's back.
  if (!paused) broadcastStatus();
});
// Low-power mode (src/low-power.js) applies to the desk widget only: the
// Lights editor's previews exist to show every animation at full rate.
let lowPowerOn = false;
// Fast hook path (hooks/fast-hook.js), off unless `fastHook` is set: hooks hand
// frequent events to this process instead of doing the work in their own.
const fastHookSocket = IS_DEV_RUN || DEMO ? null : require('./src/hook-socket.js').create({
  rootDir: ROOT_DIR,
  handle: (msg) => require('./src/hook-inprocess.js').runForwarded({ hooksDir: HOOKS_DIR, rootDir: ROOT_DIR, msg }),
  log: (m) => console.log(m),
});
function syncFastHook() {
  if (!fastHookSocket) return;
  if (loadConfig().fastHook === true || process.env.PLEXIFORM_FAST_HOOK === '1') fastHookSocket.start();
  else fastHookSocket.stop();
}
onQuit(app, () => fastHookSocket?.stop());
function applyLowPower() {
  let onBattery = false;
  try { onBattery = powerMonitor.isOnBatteryPower(); } catch { /* no power source info */ }
  lowPowerOn = resolveLowPower({ mode: loadConfig().lowPower, platform: process.platform, onBattery });
  if (win && !win.isDestroyed()) win.webContents.send('low-power', lowPowerOn);
}
function setMotionPaused(reason, on) { return widgetMotion.set(reason, !!on); }

// The editor's previews run every animation the rules can pick, at full
// rate; hidden, minimised or behind a locked screen that is pure waste.
const lightsMotion = createMotionGate((paused) => {
  if (lightsWin && !lightsWin.isDestroyed()) { lightsWin.webContents.send('motion-paused', paused); syncBackgroundThrottling(lightsWin.webContents, paused); }
});

// Spend, GitHub and busy/Focus share one tick (src/away-feeds.js) that holds
// only while the machine sleeps.
let gitTick = null;
const awayFeeds = createAwayFeeds({
  busyWatch: BusyWatch,
  feeds: () => [refreshSpend, ...(gitTick ? [gitTick] : [])],
});

// Machine-wide reasons (locked, asleep, displays off) apply to every gate.
const machineReasons = new Set();
function pauseEverywhere(reason, on) {
  if (on) machineReasons.add(reason); else machineReasons.delete(reason);
  setMotionPaused(reason, on);
  lightsMotion.set(reason, on);
  awayFeeds.power(reason, on);
  syncMachineReconcile();
}

// A missed unlock or wake notification would leave the widget frozen for
// good. While a lock or displays-off reason stands, check once a minute
// whether someone is plainly back.
let machineReconcileTimer = null;
function syncMachineReconcile() {
  const want = machineReasons.has('locked') || machineReasons.has('screens-asleep');
  if (want && !machineReconcileTimer) {
    machineReconcileTimer = every(60 * 1000, () => {
      const stale = staleMachineReasons([...machineReasons], powerMonitor.getSystemIdleState(60), powerMonitor.getSystemIdleTime());
      for (const r of stale) { console.log(`[motion] clearing a stale '${r}'`); pauseEverywhere(r, false); }
    }, 'motion-reconcile');
  } else if (!want) machineReconcileTimer = stopTimer(machineReconcileTimer);
}

function watchPowerForMotion() {
  powerMonitor.on('on-battery', applyLowPower);
  powerMonitor.on('on-ac', applyLowPower);
  powerMonitor.on('lock-screen', () => pauseEverywhere('locked', true));
  powerMonitor.on('unlock-screen', () => pauseEverywhere('locked', false));
  powerMonitor.on('suspend', () => pauseEverywhere('suspended', true));
  powerMonitor.on('resume', () => pauseEverywhere('suspended', false));
  if (IS_MAC) {
    // Displays asleep without a lock (energy saver, a closed lid on a dock).
    systemPreferences.subscribeWorkspaceNotification('NSWorkspaceScreensDidSleepNotification', () => pauseEverywhere('screens-asleep', true));
    systemPreferences.subscribeWorkspaceNotification('NSWorkspaceScreensDidWakeNotification', () => pauseEverywhere('screens-asleep', false));
    // An app launching or coming to the front may be the terminal gaining its
    // Dock icon (or leaving the front): the roam probe looks again soon.
    for (const n of ['NSWorkspaceDidLaunchApplicationNotification', 'NSWorkspaceDidActivateApplicationNotification']) systemPreferences.subscribeWorkspaceNotification(n, () => roamProbe.wake());
  }
}

let eyeTimer = null;
function syncEyePoll() {
  // The visual tests screenshot a still face; a live cursor would shift it.
  const want = DEMO !== 'visual' && app.isReady() && !widgetMotion.paused;
  if (want && !eyeTimer) { eyeTimerMs = Motion.MOTION.eyes.pollMs; eyeTimer = every(eyeTimerMs, eyeTick, 'eyes'); }
  else if (!want) eyeTimer = stopTimer(eyeTimer);
}
let eyeTimerMs = 0;
function retuneEyePoll() {
  if (!eyeTimer) return;
  const E = Motion.MOTION.eyes;
  const ms = eyePollMs({ now: Date.now(), movedAt: eyeMovedAt, holdMs: E.holdMs, fastMs: E.pollMs });
  if (ms === eyeTimerMs) return;
  eyeTimerMs = ms;
  stopTimer(eyeTimer);
  eyeTimer = every(ms, eyeTick, 'eyes');
}

function createWindow() {
  if (win && !win.isDestroyed()) return win;
  const saved = readBounds();
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const defaultWidth = 100;
  const defaultHeight = Math.round(defaultWidth / WIDGET_ASPECT);

  const w = win = new BrowserWindow({
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
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  w.setAlwaysOnTop(true, 'floating', 1);
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setAspectRatio(WIDGET_ASPECT);
  w.loadFile('index.html');
  // ready-to-show is unreliable for transparent windows on macOS, so show on
  // load, with a fallback in case that never fires either.
  const current = () => win === w && !w.isDestroyed();
  const reveal = () => { if (current() && !w.isVisible() && loadConfig().showWidget) w.showInactive(); };
  w.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 1500);

  let recovering = false;
  guardRenderer(w, 'widget', () => {
    if (win !== w || recovering) return;
    recovering = true;
    try { if (!w.isDestroyed()) w.destroy(); } catch { /* retain the current owner if disposal failed */ }
    if (!w.isDestroyed()) { recovering = false; return; }
    if (win === w) win = null;
    // Let synchronous destroy/crash handlers finish replacing the window first.
    queueMicrotask(() => { if (!win || win.isDestroyed()) createWindow(); });
  });
  // A reload loses the widget's state; re-push it as soon as it's back.
  w.webContents.on('did-finish-load', () => { if (!current()) return; stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); });

  w.on('resize', () => { if (current()) saveBounds(); });
  w.on('move', () => { if (current() && !glideTimer) saveBounds(); });
  // Each event re-reads both from the window: a restore can bring back a
  // window that was hidden before it was minimised, with no 'show' at all.
  const syncVisibility = (visible) => {
    if (!current()) return;
    if (visible === undefined) visible = w.isVisible();
    const minimized = w.isMinimized();
    setMotionPaused('minimized', minimized);
    if (!current()) return;
    setMotionPaused('hidden', !visible && !minimized);
  };
  w.on('show', () => syncVisibility(true));
  w.on('hide', () => syncVisibility(false));
  w.on('restore', () => syncVisibility());
  w.on('minimize', () => syncVisibility());
  // Those only fire on a change; a widget that loads hidden (showWidget off),
  // or reloads while paused, must still start in the right state.
  w.webContents.on('did-finish-load', () => {
    if (!current()) return;
    syncVisibility();
    if (!current()) return;
    w.webContents.send('motion-paused', widgetMotion.paused);
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  return w;
}

function createSettingsWindow() { openBuddy('settings'); }

// ── Feedback ("Something's off / Idea") ──────────────────────────────────────
// One main app page, opened from the tray and Preferences. Saved
// reports stay on this computer; nothing is sent unless the person clicks a
// send option (see src/feedback.js).
let feedbackShot = null; // the PNG the preview showed: what is saved is what they saw
let feedbackCaptureEpoch = 0;
let feedbackLast = null; // { folder, text } of the report just saved
const FEEDBACK_DIR = path.join(ROOT_DIR, 'feedback');
const feedbackSenderOk = (e) => fromUtilityPage(e, 'feedback');

function createFeedbackWindow() { openBuddy('feedback'); }

// Only Plexiform's own windows, never the screen or another app.
function feedbackTargets() {
  const all = [
    { id: 'widget', label: 'the widget', w: win },
    { id: 'lights', label: 'Lights', w: lightsWin },
    { id: 'main', label: 'Main app page', capture: () => buddyWin.captureContent(), visible: buddyWin?.isVisible() },
  ];
  return all.filter((t) => t.capture ? t.visible : t.w && !t.w.isDestroyed() && t.w.isVisible());
}

function feedbackDraft(d) {
  if (!d || typeof d !== 'object') throw new Error('bad draft');
  const home = os.homedir();
  return Feedback.buildReport({
    kind: d.kind, text: String(d.text || '').slice(0, Feedback.MAX_TEXT * 2), expected: String(d.expected || '').slice(0, Feedback.MAX_TEXT * 2),
    version: app.getVersion(), os: `${process.platform} ${IS_MAC ? process.getSystemVersion() : os.release()} ${process.arch}`, home,
  });
}

ipcMain.handle('open-feedback', (e) => { if (settingsOnly(e)) createFeedbackWindow(); });
ipcMain.handle('feedback-info', (e) => {
  if (!feedbackSenderOk(e)) return null;
  const t = feedbackTargets();
  return { windows: t.map(({ id, label }) => ({ id, label })), github: Feedback.senders.find((s) => s.id === 'github').available(loadConfig()), maxText: Feedback.MAX_TEXT };
});
ipcMain.handle('feedback-screenshot', async (e, id) => {
  if (!feedbackSenderOk(e)) return null;
  const epoch = ++feedbackCaptureEpoch;
  feedbackShot = null;
  const t = feedbackTargets().find((x) => x.id === id);
  if (!t) return { error: 'That window is not open.' };
  try {
    const img = t.capture ? await t.capture() : await t.w.webContents.capturePage();
    if (!feedbackSenderOk(e) || epoch !== feedbackCaptureEpoch) return null;
    if (!feedbackTargets().some(x => x.id === id) || !img || img.isEmpty()) return { error: 'Could not capture that window. Try again.' };
    feedbackShot = img.toPNG();
    return { dataUrl: `data:image/png;base64,${feedbackShot.toString('base64')}`, label: t.label };
  } catch {
    return feedbackSenderOk(e) && epoch === feedbackCaptureEpoch ? { error: 'Could not capture that window. Try again.' } : null;
  }
});
ipcMain.handle('feedback-clear-screenshot', (e) => { if (feedbackSenderOk(e)) { feedbackCaptureEpoch++; feedbackShot = null; } });
ipcMain.handle('feedback-preview', (e, d) => {
  if (!feedbackSenderOk(e)) return null;
  try { return { markdown: feedbackDraft(d).markdown, diagnostics: d.diagnostics ? buildDiagnostics() : '' }; } catch (err) { return { error: err.message === 'empty' ? 'Say what happened first.' : 'Could not read that.' }; }
});
ipcMain.handle('feedback-save', (e, d) => {
  if (!feedbackSenderOk(e)) return null;
  let report;
  try { report = feedbackDraft(d); } catch (err) { return { error: err.message === 'empty' ? 'Say what happened first.' : 'Could not read that.' }; }
  try {
    const diagnostics = d.diagnostics ? buildDiagnostics() : '';
    const shot = d.screenshot ? feedbackShot : null;
    const folder = Feedback.save({ dir: FEEDBACK_DIR, report, diagnostics, screenshot: shot });
    feedbackLast = { folder, report, diagnostics, shot: !!shot, text: Feedback.reportAsText(report, diagnostics) };
    return { ok: true };
  } catch (err) {
    console.warn('[feedback] save failed:', err.message);
    return { error: "Couldn't save the report." };
  }
});
ipcMain.handle('feedback-show', (e) => { if (feedbackSenderOk(e) && feedbackLast) shell.showItemInFolder(path.join(feedbackLast.folder, 'report.md')); });
ipcMain.handle('feedback-copy', (e) => { if (feedbackSenderOk(e) && feedbackLast) clipboard.writeText(feedbackLast.text); });
ipcMain.handle('feedback-board', (e) => {
  if (!feedbackSenderOk(e)) return null;
  return Feedback.sendToBoard({ last: feedbackLast, buddyWin });
});
ipcMain.handle('feedback-github', (e) => {
  if (!feedbackSenderOk(e) || !feedbackLast) return false;
  const url = Feedback.githubUrl(loadConfig().feedbackRepo, feedbackLast.report, feedbackLast.diagnostics, { screenshot: feedbackLast.shot });
  if (!url) return false;
  shell.openExternal(url); // privacy-flow: feedback-github
  return true;
});

// About & Updates always opens the main app page.
function createUpdatesWindow() { openBuddy('updates'); }

// Hatch: make a character from a few choices (characters/hatch.js), keep it
// under <data dir>/characters (src/character-store.js). The page only ever
// sends choices; main keeps what it generated and saves that by token, so a
// compromised page cannot write art of its own. Everything is validated on the
// way in and again when read back.
const CharacterStore = require('./src/character-store.js');
const Hatch = require('./characters/hatch.js');
const characterStore = CharacterStore.create({ dir: path.join(ROOT_DIR, 'characters'), log: (m) => console.warn(m) });
const hatchResults = new Map();
function broadcastCharacters() {
  buddyWin?.sendToPage('hatch', 'characters:changed');
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('characters:changed');
}
function createHatchWindow() { openBuddy('hatch'); }
const fromHatch = (e) => fromUtilityPage(e, 'hatch');
utilityHandle('characters:list', e => widgetOnly(e) || widgetConfigSender(e) || fromHatch(e), () => characterStore.list().map((c) => c.character));
ipcMain.handle('hatch:open', (e) => { if (widgetConfigSender(e)) createHatchWindow(); });
ipcMain.handle('hatch:close', (e) => { if (fromHatch(e)) createLightsWindow(); });
// ai: false until the hand-off engine can run a hidden AI task (the template path is the fallback either way)
ipcMain.handle('hatch:options', (e) => (fromHatch(e) ? { shapes: Hatch.SHAPES, sizes: Hatch.SIZES, arms: Hatch.ARMS, accessories: Hatch.ACCESSORIES, ai: false } : null));
ipcMain.handle('hatch:surprise', (e) => (fromHatch(e) ? Hatch.surprise(Date.now()) : null));
ipcMain.handle('hatch:generate', async (e, params) => {
  if (!fromHatch(e)) return null;
  const r = await Hatch.runHatch({ params });
  if (!fromHatch(e) || !r.character) return null;
  const token = require('crypto').randomUUID();
  hatchResults.set(token, { character: r.character, params: r.params, source: r.source });
  while (hatchResults.size > 8) hatchResults.delete(hatchResults.keys().next().value);
  return { token, character: r.character, source: r.source };
});
ipcMain.handle('hatch:save', (e, token) => {
  if (!fromHatch(e)) return { error: 'Not allowed.' };
  const made = typeof token === 'string' ? hatchResults.get(token) : null;
  if (!made) return { error: 'Nothing to save yet.' };
  try {
    const saved = characterStore.save({ ...made.character, id: characterStore.freeId(made.character.name) }, { source: 'hatch', params: made.params });
    hatchResults.delete(token); // one token, one save
    broadcastCharacters();
    return { ok: true, id: saved.id, name: saved.name };
  } catch (err) {
    console.warn(`hatch save failed: ${err.message}`);
    return { error: /at most/.test(err.message) ? err.message : 'Could not save it.' };
  }
});
ipcMain.handle('hatch:remove', (e, id) => {
  if (!widgetConfigSender(e)) return false;
  try { const ok = characterStore.remove(id); if (ok) broadcastCharacters(); return ok; } catch { return false; }
});

// The updater service (or, in a visual-test run, a fixture stand-in). The tray is rebuilt only when its update items change.
let updaterService = null;
let updaterTrayKey = null;
let rebuildTrayMenu = null; // set by createTray: swaps the menu without recreating the tray icon
function updaterTrayItems() {
  const items = UpdateView.trayItems(updaterService && updaterService.getState());
  return items.map((i) => {
    const item = { label: i.label, enabled: i.enabled };
    if (i.id === 'check') item.click = () => { createUpdatesWindow(); updaterService.check({ user: true }); }; // a user check, so an offline or server error is shown, not swallowed
    if (i.id === 'install') item.click = async () => { const r = await updaterService.install({ when: 'now' }); if (r && (r.deferred || r.ok === false)) createUpdatesWindow(); };
    return item;
  });
}
function watchUpdater() {
  const key = () => UpdateView.trayKey(updaterService.getState());
  updaterTrayKey = key();
  updaterService.subscribe(() => {
    const next = key();
    if (next === updaterTrayKey) return;
    updaterTrayKey = next;
    if (rebuildTrayMenu) rebuildTrayMenu();
  });
}

ipcMain.handle('open-updates', e => { if (widgetOnly(e) || fromUtilityPage(e, 'updates')) createUpdatesWindow(); });

// The Plexiform main window (board, views, integrations…): buddy-window/.
const { createBuddyWindow } = require('./buddy-window');
const BRAND = require('./buddy-window/brand');
const BuddyPages = require('./buddy-window/pages');
const AppMenu = require('./src/app-menu.js');
const { fromPage } = require('./src/utility-pages.js');
const fromUtilityPage = (e, id) => fromPage(e, buddyWin?.pageWebContents(id));
const widgetConfigSender = (e) => fromPage(e, lightsWin?.webContents);
const analyticsSender = (e) => fromUtilityPage(e, 'usage') || fromUtilityPage(e, 'stats');
const configReader = (e) => widgetOnly(e) || widgetConfigSender(e) || settingsOnly(e) || analyticsSender(e);
function utilityHandle(channel, allowed, handler) {
  ipcMain.handle(channel, (e, ...args) => allowed(e) ? handler(e, ...args) : null);
}

// plexiform:// and the legacy claudebuddy:// open the same links.
const DEEP_LINK_RE = new RegExp(`^(${BRAND.SCHEMES.join('|')}):`, 'i');
let buddyWin = null;
function openLightsMix() { openBuddy('usage'); }
// Dev only (`--buddy-mock-accounts`): the loopback mock accounts hub. The
// Buddy window reads its origin once, when created, so nothing may create the
// window (a deep link, the tray, a second instance) until it is listening.
// `--buddy-mock-no-email` makes it a hub without a mailer (the Google/GitHub delete check).
const devMock = !app.isPackaged && process.argv.includes('--buddy-mock-accounts') ? require('./buddy-window/mock-accounts-hub').createMockAccountsHub({ log: (m) => console.log(m), methods: process.argv.includes('--buddy-mock-no-email') ? { email: false } : {} }) : null;
let devAccountsHub = null;
let devMockReady = !devMock;
function getBuddy() {
  if (!devMockReady) throw new Error('the dev mock accounts hub is still starting');
  if (!buddyWin) {
    buddyWin = createBuddyWindow({
      isConstrained: () => lowPowerOn,
      onOverviewRetired: () => { InteractionMain.retireDocuments().catch(() => {}); retireClaudeChannels(); },
      openWindow: (which) => {
        if (which === 'lights') createLightsWindow();
        else if (which === 'settings') createSettingsWindow();
        else if (which === 'mix') openLightsMix();
      },
      onLocalPage: (page, wc) => {
        if (page.id === 'settings' && !IS_MAC) wc.insertCSS('#busy-sources, .field:has(#busyFocusShortcut) { display: none; }').catch(() => {});
      },
      onClosed: () => { OverviewMain.invalidate(); hatchResults.clear(); feedbackShot = null; feedbackLast = null; SetupsLocal.invalidate(); if (IS_MAC && !lightsWin) app.dock.hide(); },
      devAccountsHub: app.isPackaged ? null : devAccountsHub,
      captureEnabled: !DEMO,
      handoverWriter: () => { try { return SessionHandoverMain.writer; } catch { return null; } },
    });
    if (typeof buddyWin[BudgetNotice.CONTRACT.subscribeMethod] === 'function') {
      const unsubscribe = buddyWin[BudgetNotice.CONTRACT.subscribeMethod](handleBudgetEvent);
      if (typeof unsubscribe === 'function') onQuit(app, unsubscribe);
    }
    buddyWin.attachBurst?.(() => BurstIpc);
    if (typeof buddyWin.onAccountChange === 'function') buddyWin.onAccountChange(() => {OverviewMain.invalidate();buddyWin.sendToPage('settings', 'account-changed');});
    if(typeof buddyWin.onSetupsIdentityChange==='function')buddyWin.onSetupsIdentityChange(()=>{OverviewMain.invalidate();SetupsLocal.invalidate();buddyWin.sendToPage('setups','setups:changed');});
    if(typeof buddyWin.onSetupsIdentityChange==='function')buddyWin.onSetupsIdentityChange(()=>syncInteractionHost());
  }
  return buddyWin;
}
// Optional, like the work-scope module: only a Plexiform window that offers it says who is signed in.
const accountSummary = () => { try { return typeof buddyWin?.accountSummary === 'function' ? buddyWin.accountSummary() : null; } catch { return null; } };
const MyDay = require('./src/my-day-service.js').createMyDayService({
  work: () => buddyWin?.myDay() ?? Promise.resolve({ status: 'partial', sources: [] }),
  sessions: () => localSessions(aggregateState().sessions || []),
  busy: () => BusyWatch.status(),
  calendarHelper: () => BusyWatch.helperAvailable(),
  enableCalendar: () => commitConfig({ busyCalendar: true }),
  open: handle => buddyWin?.openMyDayCard(handle) ?? false,
});
const myDaySender = e => !!e.sender && e.sender === buddyWin?.pageWebContents('myday') && e.senderFrame === e.sender.mainFrame;
const SessionOverview = require('./src/session-overview.js');
const ProviderStatus = require('./src/provider-status.js');
const sessionsSender = e => fromUtilityPage(e, 'sessions');
const WorktreeShare = require('./src/worktree-share.js').createWorktreeShare({ log: console.log });
ipcMain.handle('sessions:state', e => {
  if (!sessionsSender(e)) return null;
  try {
    const configured = IS_DEV_RUN ? false : Adapters.get('codex').isActivityInstalled({ home: os.homedir(), runtime: HOOK_RUNTIME });
    return SessionOverview.snapshot({ sessions: localSessions(aggregateState().sessions || []), activity: { configured, available: true }, now: Date.now(), enrich: BurstIpc.enrichSession, info: (row) => SessionActionsMain.rowInfo(row), handover: (row) => SessionHandoverMain.view(row), sharedTrees: (rows) => WorktreeShare.shared(rows) });
  } catch {
    return SessionOverview.snapshot({ sessions: [], activity: { available: false }, available: false, now: Date.now() });
  }
});
const SessionActionsMain = require('./src/session-actions-main.js').register({ ipcMain, sessionsAllowed: sessionsSender, sessions: () => localSessions(aggregateState().sessions || []), bridge: () => buddyWin?.sessionBridge, capture: () => buddyWin, tasks: () => { const t = getTasks(); t.start(); return t; }, clipboard, openPage: (id) => openBuddy(id), pageExists: (id) => !!BuddyPages.pageById(id), pickFolder: async () => { const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(buddyWin?.pageWebContents('sessions')) || undefined, { title: 'Choose the folder', properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; } });
ipcMain.handle('sessions:message', (e, session, text) => {
  if (!sessionsSender(e)) return { ok: false, error: 'Not allowed.' };
  if (typeof session !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 500) return { ok: false, error: 'Write a message first.' };
  return { ok: false, error: 'Messaging a session Plexiform started is not available from this page yet. Use its card in the Overview.' };
});
ipcMain.handle('sessions:settings', e => { if (!sessionsSender(e)) return false; createSettingsWindow(); return true; });
// Overview uses main-owned structured reports/current own-board work only.
// Teammates' shared sessions come from a team hub directory. Until the real
// hub's directory client lands, a FAKE in-memory hub (clearly labelled as
// test data in the page) can be loaded from a fixture file for demos/tests.
let overviewTeams={host:null,at:0,value:null},overviewTeamHub=null;
const liveTeamHub=require('./src/team-hub-live').createLiveTeamHub({identity:()=>devMockReady?getBuddy().interactionHostIdentity?.()??null:null,fetch:(...a)=>net.fetch(...a)}); // privacy-flow: team-hub-directory
if(IS_DEV_RUN&&!app.isPackaged&&process.env.CLAUDE_BUDDY_FAKE_TEAM_HUB){try{overviewTeamHub=require('./src/team-hub-fake').createFakeTeamHub(JSON.parse(fs.readFileSync(process.env.CLAUDE_BUDDY_FAKE_TEAM_HUB,'utf8')));}catch(e){console.warn('[overview] fake team hub not loaded:',e.message);}}
const OverviewMain=require('./src/overview-main').createOverviewMain({
  buddy:()=>buddyWin,sessions:()=>aggregateState().sessions||[],
  work:()=>buddyWin?.overviewWork()??Promise.resolve({sources:[],capture:[],partial:true}),
  managed:()=>{const service=getTasks();service.start();return service.snapshot();},
  openManaged:async(_id,fresh)=>{if(!fresh())return false;openBuddy('tasks');return true;},
  messageManaged:(id,text,fresh)=>fresh()?getTasks().act({id,action:'message',payload:{body:text}},0,fresh):Promise.resolve({ok:false}),
  // Session directory (My sessions / Team sessions); see src/session-directory.js.
  owned:()=>{InteractionMain.reportHooks(aggregateState().sessions||[]);return InteractionMain.listOwned();},
  // hostSync (declared below) is only read when Overview asks, after startup.
  shares:()=>{const h=hostSync.host(),origin=hostSync.origin();return h&&origin?{origin,list:h.shared()}:null;},
  hubTeams:async()=>{const h=hostSync.host(),origin=hostSync.origin();if(!h||!origin)return null;if(overviewTeams.host===h&&Date.now()-overviewTeams.at<30_000)return overviewTeams.value;
    const r=await h.listShares().catch(()=>null);overviewTeams={host:h,at:Date.now(),value:r?.ok?{origin,teams:r.teams}:null};return overviewTeams.value;},
  teamHub:()=>overviewTeamHub||liveTeamHub.current(),
});
OverviewMain.register(ipcMain);
overviewTeamHub?.onChange(()=>OverviewMain.directoryChanged());
if(!overviewTeamHub)liveTeamHub.onChange(()=>OverviewMain.directoryChanged());
onQuit(app,()=>{liveTeamHub.close();OverviewMain.close();});
// Owned-session interaction: Plexiform starts its own provider sessions and
// talks only to those. Existing unmanaged sessions stay observation-only.
const CodexAppServer=require('./src/codex-app-server');
const codexBin=CodexAppServer.findCodexBin();
// Compactor savings: numbers only, no message text (src/compaction-stats.js).
const CompactionLedger=require('./src/compaction-stats').createLedger({file:path.join(ROOT_DIR,'compaction-stats.json')});
// Existing Codex CLI sessions on Codex's shared daemon: only after the
// Preferences opt-in, only while the human runs the daemon (never started here).
const CodexDaemon=require('./src/codex-daemon').createCodexDaemon({bin:codexBin,enabled:()=>loadConfig().codexDaemonMessaging===true,clientVersion:app.getVersion()});
const ClaudeChannel=require('./src/claude-channel-session');
const claudeChannel=ClaudeChannel.createClaudeChannelSession();
const channelBoards=new Map(),channelFolders=new Set();
function retireClaudeChannels(){for(const target of channelBoards.keys())claudeChannel.revoke(target);channelBoards.clear();for(const folder of channelFolders)try{fs.rmSync(folder,{recursive:true,force:true});}catch{}channelFolders.clear();}
const attachClaudeChannel=claudeChannel.attach.bind(claudeChannel);
claudeChannel.attach=async args=>{
  if(channelBoards.get(args.target)!==buddyWin?.status?.().workspace)throw new Error('Return to the workspace where this terminal connection was prepared.');
  return attachClaudeChannel(args);
};
const InteractionMain=require('./src/interaction-main').createInteractionMain({
  compaction:Compaction.createSessionCompactor({settings:()=>loadConfig().compaction,ledger:CompactionLedger}),
  context:()=>buddyWin?.overviewContext?.()??null,
  readContext:()=>buddyWin?.overviewReadContext?.()??null,
  adapters:{codex:Object.assign(CodexAppServer.createCodexAppServer({bin:codexBin,clientVersion:app.getVersion()}),codexBin?{}:{available:false,reason:'Codex CLI not found'}),'codex-daemon':CodexDaemon,'claude-channel':claudeChannel},
  prepareChannel:async({board,fresh})=>{
    if(process.platform==='win32')return {ok:false,status:'unavailable',error:'Terminal channel setup requires a reviewed Windows private-file publisher.'};
    const choice=await dialog.showOpenDialog(buddyWin.overviewContext().window,{title:'Choose the Claude terminal project',properties:['openDirectory']});
    if(choice.canceled||choice.filePaths.length!==1||!fresh())return {ok:false,status:'stale',error:'Setup cancelled or workspace changed.'};
    const cwd=fs.realpathSync(choice.filePaths[0]);await claudeChannel.start();
    if(!fresh())return {ok:false,status:'stale',error:'The Overview changed during setup.'};
    const grant=claudeChannel.createGrant({cwd,title:path.basename(cwd).slice(0,100)||'Claude terminal'});
    let folder;
    try{
      folder=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'plexiform-channel-')));fs.chmodSync(folder,0o700);channelFolders.add(folder);
      const recipe=ClaudeChannel.writeClaudeChannelConfig({grant,directory:folder,command:process.execPath,args:[path.join(app.getAppPath(),'src','claude-channel-server.js')],electronRunAsNode:true});
      if(!fresh()){claudeChannel.revoke(grant.target);fs.rmSync(folder,{recursive:true,force:true});channelFolders.delete(folder);return {ok:false,status:'stale',error:'The Overview changed during setup.'};}
      channelBoards.set(grant.target,board);
      const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
      return {ok:true,status:'prepared',command:'claude '+recipe.claudeArgs.map(quote).join(' '),note:'Run this in the chosen project. Claude shows the channel research-preview confirmation; approve it yourself. Then select Claude terminal channel and Find sessions. To connect prior work, add --resume and choose it in Claude. Messages retain that terminal’s permissions and team messages use your quota.'};
    }catch{claudeChannel.revoke(grant.target);if(folder){fs.rmSync(folder,{recursive:true,force:true});channelFolders.delete(folder);}return {ok:false,status:'unavailable',error:'Could not prepare a private terminal configuration.'};}
  },
  // Empty private folder outside Plexiform's data directory.
  workspace:()=>fs.mkdtempSync(path.join(os.tmpdir(),'plexiform-owned-')),
  // The active workspace (My board or a team board) the sidebar shows.
  currentBoard:()=>buddyWin?.status?.().workspace??null,
  localModelsFile:path.join(app.getPath('userData'),'local-models.json'),
  // Team sharing of Overview sessions goes through the remote host below (null while it is off).
  shares:()=>hostSync.host(),
});
InteractionMain.register(ipcMain);
onQuit(app,()=>InteractionMain.close());
onQuit(app,retireClaudeChannels);
ipcMain.handle('compaction-stats',e=>settingsOnly(e)?{...CompactionLedger.summary(),settings:loadConfig().compaction,burstNote:BurstIpc.compactionNote()}:null);
// Remote interaction host (src/remote-interaction.js): OFF unless the
// "Let my other devices use sessions Plexiform started on this Mac"
// preference is ticked. Uses the active team hub's own device sign-in (via
// buddyWin.interactionHostIdentity; held in memory only for the role reset,
// never written or logged) and its own interaction hub, separate from
// Overview's. Signing out, another account, unticking or quitting ends it and
// its remote sessions (src/interaction-host-sync.js).
const RemoteInteraction=require('./src/remote-interaction');
const SessionMessaging=require('./src/session-messaging');
const hostSync=require('./src/interaction-host-sync').createInteractionHostSync({
  want:()=>devMockReady&&(loadConfig().remoteInteractionHost===true||(loadConfig().teamSessionSharing!==false&&getBuddy().nativeBoardWorkspaces().length>0)),
  identity:()=>devMockReady?getBuddy().interactionHostIdentity?.()??null:null,
  createHost:id=>RemoteInteraction.createRemoteInteractionHost({
    userId:id.userId,
    adapters:{codex:Object.assign(CodexAppServer.createCodexAppServer({bin:codexBin,clientVersion:app.getVersion()}),codexBin?{}:{available:false,reason:'Codex CLI not found'})},
    workspace:()=>fs.mkdtempSync(path.join(os.tmpdir(),'plexiform-owned-')),
    boardCurrent:board=>board===null,
    log:m=>console.log(m),
    // An Overview session is reachable by teammates only while its owner shares it.
    sharedTarget:session=>InteractionMain.sharedTarget(session),
  }),
  connect:(host,o)=>host.enable({...o,WebSocket:require('ws')}), // privacy-flow: remote-interaction
  resetRole:RemoteInteraction.resetRole,
  fetch:(...a)=>net.fetch(...a), // privacy-flow: remote-interaction
  pending:{get:()=>loadConfig().remoteInteractionResetPending??null,set:v=>saveConfig({remoteInteractionResetPending:v})},
  log:m=>console.log(m),
  // Messages and handoffs (board/MESSAGING.md) into this host's sessions: only
  // while hosting is on and connected; stopped with it (sign-out, revoke,
  // unticking, quit). Team scope comes only from this Mac's team-sharing record.
  attach:(host,id)=>{
    const recv=SessionMessaging.createSessionMessagingHost({baseUrl:id.origin,token:id.token,fetch:(...a)=>net.fetch(...a),remote:host, // privacy-flow: session-messaging
      shares:session=>{const sh=host.shared().find(x=>x.session===session&&x.scope==='interact');return sh?{scope:'team',org_id:sh.team.id}:null;},
      log:m=>console.log(m)});
    recv.start();
    return recv;
  },
});
function syncInteractionHost(){hostSync.sync();}
onQuit(app,()=>hostSync.close());
// While anything is shared, refresh who has access (members who joined or left) and drop shares a team admin ended.
const TeamSessionSharing=require('./src/team-session-sharing').createTeamSessionSharing({
  host:()=>loadConfig().teamSessionSharing===false?null:hostSync.host(),origin:()=>hostSync.origin(),
  sessions:()=>InteractionMain.listOwned(),
  association:key=>{
    if(typeof key!=='string')return null;
    for(const w of getBuddy().nativeBoardWorkspaces())if(require('./src/interaction-main').boardKey(w.id)===key){
      const c=getBuddy().nativeBoardContext(w.id);return c?{origin:c.workspace.hub,team:c.workspace.teamId}:null;
    }
    return null;
  },onChange:()=>OverviewMain.directoryChanged(),
});
let manualShareRefresh=null;
setInterval(()=>{InteractionMain.reportHooks(aggregateState().sessions||[]);if(loadConfig().teamSessionSharing===false){const h=hostSync.host();if(h?.shared().length&&!manualShareRefresh)manualShareRefresh=h.listShares().catch(()=>{}).finally(()=>{manualShareRefresh=null;});}TeamSessionSharing.sync().catch(()=>{});},5000).unref?.();
onQuit(app,()=>TeamSessionSharing.stop());
const INTERACTION_HOST_LINES={connecting:'Connecting…',connected:'On: your other signed-in devices can use sessions started from them on this Mac.',retrying:'Can\'t reach your team hub; retrying.','signed-out':'Stopped: this Mac is signed out or was removed from your account.',replaced:'Stopped: another connection took over this Mac\'s sign-in. If that wasn\'t you, remove this device in Account and sign in again.',refused:'Stopped: the hub named a different account.',held:'Stopped: another connection is using this Mac\'s sign-in, so your devices can\'t reach it. If that wasn\'t you, remove this Mac from your account (Account → Devices) and sign in again.'};
ipcMain.handle('interaction-host-status',e=>{
  if(!settingsOnly(e))return null;
  if(loadConfig().remoteInteractionHost!==true&&loadConfig().teamSessionSharing===false)return 'Off.';
  const host=hostSync.host();
  if(!host)return 'Sign in to a team hub to turn this on.';
  const st=host.status();
  return [INTERACTION_HOST_LINES[st.state]??'',st.notice??''].filter(Boolean).join(' ');
});

ipcMain.handle('myday:state', e => myDaySender(e) ? MyDay.snapshot() : null);
ipcMain.handle('myday:show-meetings', e => myDaySender(e) ? MyDay.showMeetings() : false);
ipcMain.handle('myday:open', (e, handle) => myDaySender(e) && typeof handle === 'string' && handle.length <= 100 ? MyDay.open(handle) : false);
function openBuddy(page = null) {
  if (!devMockReady) return;
  getBuddy();
  showDock();
  buddyWin.open(page);
}

const SetupsNative = require('./src/setups-service.js').createSetupsService({
  sources:()=>buddyWin?.setupSources()??Promise.resolve([]),home:os.homedir(),
  machine:()=>({user:os.userInfo().username,hostname:os.hostname()}),
  async confirm(summary) {
    const answer=await dialog.showMessageBox({type:'warning',title:'Share reviewed setup',message:`Share ${summary.files} reviewed files and ${summary.items} inventory entries with ${summary.team}?`,detail:'All current staff in this team can read this setup. Review filenames, full text, notes and inventory for private information before sharing. This publishes configuration; it does not apply or run it.',buttons:['Cancel','Share reviewed setup'],defaultId:0,cancelId:0,noLink:true});
    return answer.response===1;
  },
  async chooseExport() {
    const result=await dialog.showSaveDialog({title:'Export your shared setup',defaultPath:'plexiform-setup.json',filters:[{name:'Reviewed setup',extensions:['json']}]});
    if(result.canceled || !result.filePath) return null;
    // This chosen path remains in main. Exclusive/no-follow creation protects
    // existing files and links; no renderer-supplied destination is accepted.
    return text=>{let fd;try{fd=fs.openSync(result.filePath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}};
  },
});
const setupsSender=e=>!!e.sender && e.sender===buddyWin?.pageWebContents('setups') && e.senderFrame===e.sender.mainFrame;
ipcMain.handle('setups:state',e=>setupsSender(e)?SetupsNative.snapshot():null);
ipcMain.handle('setups:read',(e,handle)=>setupsSender(e)?SetupsNative.read(handle):null);
ipcMain.handle('setups:draft',(e,handle,input)=>setupsSender(e)?SetupsNative.draft(handle,input):null);
ipcMain.handle('setups:edit',(e,handle,input)=>setupsSender(e)?SetupsNative.edit(handle,input):null);
ipcMain.handle('setups:approve',(e,handle,file,hash)=>setupsSender(e)?SetupsNative.approve(handle,file,hash):null);
ipcMain.handle('setups:publish',(e,handle,hash)=>setupsSender(e)?SetupsNative.publish(handle,hash):null);
ipcMain.handle('setups:action',(e,handle,op,input)=>setupsSender(e)?SetupsNative.action(handle,op,input):null);
ipcMain.handle('setups:export',(e,handle)=>setupsSender(e)?SetupsNative.export(handle):null);
// The embedded page remains pending until actual packaged Apply/recovery/Undo
// acceptance. No dev helper or renderer-supplied local authority is a fallback.
const SetupsLocal=require('./src/setups-main').createSetupsMain({app,buddy:()=>buddyWin,service:SetupsNative,dialog,safeStorage:require('electron').safeStorage,accepted:false});
SetupsLocal.register(ipcMain);
onQuit(app,()=>SetupsLocal.close());

// Settings → Account & team, and the widget's one-time Team hint. Each
// handler checks its sender; the page to open is never taken from the renderer.
const TeamEntry = require('./src/team-entry.js');
const settingsOnly = (e) => fromUtilityPage(e, 'settings');
const BurstEventsLib = require('./src/burst-events.js');
const BurstEvents = BurstEventsLib.createBurstEvents();
const burstNotes = new Map(); // event key -> shown Notification, so a resolving Burst notice can close it
// Quiet hours, snooze and mutes hold these like any other ping (src/quiet.js).
function notifyBurstEvents(events) {
  if (!events.length) return;
  const { send, held, why } = BurstEventsLib.gate(events, loadConfig(), Date.now());
  for (const ev of held) console.log(`[notify] held (${why}): ${ev.key}`);
  if (IS_DEV_RUN || loadConfig().notifyOnStates === false || !Notification.isSupported()) return;
  for (const ev of send) {
    const note = new Notification({ title: ev.title, body: ev.body, silent: true });
    liveNotifications.add(note);
    burstNotes.set(ev.key, note);
    const drop = () => { liveNotifications.delete(note); if (burstNotes.get(ev.key) === note) burstNotes.delete(ev.key); };
    note.on('click', () => { drop(); openBuddy('optimiser'); });
    note.on('close', drop);
    note.show();
  }
}
function closeBurstNote(key) {
  const note = burstNotes.get(key);
  if (note) { burstNotes.delete(key); liveNotifications.delete(note); note.close(); }
}
// Burst's own event file (notices.json); while it is watched the poll-diff events below stay quiet.
const BurstNotices = require('./src/burst-notices.js').createBurstNotices({ isMac: IS_MAC, onEvents: (events) => notifyBurstEvents(events), onResolve: closeBurstNote, config: () => loadConfig(), burst: () => BurstIpc, log: console.log });
const BurstIpc = require('./src/burst-ipc.js').register({ utilityHandle, settingsOnly, chipAllowed: (e) => widgetOnly(e) || fromUtilityPage(e, 'usage'), usageAllowed: (e) => fromUtilityPage(e, 'usage'), sessionsAllowed: sessionsSender, stateFile: path.join(ROOT_DIR, 'burst-handover.json'), runner: { live: () => !!buddyWin?.runnerLive?.(), send: (m) => buddyWin?.burstFacts?.(m) }, accountAllowed: (e) => fromPage(e, buddyWin?.accountWebContents?.()), isMac: IS_MAC, dialog, shell, scriptDir: path.join(ROOT_DIR, 'burst-scripts'), optimiserAllowed: (e) => fromUtilityPage(e, 'optimiser'), snapshotFile: require('./src/burst-snapshot.js').snapshotPath(ROOT_DIR), transcriptFor: (id) => transcriptIndex().get(id) || null, onView: (view) => { const events = BurstEvents.observe(view, Date.now()); if (!BurstNotices.active()) notifyBurstEvents(events); }, log: console.log });
BurstIpc.setOpener(() => openBuddy('optimiser'));
if (IS_MAC) BurstNotices.start();
onQuit(app, () => BurstNotices.stop());
let keepAwakeMain = null;
keepAwakeMain = require('./src/keep-awake-ipc.js').register({ utilityHandle, allowed: (e) => fromPage(e, buddyWin?.accountWebContents?.()), isMac: IS_MAC, burst: BurstIpc, keepAwake: require('./src/keep-awake.js').createKeepAwake({ powerSaveBlocker }), dialog, getPref: () => { const v = loadConfig().keepAwake; return ['app', 'ac', 'always'].includes(v) ? v : 'off'; }, setPref: (v) => saveConfig({ keepAwake: v }), log: console.log });
const SessionHandoverMain = require('./src/session-handover-main.js').register({ ipcMain, rootDir: ROOT_DIR, isExcluded: (cwd) => Quiet.projectMuted(loadConfig().mutedProjects, cwd), burstFor: (row) => { const h = BurstIpc.enrichSession({ sessionId: row.sessionId, cwd: row.cwd, source: row.adapter === 'claude-code' ? null : row.adapter }); return h && h.handover ? h.handover.text : null; }, home: os.homedir(), sessionsAllowed: sessionsSender, clipboard, shell, log: console.log });
ipcMain.handle('account-view', (e) => {
  if (!settingsOnly(e)) return null;
  return TeamEntry.settingsView(accountSummary(), new URL(BRAND.DEFAULT_HUB).host);
});
ipcMain.handle('account-open', (e, which) => {
  if (!settingsOnly(e)) return false;
  openBuddy(['team', 'signin'].includes(which) ? which : 'account');
  return true;
});
const widgetOnly = (e) => fromPage(e, win?.webContents);
const teamHint = () => TeamEntry.hintFor(accountSummary(), loadConfig().hints?.teamSeen === true);
ipcMain.handle('team-hint', (e) => widgetOnly(e) ? teamHint() : null);
ipcMain.handle('team-hint-done', (e, open) => {
  if (!widgetOnly(e)) return false;
  const hint = teamHint();
  if (!hint) return false;
  saveConfig({ hints: { ...loadConfig().hints, teamSeen: true } });
  if (open === true) openBuddy(hint.page);
  return true;
});

// Preferences scrolled to its Health section, rechecked.
function showHealth() {
  openBuddy('settings');
  buddyWin?.sendToPage('settings', 'show-section', 'health');
}

// Invite deep links (plexiform://invite/<token>, plexiform://join?hub=…&t=…, and the same under claudebuddy://).
// macOS delivers open-url before `ready` on a cold start, so links wait until
// then. The link is never logged: it carries an invite token.
const pendingLinks = [];
let linksReady = false;
function handleDeepLink(url) {
  if (typeof url !== 'string' || url.length > 2048 || !DEEP_LINK_RE.test(url)) return;
  if (!linksReady) { if (pendingLinks.length < 5) pendingLinks.push(url); return; }
  try {
    getBuddy().openInvite(url);
    openBuddy();
  } catch (err) {
    console.error(`[deep-link] could not open ${BRAND.NAME}:`, err.message);
  }
}
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });
// The updater IPC trusts the app's own pages by path, so an app window must
// never be navigated to another page (a dropped file, a stray link).
app.on('web-contents-created', (_e, wc) => Updater.guardNavigation(wc));
// Only an installed app may claim the scheme: a dev run would steal it from it.
if (app.isPackaged) for (const scheme of BRAND.SCHEMES) app.setAsDefaultProtocolClient(scheme);
// Open Lights on a view, then hand it one event (a prefill) once it can hear it.
function showLightsView(view, then = null) {
  if (view === 'mix' || view === 'stats') { openBuddy(view === 'mix' ? 'usage' : 'stats'); return; }
  if (!['rules', 'auto'].includes(view)) return;
  const fresh = !lightsWin;
  createLightsWindow();
  const wc = lightsWin?.webContents;
  const go = () => { if (!wc || wc.isDestroyed() || lightsWin?.webContents !== wc) return; wc.send('show-view', view); if (then) wc.send(then.event, then.data); };
  if (fresh || wc?.isLoading()) wc?.once('did-finish-load', go); else go();
}

// Waiting on you always opens in the main app.
function createWaitingWindow() { openBuddy('waiting'); }

// ── Tasks page ────────────────────────────────────────────────────────────
// The main app page never touches the supervisor's
// socket or token: this process does (src/tasks-service.js) and hands it
// sanitised tasks over the IPC below, every one checked for its sender.
// Dev runs point at the mock supervisor through an env var, never in a package.
let tasksSvc = null;
let tasksProcess = null;
const tasksPages = () => [buddyWin?.pageWebContents('tasks')].filter((w) => w && !w.isDestroyed());
const tasksSenderOk = (e) => !!e.sender && tasksPages().includes(e.sender) && e.senderFrame === e.sender.mainFrame;
const TASKS_SEEN_FILE = path.join(ROOT_DIR, 'tasks-seen.json');
function getTasks() {
  if (tasksSvc) return tasksSvc;
  const dev = IS_DEV_RUN && !app.isPackaged;
  const fixtureHome = dev && process.env.CLAUDE_TRAFFIC_LIGHT_TASKS_HOME;
  const dataDir = fixtureHome || path.join(app.getPath('userData'), 'tasks');
  if (!fixtureHome) {
    tasksProcess = require('./src/tasks-process.js').createTasksSupervisor({
      fork: require('electron').utilityProcess.fork,
      entry: path.join(__dirname, 'board', 'tasks-engine', 'utility-entry.js'), dataDir,
    });
  }
  tasksSvc = require('./src/tasks-service.js').createTasksService({
    boardHome: dataDir,
    ensureSupervisor: () => tasksProcess?.ensure(),
    homeDir: os.homedir(),
    copy: (text) => clipboard.writeText(text),
    onChange: (snap) => { for (const wc of tasksPages()) wc.send('tasks:changed', snap); },
    onEvent: (wcId, id, event) => { const wc = tasksPages().find((w) => w.id === wcId); if (wc) wc.send('tasks:event', { id, event }); },
    // The confirmation for the risky actions is main's: a native dialog, Cancel the default, the page's click never counts.
    confirmDialog: async (info, wcId) => {
      const wc = tasksPages().find((w) => w.id === wcId);
      const parent = (wc && BrowserWindow.fromWebContents(wc)) || undefined;
      const r = await dialog.showMessageBox(parent, {
        type: 'warning', buttons: ['Cancel', info.label], defaultId: 0, cancelId: 0, noLink: true,
        message: `${info.label}?`,
        detail: [`Task: ${info.title}`, info.where ? `Runs in: ${info.where}` : '', info.detail].filter(Boolean).join('\n'),
      });
      return r.response === 1;
    },
    seen: {
      load: () => { try { return JSON.parse(fs.readFileSync(TASKS_SEEN_FILE, 'utf8')); } catch { return {}; } },
      save: (o) => { try { SessionState.writeJsonAtomic(TASKS_SEEN_FILE, o); } catch (err) { console.warn('[tasks] seen not saved:', err.message); } },
    },
    log: (...a) => console.log('[tasks]', ...a),
  });
  return tasksSvc;
}
function createTasksWindow() { openBuddy('tasks'); }
ipcMain.handle('tasks:state', (e) => { if (!tasksSenderOk(e)) return null; const s = getTasks(); s.start(); return s.snapshot(); });
ipcMain.handle('tasks:retry', (e) => { if (tasksSenderOk(e)) getTasks().retryNow(); });
ipcMain.handle('tasks:open', (e, id) => (tasksSenderOk(e) ? getTasks().openTask(id, e.sender.id) : null));
ipcMain.handle('tasks:close', (e) => { if (tasksSenderOk(e)) return getTasks().closeTask(e.sender.id); return null; });
ipcMain.handle('tasks:act', (e, req) => (tasksSenderOk(e) ? getTasks().act(req, e.sender.id) : null));
ipcMain.handle('tasks:checkpoint', (e, req) => (tasksSenderOk(e) ? getTasks().saveCheckpoint(req, e.sender.id) : null));
ipcMain.handle('tasks:create', (e, draft) => (tasksSenderOk(e) ? getTasks().create(draft) : null));
ipcMain.handle('tasks:composer', (e) => (tasksSenderOk(e) ? getTasks().composerInfo() : null));
ipcMain.handle('tasks:copy-takeover', (e, id) => !!tasksSenderOk(e) && typeof id === 'string' && getTasks().copyTakeover(id));
// The folder comes back as an opaque handle plus a label: the page cannot name a path of its own.
ipcMain.handle('tasks:pick-folder', async (e) => {
  if (!tasksSenderOk(e)) return null;
  let dir = null;
  if (IS_DEV_RUN && !app.isPackaged && process.env.CLAUDE_TRAFFIC_LIGHT_TASKS_PICK) dir = process.env.CLAUDE_TRAFFIC_LIGHT_TASKS_PICK;
  else {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || undefined, { title: 'Choose the folder the task works in', properties: ['openDirectory', 'createDirectory'] });
    dir = r.canceled ? null : r.filePaths[0];
  }
  try { if (!dir || !path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  return getTasks().registerFolder(dir);
});
onQuit(app, () => tasksSvc?.stop());

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
    title: 'Widget configuration',
    // Off macOS 'hiddenInset' hides the window controls with the title bar.
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    backgroundColor: '#1c1a1f',
    webPreferences: {
      spellcheck: false,
      preload: path.join(__dirname, 'lights-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The live preview must keep animating when this window sits behind
      // the terminal; macOS occlusion would otherwise freeze it.
      backgroundThrottling: false,
    },
  });
  lightsWin.setMenuBarVisibility(false);
  lightsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stay = stayOnPage('lights.html');
  lightsWin.webContents.on('will-navigate', stay);
  lightsWin.webContents.on('will-redirect', stay);
  const syncLightsVisibility = (visible = lightsWin?.isVisible()) => {
    if (!lightsWin || lightsWin.isDestroyed()) return;
    lightsMotion.set('minimized', lightsWin.isMinimized());
    lightsMotion.set('hidden', !visible && !lightsWin.isMinimized());
  };
  lightsWin.on('show', () => syncLightsVisibility(true));
  lightsWin.on('hide', () => syncLightsVisibility(false));
  lightsWin.on('restore', () => syncLightsVisibility());
  lightsWin.on('minimize', () => syncLightsVisibility());
  lightsWin.webContents.on('did-finish-load', () => {
    if (!lightsWin || lightsWin.isDestroyed()) return;
    lightsWin.webContents.send('motion-paused', lightsMotion.paused);
    lightsWin.webContents.send('window-focus', lightsWin.isFocused());
  });
  // The page's own focus state can't be trusted in every host (automation
  // pins document.hasFocus()), so the window's is sent in.
  lightsWin.on('focus', () => lightsWin?.webContents.send('window-focus', true));
  lightsWin.on('blur', () => lightsWin?.webContents.send('window-focus', false));
  // The page's own title bar leaves room for the macOS traffic lights.
  if (!IS_MAC) lightsWin.webContents.on('dom-ready', () => lightsWin?.webContents.insertCSS('#titlebar { padding-left: 14px; }').catch(() => {}));
  // Dev: `electron . --lights --shot out.png [--select <ruleId>] [--mode live]`
  // captures the editor and quits.
  const shotAt = process.argv.indexOf('--shot');
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
  const query = { utility: 'widget' };
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
  showDock();
  lightsWin.on('closed', () => {
    lightsWin = null;
    // The next editor opens shown; only the machine-wide reasons carry over.
    lightsMotion.set('hidden', false);
    lightsMotion.set('minimized', false);
    if (process.platform === 'darwin' && !buddyWin?.isOpen()) app.dock.hide();
  });
}

// ── Help: "what am I looking at?" ──────────────────────────────────────────
// A small panel beside the widget that explains the current state in plain
// words. Opened from the widget's "?" and the tray; once on first run.
function createHelpWindow() { openBuddy('help'); }

const setupChecklist = require('./src/setup-checklist.js').createForHelp({ report: () => healthReport(), account: () => accountSummary(), tasks: () => tasksSvc?.snapshot().tasks ?? null, tools: () => AiTools.quick() });
function helpState() {
  const real = aggregateState({ ignoreTravel: true });
  return { ...Help.explain(real, loadConfig().rules, { travel: travelLook ? travelLook.name : null, busy: BusyWatch.status(), providerStatus: ProviderStatus.snapshot({ sessions: localSessions(real.sessions || []), online }) }), setup: setupChecklist() };
}

ipcMain.handle('open-help', e => { if (widgetOnly(e) || widgetConfigSender(e)) createHelpWindow(); });
ipcMain.handle('get-help', (e) => fromUtilityPage(e, 'help') ? helpState() : null);
// Help may navigate only these existing app pages, never a URL or command.
ipcMain.handle('help:navigate', (e, ...args) => {
  if (!fromUtilityPage(e, 'help') || args.length !== 1) return false;
  const destination = args[0];
  if (typeof destination === 'string' && /^aitools(:[a-z]{2,12})?$/.test(destination)) return typeof aiToolsOpen === 'function' ? aiToolsOpen(destination) : (openBuddy('aitools'), true);
  if (typeof destination !== 'string' || !['overview', 'join', 'settings'].includes(destination)) return false;
  openBuddy(destination);
  return true;
});


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
  syncQuietBadge(st);
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
      if (String(n.sessionId || '').startsWith('remote:') || isRemote(s) || isRemote({ sessionId: n.sessionId })) return;
      if (n.hostApp || n.kind === 'runaway') {
        jumpToSession(s, Rules.folderOf(n.cwd), n.hostApp).catch((err) => console.warn('[jump] failed:', err.message));
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
  const wants = (gun || fx) && win && win.isVisible() && !widgetMotion.paused && !prefersReducedMotion();
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
    webPreferences: { spellcheck: false, preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, backgroundThrottling: false },
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
    webPreferences: { spellcheck: false, preload: path.join(__dirname, 'tray-preload.js'), contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  trayRenderWin.webContents.setFrameRate(4);
  trayRenderWin.loadFile('tray.html');
  trayRenderWin.webContents.once('did-finish-load', () => paintTray(true).catch(() => {}));
  trayRenderWin.on('closed', () => { trayRenderWin = null; });
}

// capturePage() is expensive (an offscreen paint plus a PNG encode), so the
// menu-bar icon is only re-rendered when the look actually changes or an
// animated channel needs a new frame — not twice a second forever.
let trayLookKey = null;
let trayPainting = false;
async function paintTray(force = false) {
  if (trayPainting) return;
  if (!tray || !trayRenderWin || trayRenderWin.isDestroyed() || trayRenderWin.webContents.isLoading()) return;
  const { look } = aggregateState();
  const key = JSON.stringify([look.lamp, look.lampColor, look.lampFx, look.eyes, look.pose, look.costume, look.cameo, look.cameoPhoto?.rev, look.body, look.number]);
  const animated = trayLookAnimated(look);
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

// The 500 ms repaint clock only runs while the lamp or pose animates; every
// other change reaches paintTray through broadcastStatus.
function syncTrayTimer(look) {
  const action = trayTimerAction({ menuBarMode: !!trayRenderWin, look, running: !!trayTimer });
  if (action === 'start') trayTimer = every(500, () => paintTray().catch(() => {}), 'tray');
  else if (action === 'stop') trayTimer = stopTimer(trayTimer);
}

function updateTrayMode() {
  const on = loadConfig().menuBarMode;
  if (on) {
    ensureTrayRenderer();
    trayLookKey = null;
    paintTray(true).catch(() => {});
    syncTrayTimer(aggregateState().look);
  } else {
    trayTimer = stopTimer(trayTimer);
    trayLookKey = null;
    if (trayRenderWin) { trayRenderWin.close(); trayRenderWin = null; }
    tray?.setImage(path.join(__dirname, 'assets', TRAY_ICON));
  }
}

function applyWidgetVisibility() {
  if (!win) return;
  // Linux with no tray: the widget is the only way back in, so it stays.
  if (loadConfig().showWidget || (IS_LINUX && !tray)) win.showInactive(); else win.hide();
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
  if (WidgetStrip.blocksTravel(strip)) return; // the garden walks the widget's own rect, not one grown by the bubble or recap
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
  const wants = real.look.effect === 'garden' && win && win.isVisible() && !widgetMotion.paused && real.reason !== 'preview';
  if (wants && !gardenRun && !roamState.busy) {
    runGarden(real.look).catch((e) => console.log('[garden]', e.message));
  } else if (!wants && gardenRun && !gardenRun.stop) {
    console.log('[garden] stopping: reason', real.reason, 'effect', real.look.effect);
    gardenRun.stop = true;
  }
}

let widgetAsksSent = null;
const statusGate = createStatusGate();
// For the hook-write watcher and the poll: skips the fan-out when nothing the
// broadcast would show has changed (still forced through every few seconds).
function broadcastStatusIfChanged() {
  try { if (!statusGate.changed(aggregateState())) return; } catch { /* fall through to a full broadcast */ }
  broadcastStatus();
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
    const crashed = win;
    try { crashed.destroy(); } catch { /* retain a live owner if disposal failed */ }
    if (!crashed.isDestroyed()) return;
    if (win === crashed) win = null;
    createWindow();
  }
  try { keepAwakeMain?.sync(aggregateState().sessions); } catch { /* the blocker is best-effort */ }
  lightsWin?.webContents.send('status-changed');
  for (const id of ['usage', 'stats', 'help', 'aitools']) buddyWin?.sendToPage(id, 'status-changed');
  try {
    const st = aggregateState();
    statusGate.mark(st);
    if (trayRenderWin) { paintTray().catch(() => {}); syncTrayTimer(st.look); }
    // A paused widget catches up when the gate lifts (it broadcasts then),
    // except for its waiting inputs, which it always hears about.
    const asks = askKey(st);
    if (statusPushWanted(widgetMotion.paused, asks, widgetAsksSent)) { widgetAsksSent = asks; win?.webContents.send('status-changed'); }
    if (!DEMO && devMockReady && localSessions(st.sessions).length) getBuddy().sessionsChanged(localSessions(st.sessions));
    else buddyWin?.sessionsChanged(localSessions(st.sessions));
    const recap = BusyWatch.observe(st.sessions);
    if (recap) { stateMemo = { at: 0, key: null, value: null }; showAwayRecap(recap); }
    maybeNotify(st);
    updateOverlay(st.look);
    const tk = JSON.stringify(WorkScopeView.trayItem(localSessions(st.sessions || []), { available: typeof WorkScope?.setSessionScope === 'function' }));
    if (tk !== trayScopeKey) { trayScopeKey = tk; refreshTrayMenu(); }
    stripAway = !!st.away && !travelLook;
    stripBudget = budgetNotices.list().length > 0;
    applyStrip(travelLook ? 0 : bubblePx, stripAway, updateRowShown && !travelLook, stripBudget && !travelLook);
    updateGarden(st);
    maybeRoam(st);
    maybeRandomEvent(st);
  } catch (e) { console.log('[status]', e.message); }
}

// ── Roaming: walk to the terminal's Dock icon and knock ────────────────────
// When something needs you and the terminal isn't the front app, Claude runs
// along the screen to that app's Dock icon, knocks, and runs home. Once per
// waiting episode, then every 10 minutes while still ignored.
let roamState = { lastKnock: 0, probing: false, waitingSince: null, busy: false, home: null };
// A probe that keeps failing the same way (no Dock icon for the terminal)
// backs off to 10 min; the terminal being in front must still be seen at once.
const roamProbe = createProbeBackoff({
  base: 20000,
  max: 10 * 60 * 1000,
  // A terminal that isn't running yet is worth checking for again soon.
  caps: { 'no terminal app running': 60 * 1000 },
  steady: (why) => why === 'already the front app',
});

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
    const moved = createPointDedupe();
    // A tween that outlives its window (quit, crash, reload) must not keep a
    // 60 Hz interval alive forever, and a throwing step must still clear it.
    const id = every(windowAnimStepMs(), () => {
      if (!win || win.isDestroyed()) { stopTimer(id); resolve(); return; }
      const p = Math.min(1, (Date.now() - t0) / ms);
      try {
        const pt = pointAt(p);
        const x = Math.round(pt.x);
        const y = Math.round(pt.y);
        if (p >= 1 || moved(x, y)) onStep({ x, y });
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
async function performKnock(appName, target, base, mayPing) {
  const knockSound = loadConfig().sounds && mayPing ? (base.sound || 'Tink') : null;
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
  // Roaming moves the grown window as if it were the widget: wait for the bubble to go.
  if (WidgetStrip.blocksTravel(strip)) return { ok: false, why: 'something is showing under the widget' };
  if (gardenRun) return { ok: false, why: 'gardening' };
  // busy goes up BEFORE the first await. Deciding whether to knock costs three
  // osascript calls, and claiming the flag only afterwards is what let every
  // status tick start another round while the previous one was still waiting —
  // thousands of hung osascript processes, and an exhausted process table.
  roamState.busy = true;
  const giveUp = (why, situation) => { roamState.busy = false; return { ok: false, why, situation }; };
  let appName = null;
  let icon = null;
  try {
    appName = await terminalForSessions(localSessions(st.sessions));
    if (!appName) return giveUp('no terminal app running', { app: null, running: false });
    if (!force && (await frontmostApp()) === appName) return giveUp('already the front app', { app: appName, running: true, frontmost: true });
    icon = await dockIconRect(appName);
    if (!icon) return giveUp(`no Dock icon for ${appName}`, { app: appName, running: true, frontmost: false, dockIcon: false });
  } catch (e) {
    return giveUp(`could not locate the Dock icon: ${e.message}`, { app: appName, running: !!appName });
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
    // A knock you asked for (tray, demo) always sounds; a roaming one is a ping.
    await performKnock(appName, target, base, force || pingAllowed(st.owned?.sound, { lamp: base.lamp }));
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

// Each skip reason is logged once per run: a session waiting for an hour on an
// app with no Dock icon otherwise wrote the same line every probe.
const roamSkipsLogged = new Set();
function maybeRoam(st) {
  const config = loadConfig();
  if (!IS_MAC || !config.roam || reducedMotion || !win || !win.isVisible() || widgetMotion.paused || roamState.busy || previewLook || gardenRun || WidgetStrip.blocksTravel(strip)) return;
  const waiting = st.pending?.length || localSessions(st.sessions).some((s) => WAITING_SIGNALS.has(s.signal));
  if (!waiting) { roamState.waitingSince = null; roamProbe.reset(); return; }
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
  // Who is waiting, and in which terminal: a change there is a new situation.
  roamProbe.setKey([...(st.pending || []).map((p) => p.id), ...st.sessions.filter((s) => WAITING_SIGNALS.has(s.signal)).map((s) => `${s.sessionId}:${s.signal}:${s.hostApp || ''}`)].sort().join('|'));
  if (!roamProbe.due(Date.now())) return;
  roamState.probing = true;
  let result = null;
  roamAndKnock(st)
    .then((r) => { result = r; })
    .catch((e) => { result = { ok: false, why: e.message }; console.log('[roam]', e.message); })
    .finally(() => {
      roamState.probing = false;
      roamProbe.probed(result, Date.now());
      if (result && !result.ok && !roamSkipsLogged.has(result.why)) {
        roamSkipsLogged.add(result.why);
        console.log(`[roam] skipped: ${result.why}${roamProbe.gap > 20000 ? ` (next look in ${Math.round(roamProbe.gap / 1000)} s)` : ''}`);
      }
    });
}

// ── Rare events ────────────────────────────────────────────────────────────
// A UFO, a portal or a meteor: about once per 45 minutes of working time at
// random, plus on milestones (10th, 50th, 100th, 500th session seen).
const seenSessions = new Set();
let lastEventAt = 0;
function maybeRandomEvent(st) {
  const config = loadConfig();
  if (!config.randomEvents || !win || !win.isVisible() || widgetMotion.paused || previewLook || travelLook) return;
  let milestone = false;
  for (const s of st.sessions) {
    if (!seenSessions.has(s.sessionId)) {
      if (seenSessions.size >= 5000) seenSessions.delete(seenSessions.values().next().value);
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

const LoginItem = require('./src/login-item.js').create({ app, name: require('./brand.js').name });
// Rebuilds the tray menu in place (the session-scope item follows the most
// recently active session); createTray sets it.
let refreshTrayMenu = () => {};
let trayScopeKey = null;
function createTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  const trayIconPath = path.join(__dirname, 'assets', TRAY_ICON);
  try {
    tray = new Tray(trayIconPath);
  } catch {
    // Linux without a tray still needs a way to Quit: the same menu opens
    // from a right-click on the widget (widget-menu below), which stays up.
    if (process.platform !== 'linux') return;
    tray = null;
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

  const scopeItem = () => {
    const item = WorkScopeView.trayItem(localSessions(aggregateState().sessions || []), { available: typeof WorkScope?.setSessionScope === 'function' });
    if (!item) return [];
    return [{
      label: item.label, type: 'checkbox', checked: item.checked, enabled: item.enabled,
      click: () => { if (!item.sessionId) return; WorkScope.setSessionScope(item.sessionId, item.checked ? 'auto' : 'personal'); scopeChanged(); },
    }, { type: 'separator' }];
  };
  const budgetItems = () => {
    const shown = budgetNotices.list().slice(0, BUDGET_TRAY_ITEMS).map((n) => ({ label: `${BudgetNotice.text(n).replace(/ \(\$.*$/, '')}…`, click: () => { openBudgetNotice(n.runId).then((r) => { if (!r || !r.ok) openBuddy(BudgetNotice.CONTRACT.boardPage); }); } }));
    return shown.length ? [...shown, { type: 'separator' }] : [];
  };
  const quietItems = () => {
    const config = loadConfig();
    const now = Date.now();
    const left = Quiet.snoozeLabel(config.snoozeUntil, now);
    const setSnooze = (until) => { saveConfig({ snoozeUntil: until }); stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); refreshTrayMenu?.(); };
    const mine = localSessions(aggregateState().sessions || []).find((x) => x.cwd);
    const folder = mine ? Rules.folderOf(mine.cwd) : null;
    const muted = !!mine && Quiet.projectMuted(config.mutedProjects, mine.cwd);
    return [
      { label: left || 'Snooze Notifications', submenu: [
        ...Object.entries(Quiet.SNOOZES).map(([k, text]) => ({ label: text.charAt(0).toUpperCase() + text.slice(1), click: () => setSnooze(Quiet.snoozeEnd(k, Date.now())) })),
        { label: 'Resume Notifications', enabled: !!left, click: () => setSnooze(0) },
      ] },
      ...(folder ? [{ label: `Mute Notifications for ${folder}`, type: 'checkbox', checked: muted, click: () => {
        const list = (config.mutedProjects || []).filter((x) => x !== mine.cwd && x !== folder);
        saveConfig({ mutedProjects: muted ? list : [...list, mine.cwd] }); broadcastStatus(); refreshTrayMenu?.();
      } }] : []),
      ...SessionHandoverMain.menuItems(mine),
    ];
  };
  const buildMenu = (from = 'tray') => Menu.buildFromTemplate([
    ...budgetItems(),
    ...scopeItem(),
    ...BurstIpc.trayItems(),
    ...AppMenu.appItems({ pages: BuddyPages.PAGES, groups: BuddyPages.GROUPS, open: openBuddy, openLabel: BRAND.OPEN_MENU_LABEL, feedback: { label: "Something's off / Idea…", click: createFeedbackWindow } }),
    { label: 'Open Claude', click: () => shell.openExternal('https://claude.ai') },
    ...quietItems(),
    { label: 'Show Widget Now', click: () => { saveConfig({ showWidget: true }); clearTimeout(snoozeTimer); if (!win) createWindow(); win.showInactive(); createTray(); } },
    { label: 'Reset Widget Position', click: () => { const wa = screen.getPrimaryDisplay().workArea; if (!win) createWindow(); strip = WidgetStrip.NONE; win.setMaximumSize(MAX_WIDTH, Math.round(MAX_WIDTH / WIDGET_ASPECT)); win.setAspectRatio(WIDGET_ASPECT); win.setBounds({ x: wa.x + wa.width - 140, y: wa.y + 46, width: 107, height: 137 }); win.showInactive(); broadcastStatus(); } },
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
    { label: 'Health…', click: showHealth },
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
      checked: LoginItem.get(),
      click: (item) => LoginItem.set(item.checked),
    },
    { type: 'separator' },
    ...updaterTrayItems(),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  // Rebuilt in place (never by recreating the tray) when the update items change;
  // trayMenu is also what the widget pops up on Linux, where there may be no tray.
  const mine = tray;
  buildWidgetMenu = buildMenu;
  trayMenu = buildMenu();
  rebuildTrayMenu = () => {
    trayMenu = buildMenu();
    if (mine && tray === mine) tray.setContextMenu(trayMenu);
    // Specs read and click the real menu; there is no getter on a Tray.
    if (IS_DEV_RUN && !app.isPackaged) global.__buddyTrayMenu = trayMenu;
  };
  // The session-scope item follows the most recently active session.
  refreshTrayMenu = rebuildTrayMenu;
  if (IS_DEV_RUN && !app.isPackaged) global.__buddyTrayMenu = trayMenu;
  if (!tray) { if (!win) createWindow(); win.showInactive(); return; }
  tray.setToolTip(Brand.shortName);
  tray.setContextMenu(trayMenu);
  updateTrayMode();
}

// Right-click on the widget opens the Plexiform window: one app, on the page
// last used (focused if already open). Shift/Option-right-click: the tray's
// menu, built fresh from the same template, and on Linux the only way to Quit
// where GNOME shows no tray. Before a tray exists: the Lights editor.
let trayMenu = null;
let buildWidgetMenu = null;
ipcMain.handle('widget-menu', (e, opts) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  if (!(opts && opts.menu === true)) { openBuddy(); return; }
  if (!buildWidgetMenu) { createLightsWindow(); return; }
  const menu = buildWidgetMenu('widget');
  if (IS_DEV_RUN && !app.isPackaged && process.env.CLAUDE_TRAFFIC_LIGHT_MENU_SPY === '1') { global.__buddyWidgetMenu = menu; return; } // specs read it: a native popup would block them
  menu.popup({ window: win });
});

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
  if (!win || win.isDestroyed() || gardenRun || roamState.busy || WidgetStrip.blocksTravel(strip)) return false;
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
  const glideMoved = createPointDedupe();
  glideTimer = every(windowAnimStepMs(), () => {
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
    const gx = Math.round(done ? target.x : ax.s.x);
    const gy = Math.round(done ? target.y : ay.s.x);
    try { if (done || glideMoved(gx, gy)) win.setPosition(gx, gy); } catch { stopGlide(); return; }
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
  retuneEyePoll();
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

ipcMain.handle('get-low-power', () => lowPowerOn);
ipcMain.on('net-changed', () => checkOnline());
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
const ClickThrough = require('./src/click-through.js').create({ screen, getWin: () => win, every, stopTimer });
ipcMain.on('set-click-through', (e, ignore) => {
  try { ClickThrough.set(ignore); } catch { /* window gone */ }
});

ipcMain.on('resize-window-by', (e, factor) => {
  resizeBy(factor);
});

utilityHandle('get-aggregate-status', e => widgetOnly(e) || widgetConfigSender(e), () => {
  const state = aggregateState();
  const facing = widgetMuzzle()?.facing || 'right';
  return { ...state, providerStatus: ProviderStatus.snapshot({ sessions: localSessions(state.sessions || []), online }), look: { ...state.look, facing } };
});

// Click handler: jump to whichever session needs the user — the ones whose
// live signal is a waiting one. Cycles through them, oldest first; a limit
// hit jumps the queue.
ipcMain.handle('go-to-needing-session', async () => {
  const sessions = localSessions(aggregateState().sessions);
  const needing = sessions
    .filter((s) => WAITING_SIGNALS.has(s.signal))
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  if (needing.length === 0) {
    cycleIndex = 0;
    // Nothing here to jump to, but say where the waiting is.
    const away = aggregateState().sessions.find((s) => s.remote && WAITING_SIGNALS.has(s.signal));
    return away ? { opened: 'remote', total: 0, feedback: `waiting on ${away.deviceName}` } : { opened: 'none', total: 0 };
  }

  const limits = needing.filter((s) => s.signal === 'limit-hit');
  const queue = limits.length > 0 ? limits : needing;

  cycleIndex = cycleIndex % queue.length;
  const target = queue[cycleIndex];
  const shownIndex = cycleIndex + 1;
  cycleIndex += 1;

  clipboard.writeText(target.cwd);
  const folderHint = Rules.folderOf(target.cwd);
  const activated = await jumpToSession(target, folderHint);
  return {
    opened: activated?.app || 'none-found',
    exact: activated?.exact || false,
    ...(activated?.cant ? { note: activated.cant, feedback: activated.cant, command: activated.command || null } : {}),
    cwd: target.cwd,
    signal: target.signal,
    index: shownIndex,
    total: queue.length,
  };
});

utilityHandle('get-config', configReader, () => loadConfig());

utilityHandle('save-config', e => settingsOnly(e) || widgetConfigSender(e), (e, partial) => {
  try { return commitConfig(partial); } catch (err) {
    console.warn('[save-config]', err.message);
    return { error: `Could not save: ${err.message}` };
  }
});
// saveConfig plus everything a changed setting has to reach outside config.json.
function applyConfigEffects(prev, next, touched) {
  applyConfigSideEffects(prev, next, {
    installHooks,
    enableCalendar: () => BusyWatch.enableCalendar().catch((err) => console.warn('[busy]', err.message)),
    applyWidgetVisibility, syncTailnetListener, createTray, applyVoiceHotkey, applyLowPower, syncFastHook, broadcastStatus, syncInteractionHost,
  }, touched);
}
function commitConfig(partial) {
  const prev = loadConfig();
  // The Lights window says when a save replaces the rules wholesale
  // (template, preset, reset); a big content change counts too.
  const marker = partial.__backupReason;
  delete partial.__backupReason;
  if (Backups.needsBackup({
    prevRules: prev.rules, nextRules: Array.isArray(partial.rules) ? partial.rules.map(Rules.normalizeRule) : undefined,
    prevPresets: prev.presets, nextPresets: partial.presets, marker: typeof marker === 'string' ? marker : null,
  })) backupFirst();
  const next = saveConfig(partial);
  applyConfigEffects(prev, next, (k) => k in partial);
  if ('compaction' in partial) InteractionMain.hub.compactionSettingsChanged().catch(() => {});
  // Opting out disconnects at once; attached daemon sessions end in Plexiform (they keep running in Codex).
  if (next.codexDaemonMessaging !== true) CodexDaemon.stop();
  return next;
}

utilityHandle('get-privacy', settingsOnly, () => { try { return fs.readFileSync(path.join(__dirname, 'PRIVACY.md'), 'utf8'); } catch { return null; } });
utilityHandle('show-data-folder', settingsOnly, () => { fs.mkdirSync(ROOT_DIR, { recursive: true }); return shell.openPath(ROOT_DIR); });
utilityHandle('get-stats', e => analyticsSender(e) || settingsOnly(e), (_e, days) => Stats.summary(stats, Date.now(), Math.min(60, Math.max(1, Number(days) || 7))));

// Export the whole visible range as JSON or CSV, wherever the user points.
utilityHandle('export-stats', e => settingsOnly(e) || analyticsSender(e), async (e, format, days) => {
  const n = Math.min(60, Math.max(1, Number(days) || 7));
  const sum = Stats.summary(stats, Date.now(), n);
  const csv = format === 'csv';
  const name = `plexiform-stats-${Stats.dayKey(Date.now())}-${n}d.${csv ? 'csv' : 'json'}`;
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) || undefined, {
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
      env: require('./src/tool-path.js').toolEnv(),
      // Windows: npm installs ccusage as a .cmd, which only runs through a shell (the args are fixed words).
      shell: IS_WIN,
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
    // per-day cost comes from the permanent record (applyHistoryToStats), not from here
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
      // A JSON string match, decoded: a Windows cwd arrives as "C:\\Users\\…".
      const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, n));
      cwdById[id] = m ? JSON.parse(m[1]) || null : null;
      return cwdById[id];
    } catch { return null; }
  };
  const projects = {};
  const sessions = [];
  for (const sname of session?.session || []) {
    const id = sname.period;
    const cwd = cwdFromTranscript(id) || (sname.metadata && (sname.metadata.projectPath || sname.metadata.cwd)) || null;
    const project = cwd ? Rules.folderOf(cwd) : (sname.metadata?.project || 'other');
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
utilityHandle('get-costs', e => analyticsSender(e) || settingsOnly(e), () => getCosts());

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
utilityHandle('model-mix', e => fromUtilityPage(e, 'usage'), async () => Usage.modelMix(await getUsageTurns()));

// The Usage tab and buddy_usage_history read the permanent record from disk.
// Asking also nudges a fresh fold in, so an open tab stays current.
// One call gives the tab everything it draws (usage-history.js bundle), read
// from the cached store; `now` is only honoured in the visual tests.
utilityHandle('usage-bundle', e => fromUtilityPage(e, 'usage'), (_e, q = {}) => {
  if (Date.now() - historyAt > HISTORY_LIVE_MS && spendTurns.turns) historyTick();
  const range = ['7d', '30d', '90d', '1y', 'all'].includes(q.range) ? q.range : '30d';
  const now = DEMO === 'visual' && Number.isFinite(Number(q.now)) ? Number(q.now) : Date.now();
  const project = typeof q.project === 'string' && q.project.length < 1024 ? q.project : null;
  const out = UsageHistory.bundle(openHistory(), { range, now, project, compare: q.compare !== false });
  return { ...out, progress: historyState.progress, mode: Spend.normalize(loadConfig().spend).mode };
});

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
      spendWorker = new Worker(path.join(__dirname, 'src', 'usage-worker.js')); // privacy-flow: local-worker
      spendWorker.unref();
      spendWorker.on('message', (m) => {
        if (m && typeof m.type === 'string' && m.type.startsWith('history.')) { onHistoryMessage(m); return; }
        const p = spendPending.get(m.id); spendPending.delete(m.id); if (p) (m.error ? p.reject(new Error(m.error)) : p.resolve(m));
      });
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
// ── Usage history: the permanent daily record (usage-history.js) ──────────
// Folded in by the spend worker on the same transcript pass (history.tick),
// so there is one parse, not two. Everything reads it back from disk.
const HISTORY_EVERY_MS = 60 * 60 * 1000;
const HISTORY_LIVE_MS = 5000;
let historyAt = 0;
let historyState = { first: false, progress: null, lastDone: null };
// One store, opened once: the month files are parsed the first time they are
// asked for and kept until the worker records something new.
let historyStore = null;
const openHistory = () => historyStore || (historyStore = UsageHistory.open({ root: ROOT_DIR }));
function historyTick() {
  historyAt = Date.now();
  if (spendWorker) { spendWorker.postMessage({ type: 'history.tick', root: PROJECTS_DIR, dataDir: ROOT_DIR, statsFile: STATS_FILE }); return; }
  // no worker: fold what the main thread already read
  if (!spendTurns.turns) return;
  try {
    const store = UsageHistory.open({ root: ROOT_DIR });
    UsageHistory.record(store, spendTurns.turns);
    UsageHistory.flush(store);
    historyStore = null;
    applyHistoryToStats();
  } catch (err) { console.warn('[history] inline tick failed:', err.message); }
}
function onHistoryMessage(m) {
  if (m.type === 'history.progress') { historyState.progress = { done: m.done, of: m.of }; return; }
  if (m.type === 'history.error') { console.warn('[history] tick failed:', m.error); return; }
  historyState = { ...historyState, progress: null, lastDone: Date.now() };
  historyStore = null;
  paceBase = { key: null, value: null };
  if (m.first || m.added) console.log(`[history] ${m.first ? 'backfill' : 'recorded'}: ${m.added} turns${m.imported ? `, ${m.imported} legacy days` : ''}`);
  applyHistoryToStats();
}
// The Stats page's per-day cost is the record's, so the two can't disagree.
function applyHistoryToStats() {
  try {
    const q = UsageHistory.query(openHistory(), { from: Date.now() - 60 * 86400000, to: Date.now(), groupBy: 'day' });
    for (const r of q.rows) if (r.turns || r.legacyCost) Stats.recordCost(stats, r.key, r.cost);
    statsDirty = true;
  } catch (err) { console.warn('[history] stats sync failed:', err.message); }
}
let spendInFlight = null;
let spendReadAt = 0;
const SPEND_POLL_MS = 15000;
const SPEND_LIVE_MS = 3000;
function anyWindowVisible() {
  const lightsShown = !!lightsWin && !lightsWin.isDestroyed() && lightsWin.isVisible() && !lightsMotion.paused;
  return !widgetMotion.paused || !!buddyWin?.isVisible() || lightsShown;
}
function refreshSpend(minGap = SPEND_POLL_MS - 1000) {
  if (spendInFlight || Date.now() - spendReadAt < spendMinGap({ minGap, anyVisible: anyWindowVisible() })) return;
  const t0 = Date.now();
  spendInFlight = spendRead(Spend.readSince(loadConfig().spend))
    .then((r) => {
      spendReadAt = Date.now();
      if (!spendTurns.turns || Date.now() - t0 > 1000) console.log(`[spend] read ${r.parsed} files in ${Date.now() - t0} ms${spendWorker ? ' (worker)' : ''}`);
      if (r.unchanged && spendTurns.turns) return;
      spendTurns = { version: spendTurns.version + 1, turns: r.turns };
      if (Date.now() - historyAt > HISTORY_EVERY_MS) historyTick();
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
function spendSnapshot(config) {
  if (SPEND_FIXTURE && fs.existsSync(SPEND_FIXTURE)) return JSON.parse(fs.readFileSync(SPEND_FIXTURE, 'utf8'));
  if (!spendTurns.turns) return null;
  const snap = spendTracker.snapshot(spendTurns.turns, spendTurns.version, config.spend);
  return { ...snap, pace: paceFor(spendTurns.turns, spendTurns.version) };
}
// Today against your own usual (usage-history.js pace): recomputed per turns
// version and minute. Needs a week of recorded history before it says anything.
let paceMemo = { key: null, value: null };
// The baseline is what you had spent by this time on earlier days: it only
// changes when the hour turns or the record does, not with every turn.
let paceBase = { key: null, value: null };
function paceFor(turns, version) {
  const now = Date.now();
  const key = `${version}|${Math.floor(now / 60000)}|${historyState.lastDone || 0}`;
  if (paceMemo.key === key) return paceMemo.value;
  let value = null;
  try {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    let today = 0;
    for (const t of turns) if (t.ts >= from.getTime() && t.ts <= now) today += Usage.costOf(t) || 0;
    const bkey = `${from.getTime()}|${new Date(now).getHours()}|${Math.floor(new Date(now).getMinutes() / 10)}|${historyState.lastDone || 0}`;
    if (paceBase.key !== bkey) paceBase = { key: bkey, value: UsageHistory.paceBaseline(openHistory(), { now }) };
    const p = UsageHistory.paceOf(paceBase.value, today);
    const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
    value = { ...p, firing: UsageHistory.paceFiring(p), noteworthy: UsageHistory.paceNoteworthy(p), text: p.ready ? `Today ${money(p.today)} · ${p.aboveBy >= 0 ? `${p.aboveBy}% above` : `${-p.aboveBy}% below`} your usual for now (${money(p.avg)})` : '' };
  } catch (err) { console.warn('[history] pace failed:', err.message); }
  paceMemo = { key, value };
  return value;
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
      if (v) return { rule: rule.name, text: `${v.burn}${v.cwd ? ` in ${Rules.folderOf(v.cwd)}` : ''}` };
    }
    if ((sig.includes('budget-exceeded') || sig.includes('budget-warning')) && spend.budgetText) return { rule: rule.name, text: spend.budgetText };
    if (sig.includes('above-usual-pace') && spend.pace && spend.pace.text) return { rule: rule.name, text: spend.pace.text };
  }
  return null;
}
// Hook point for the board runner (later): a runner that spawned a session
// registers `sessionId → stop()` here, and that session's runaway
// notification gets a Stop button that calls it (killing the supervised
// process). Interactive sessions never register, so they only ever get the
// notification and the jump to their terminal.
const runawayStoppers = new Map();
utilityHandle('get-spend', settingsOnly, () => {
  const snap = spendSnapshot(loadConfig());
  return snap ? { ...snap, latch: undefined } : null;
});

// ── Gestures on the avatar → the action the current state programmed ──────
let snoozeTimer = null;
let cycleIndex = 0;
const LinuxActions = require('./src/linux-actions.js');
async function runAction(action, st) {
  const local = localSessions(st.sessions);
  const needing = local.filter((s) => WAITING_SIGNALS.has(s.signal)).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  const target = needing[0] || local[0] || null;
  const cwd = target?.cwd || null;
  const folderHint = cwd ? Rules.folderOf(cwd) : '';
  switch (action.type) {
    case 'jump': {
      if (!needing.length) {
        const away = st.sessions.find((s) => s.remote && WAITING_SIGNALS.has(s.signal));
        return away ? { feedback: `waiting on ${away.deviceName}` } : { react: { eyes: 'surprised', pose: 'bounce' }, feedback: 'boop' };
      }
      const r = await jumpToNeeding();
      return { feedback: r };
    }
    case 'terminal': {
      const a = await jumpToSession(target, folderHint);
      return { feedback: a?.cant ? a.cant : a ? `→ ${a.app}` : 'no terminal running' };
    }
    case 'allow': case 'deny': {
      // Tool permissions only: a plan, question or elicitation is answered
      // from its own options, never by a gesture. A gesture can't see what it
      // approves, so it allows only what Enter could: exactly one waiting
      // permission, allow-listed and unflagged. Anything else: go and look.
      const pick = action.type === 'allow' ? EnterAllow.gestureAllowTarget(st.pending, st.inputs) : { req: st.pending && st.pending[0] };
      if (pick.why) { if (win && !win.isVisible()) win.showInactive(); return { feedback: pick.why }; }
      const req = pick.req;
      if (!req) return { feedback: 'nothing to answer' };
      if (req.kind && req.kind !== 'permission') return { feedback: 'open it to answer' };
      const ok = answerRequest(req.id, action.type);
      setTimeout(broadcastStatus, 250);
      if (!ok) return { feedback: 'answer it in the terminal' };
      return { feedback: action.type === 'allow' ? 'allowed' : 'denied' };
    }
    case 'poke': return { react: { eyes: 'surprised', pose: 'bounce' }, feedback: 'boop' };
    case 'pet': return { react: { eyes: 'heart', pose: 'nod' }, ms: 2000, feedback: 'purr' };
    case 'feed': return { react: { pose: 'munch', eyes: 'happy' }, ms: 1800, feedback: 'nom' };
    case 'lights': createLightsWindow(); return { feedback: 'Lights' };
    case 'stats': openBuddy('stats'); return { feedback: 'Stats' };
    case 'finder': if (!cwd) return { feedback: 'no session folder' }; shell.openPath(cwd); return { feedback: `${IS_WIN ? 'Explorer' : 'Finder'} → ${folderHint}` };
    case 'editor': {
      if (!cwd) return { feedback: 'no session folder' };
      if (IS_WIN) execFile('cmd', ['/c', 'start', '', action.arg || 'code', cwd], () => {});
      else if (IS_MAC) execFile('open', ['-a', action.arg || 'Visual Studio Code', cwd], () => {});
      // Linux: the editor's command; if there is none, the folder in the file manager.
      else execFile(LinuxActions.editorCommand(action.arg), [cwd], (err) => { if (err && err.code === 'ENOENT') shell.openPath(cwd); }); // privacy-flow: rule-command
      return { feedback: `${action.arg || 'Visual Studio Code'} → ${folderHint}` };
    }
    case 'copy-path': if (!cwd) return { feedback: 'no session folder' }; clipboard.writeText(cwd); return { feedback: 'path copied' };
    case 'url': if (!/^https?:\/\//i.test(action.arg || '')) return { feedback: 'no URL set' }; shell.openExternal(action.arg); return { feedback: 'opened' }; // privacy-flow: rule-url
    case 'shell': {
      if (!action.arg) return { feedback: 'no command set' };
      // The user's own command, run in their shell; the session folder is CLAUDE_CWD.
      if (IS_WIN) execFile('powershell', ['-NoProfile', '-c', action.arg], { env: { ...process.env, CLAUDE_CWD: cwd || '' } }, () => {}); // privacy-flow: rule-command
      else execFile(IS_MAC ? '/bin/zsh' : LinuxActions.userShell(), ['-lc', action.arg], { env: { ...process.env, CLAUDE_CWD: cwd || '' } }, () => {}); // privacy-flow: rule-command
      return { feedback: 'ran' };
    }
    case 'shortcut': if (!IS_MAC) return { feedback: 'Shortcuts are macOS only' }; if (!action.arg) return { feedback: 'no shortcut set' }; execFile('shortcuts', ['run', action.arg], () => {}); return { feedback: `Shortcut: ${action.arg}` };
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
  const sessions = localSessions(aggregateState().sessions);
  const needing = sessions.filter((s) => WAITING_SIGNALS.has(s.signal)).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  if (!needing.length) {
    const away = aggregateState().sessions.find((s) => s.remote && WAITING_SIGNALS.has(s.signal));
    return away ? `waiting on ${away.deviceName}` : 'nothing waiting';
  }
  const limits = needing.filter((s) => s.signal === 'limit-hit');
  const queue = limits.length > 0 ? limits : needing;
  cycleIndex = cycleIndex % queue.length;
  const target = queue[cycleIndex];
  const shownIndex = cycleIndex + 1;
  cycleIndex += 1;
  clipboard.writeText(target.cwd);
  const folderHint = Rules.folderOf(target.cwd);
  const activated = await jumpToSession(target, folderHint);
  const badge = queue.length > 1 ? ` (${shownIndex}/${queue.length})` : '';
  if (activated?.cant) return `${folderHint}${badge}: ${activated.cant}`;
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
  onQuit(app, () => { globalShortcut.unregisterAll(); listener.cancel(); });
}

// A long-press where voice can't work (not a Mac, helper not bundled) stays
// an ordinary click: no tooltip, nothing swallowed.
ipcMain.handle('voice-start', () => {
  if (!listener.available() || !Voice.normalizeConfig(loadConfig().voice).longPress) return { ok: false, reason: 'off' };
  return startListening(null);
});
ipcMain.handle('voice-enabled', () => listener.available() && Voice.normalizeConfig(loadConfig().voice).longPress);
ipcMain.handle('voice-stop', () => listener.stop());
utilityHandle('voice-status', settingsOnly, () => ({
  available: listener.available(),
  reason: listener.available() ? null : listener.unavailableReason(),
  hotkeys: Voice.HOTKEYS.map(({ accelerator, label }) => ({ accelerator, label })),
  hotkeyTaken: voiceHotkeyTaken,
}));


// A click on a PendingInput option: the renderer sends the input id and the
// option id (plus free-text answers, form content or a deny message); the
// answer itself is rebuilt from the request file, never taken from the
// renderer. First answer wins (answer-file.js); every answer is logged.
// Who may read and answer waiting inputs: the widget and the Waiting page
// (its own window, or the Plexiform window's view of it), by webContents.
function inputSenderOk(e) {
  const wc = e.sender;
  return !!wc && ((win && wc === win.webContents) || (buddyWin && wc === buddyWin.pageWebContents('waiting')));
}
ipcMain.handle('answer-input', (e, id, optionId, more = {}) => {
  if (!inputSenderOk(e)) return { ok: false, error: 'not allowed' };
  // Answering from the widget is a setting: off means off, even for a request file still on disk.
  if (!loadConfig().askFromWidget) return { ok: false, error: 'off' };
  const req = readRequests().find((r) => r.id === String(id));
  if (!req) return { ok: false, error: 'no longer waiting (answered, timed out, or answer it in the terminal)' };
  const m = more && typeof more === 'object' ? more : {};
  const answer = PendingInputs.answerFor(req, String(optionId), { answers: m.answers, content: m.content, message: m.message });
  if (!answer) return { ok: false, error: 'not an option for this request' };
  // Enter is decided again here, from the request file, never from the renderer's say-so.
  const oneKey = m.oneKey === true;
  if (oneKey) {
    let why = String(optionId) === 'allow' ? OneKey.reason(req, { enabled: loadConfig().oneKeyApprove }) : 'only Allow once';
    try { if (!why && AutoRules.danger(req) !== null) why = 'it needs a careful look'; } catch { why = 'it could not be checked'; }
    if (!why) why = EnterAllow.enterBlockedReason(req);
    if (why) return { ok: false, error: `Enter skips this (${why}): click Allow if you mean it.` };
  }
  // Bound to the request as shown (readRequests drops edited ones): the file
  // must still hash the same when the answer is written.
  const w = AnswerFile.writeAnswer(REQUESTS_DIR, req.id, answer.decision, { by: 'desk', extra: answer.extra, key: keyFor(req.id), decisionHash: req.decisionHash });
  console.log(`[answer] ${req.kind || 'permission'} ${req.tool} ${req.id}: ${optionId} → ${w.ok ? answer.decision : `not sent (${w.error})`}`);
  setTimeout(broadcastStatus, 250);
  if (!w.ok) return { ok: false, error: w.error };
  if (oneKey) {
    OneKey.record(path.join(ROOT_DIR, 'one-key-approvals.jsonl'), { tool: req.tool, session: req.sessionId || null, project: Rules.folderOf(req.cwd), request: req.id, summary: PendingInputs.fromRequest(req).headline || null });
    console.log(`[one-key] approved ${req.tool} ${req.id} in ${Rules.folderOf(req.cwd)}`);
  }
  // "Allow once" only: a session-wide allow was already a broader choice.
  // The answer is already written: a counter problem must not turn it into an error.
  if (!SHOW_RULE_NUDGE) return { ok: true };
  let n = null;
  try { n = String(optionId) === 'allow' ? nudger.record(req, loadConfig().autoAnswer.rules) : null; } catch (err) { console.warn('[nudge]', err.message); }
  if (!n || !n.nudge) return { ok: true };
  nudger.offer(n.key);
  return { ok: true, nudge: { key: n.key, count: n.count, tools: n.nudge.tools, command: n.nudge.command || null, path: n.nudge.path || null } };
});

// The Waiting page (waiting.html, standalone or in the Plexiform window).
ipcMain.handle('get-inputs', (e) => {
  if (!inputSenderOk(e)) return null;
  const st = aggregateState();
  return { inputs: st.reason === 'travel' ? [] : (st.inputs || []), scopes: WorkScopeView.scopesBySession(st.sessions), askFromWidget: !!loadConfig().askFromWidget };
});

// "Not team work" / Undo / "Always treat this repo as personal". Only when
// the core's module is there, and only from the widget, the Waiting page
// (its own window or the Plexiform window's view) or Settings.
const SCOPE_MODES = new Set(['personal', 'auto']);
function scopeSenderOk(e) {
  return inputSenderOk(e) || settingsOnly(e);
}
function scopeChanged() { stateMemo = { at: 0, key: null, value: null }; broadcastStatus(); refreshTrayMenu(); }
if (typeof WorkScope?.setSessionScope === 'function' && typeof WorkScope?.setRepoScope === 'function') {
  ipcMain.handle('set-session-scope', (e, sessionId, mode) => {
    if (!scopeSenderOk(e)) return { ok: false, error: 'not allowed' };
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !SCOPE_MODES.has(mode)) return { ok: false, error: 'bad arguments' };
    WorkScope.setSessionScope(sessionId, mode);
    console.log(`[scope] session ${sessionId} → ${mode}`);
    scopeChanged();
    return { ok: true };
  });
  ipcMain.handle('set-repo-scope', (e, canonicalUrl, mode) => {
    if (!scopeSenderOk(e)) return { ok: false, error: 'not allowed' };
    if (typeof canonicalUrl !== 'string' || !canonicalUrl || canonicalUrl.length > 300 || !SCOPE_MODES.has(mode)) return { ok: false, error: 'bad arguments' };
    WorkScope.setRepoScope(canonicalUrl, mode);
    console.log(`[scope] repo ${canonicalUrl} → ${mode}`);
    scopeChanged();
    return { ok: true };
  });
  if (typeof WorkScope.onChange === 'function') {
    const unsubscribe = WorkScope.onChange(scopeChanged);
    if (typeof unsubscribe === 'function') onQuit(app, unsubscribe);
  }
}
ipcMain.handle('open-waiting', (e) => { if (!inputSenderOk(e)) return false; createWaitingWindow(); return true; });
ipcMain.handle('nudge-mute', (e, key) => (inputSenderOk(e) ? nudger.mute(String(key)) : false));

// Lights → Auto-answer, prefilled. From a nudge the rule is the one main
// remembered for that key; from an input it is rebuilt from the request or
// the session's recorded denial. The renderer only names which.
function autoRulePrefill(from) {
  const f = from && typeof from === 'object' ? from : {};
  if (typeof f.nudgeKey === 'string') return nudger.take(f.nudgeKey);
  if (typeof f.inputId !== 'string') return null;
  const st = aggregateState();
  const input = (st.inputs || []).find((i) => i.id === f.inputId);
  if (!input) return null;
  if (input.source === 'hook') {
    const req = readRequests().find((r) => r.id === input.id);
    const s = req && ApprovalNudge.suggestionFor(req);
    return s ? s.rule : (input.tool ? { action: 'allow', tools: [input.tool] } : null);
  }
  const b = (st.sessions || []).find((x) => x.sessionId === input.session)?.blocked;
  if (input.kind !== 'blocked' || !b || typeof b.tool !== 'string') return input.tool ? { action: 'allow', tools: [input.tool] } : null;
  // The classifier's own reason names the rule. A summary longer than a rule
  // can hold (or one that hit its own cap) may be cut, so it never becomes a
  // command or path: a cut command could allow something else.
  const note = typeof b.reason === 'string' ? b.reason.slice(0, 200) : '';
  const summary = typeof b.summary === 'string' && b.summary.length <= 500 ? b.summary : '';
  if (!summary) return { action: 'allow', tools: [b.tool], note };
  const toolInput = AutoRules.FILE_TOOLS.has(b.tool) ? { file_path: summary } : { command: summary };
  const s = ApprovalNudge.suggestionFor({ kind: 'permission', tool: b.tool, toolInput });
  if (s) return { ...s.rule, note };
  return AutoRules.SHELL_TOOLS.has(b.tool) ? { action: 'allow', tools: [b.tool], command: summary, note } : { action: 'allow', tools: [b.tool], note };
}
ipcMain.handle('open-auto-rule', (e, from) => {
  if (!inputSenderOk(e)) return false;
  const prefill = autoRulePrefill(from);
  showLightsView('auto', prefill ? { event: 'auto-rule-prefill', data: prefill } : null);
  return !!prefill;
});
ipcMain.handle('check-auto-rule', (e, rule) => (widgetConfigSender(e) ? { reason: AutoRules.refusal(rule) } : { reason: 'not allowed' }));

// The attach command a detached session's open returned, by input id. The
// renderer asks for it to be copied; it never supplies the text.
const attachCommands = new Map();
ipcMain.handle('copy-input-command', (e, id) => {
  if (!inputSenderOk(e)) return { ok: false };
  const cmd = attachCommands.get(String(id));
  if (!cmd) return { ok: false };
  try { clipboard.writeText(cmd); return { ok: clipboard.readText() === cmd }; } catch { return { ok: false }; }
});

// "Open it": jump to the pane or tab the input is waiting in. Never types.
ipcMain.handle('open-input', async (e, id) => {
  if (!inputSenderOk(e)) return { ok: false, error: 'not allowed' };
  const item = (aggregateState().inputs || []).find((i) => i.id === String(id));
  if (!item) return { ok: false, error: 'gone' };
  const dialog = item.source === 'tmux' ? paneDialogs.find((d) => `dialog-${d.key}` === item.id) : null;
  const session = dialog ? dialog.jump : (aggregateState().sessions || []).find((s) => s.sessionId === item.session);
  if (!session) return { ok: false, error: 'session not found' };
  const r = await jumpToSession(session, String(session.cwd || '').split('/').filter(Boolean).pop() || '', session.hostApp);
  if (r && r.command) attachCommands.set(item.id, r.command); else attachCommands.delete(item.id);
  if (r && r.cant) return { ok: false, note: r.cant, command: r.command || null };
  return { ok: !!r, app: r ? r.app : null };
});

// The widget grows by the waiting-input bubble's height (the renderer
// measures it) or the "While you were away" recap once a busy spell ends.
// The bubble wins: it is what blocks a session. The quiet "Update ready"
// row comes last: it never hides either of those.
const AWAY_PX = 64;
const UPDATE_PX = 72;
const BUBBLE_MAX_PX = 300;
const BUDGET_PX = 64;
const BUBBLE_MIN_W = 230;
const WidgetStrip = require('./src/widget-strip.js');
let strip = WidgetStrip.NONE;
let applyingStrip = false;
let updateRowShown = false;
ipcMain.on('update-row', (e, on) => {
  if (e.sender !== win?.webContents || !!on === updateRowShown) return;
  updateRowShown = !!on;
  broadcastStatus();
});
let bubblePx = 0;
let stripAway = false;
let stripBudget = false;
ipcMain.on('set-bubble-height', (e, px) => {
  if (!win || e.sender !== win.webContents) return;
  bubbleAsked = Math.round(Number(px) || 0);
  bubbleAcked = null;
  bubblePx = Math.max(0, Math.min(BUBBLE_MAX_PX, bubbleAsked));
  applyStrip(travelLook ? 0 : bubblePx, stripAway, updateRowShown && !travelLook, stripBudget && !travelLook);
});
// The widget's size is the base (src/widget-strip.js); the strip adds the
// bubble's or the recap's height, and width for the bubble. Computed from the
// base every time, so a clamp can't make the widget creep, and saved bounds
// never include it.
// The widget hears when the bubble really has its room: until then its body
// may be clipped (a roam or the garden defers the resize), so nothing in it
// counts as seen and it can't be answered.
let bubbleAsked = 0;
let bubbleAcked = null;
function ackStrip() {
  if (!WidgetStrip.shouldAck(strip, bubbleAsked, bubbleAcked, BUBBLE_MAX_PX) || !win || win.isDestroyed()) return;
  bubbleAcked = bubbleAsked;
  win.webContents.send('strip-applied', bubbleAsked);
}
function applyStrip(asking, away = false, update = false, budget = false) {
  if (!win) return;
  const next = asking ? { kind: 'bubble', px: Math.min(BUBBLE_MAX_PX, asking), minWidth: BUBBLE_MIN_W } : budget ? { kind: 'budget', px: BUDGET_PX, minWidth: BUBBLE_MIN_W } : away ? { kind: 'away', px: AWAY_PX } : update ? { kind: 'update', px: UPDATE_PX } : { kind: null };
  if (WidgetStrip.sameStrip(strip, next)) { ackStrip(); return; }
  // The garden or a roam is moving the widget's own rect: grow once it's home
  // (the next broadcast tries again).
  if (gardenRun || roamState.busy) return;
  const cur = win.getBounds();
  const r = WidgetStrip.stripBounds(cur, strip, next, screen.getDisplayMatching(WidgetStrip.baseOf(cur, strip)).workArea);
  const maxH = Math.round(MAX_WIDTH / WIDGET_ASPECT);
  applyingStrip = true;
  strip = r.strip;
  try {
    win.setAspectRatio(0);
    win.setMaximumSize(Math.max(MAX_WIDTH, r.bounds.width), maxH + r.strip.px);
    win.setBounds(r.bounds);
    if (!r.strip.px) { win.setMaximumSize(MAX_WIDTH, maxH); win.setAspectRatio(WIDGET_ASPECT); }
  } finally { applyingStrip = false; }
  saveBounds();
  ackStrip();
}

utilityHandle('preview-sound', widgetConfigSender, (e, name) => playSound(name));

utilityHandle('export-rules', widgetConfigSender, async (e, rules) => {
  const r = await dialog.showSaveDialog(lightsWin || undefined, { title: 'Export rules', defaultPath: path.join(app.getPath('documents'), 'claude-traffic-light-rules.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(Rules.shareFile(rules || []), null, 2));
  return r.filePath;
});

utilityHandle('import-rules', widgetConfigSender, async () => {
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
    home: IS_DEV_RUN ? path.join(os.tmpdir(), 'plexiform-mcp-dev-home') : os.homedir(),
    entry: McpInstall.launch({ packaged: app.isPackaged, execPath: HOOK_PATHS.execPath || process.execPath, appPath: HOOK_PATHS.mcpAppPath, dir: __dirname, root: process.env.CLAUDE_TRAFFIC_LIGHT_HOME }),
  };
}
let nativeBoardService = null;
function nativeBoardDir() { return path.join(app.getPath('userData'), 'native-board'); }
function getNativeBoard() {
  if (!nativeBoardService) {
    const storage = require('electron').safeStorage;
    // A status read with no saved connector records needs no Keychain key.
    // Ask the OS only when encrypted bytes are actually read or written.
    const secureStorage = () => {
      if (!storage.isEncryptionAvailable() || (process.platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('Secure account storage is unavailable on this computer.');
      return storage;
    };
    nativeBoardService = NativeBoard.createService({
      dir: nativeBoardDir(), seal: (s) => secureStorage().encryptString(s), unseal: (b) => secureStorage().decryptString(b),
      resolveWorkspace: (id) => getBuddy().nativeBoardContext(id), workspaces: () => getBuddy().nativeBoardWorkspaces(),
      home: IS_DEV_RUN ? path.join(app.getPath('userData'), 'native-board-dev-home') : os.homedir(),
      launchOptions: { execPath: HOOK_PATHS.execPath || process.execPath, appPath: HOOK_PATHS.mcpAppPath || __dirname },
    });
  }
  return nativeBoardService;
}
const fromNativeBoardSettings = settingsOnly;
const nativeBoardAction = (fn) => async (e, ...args) => {
  if (!fromNativeBoardSettings(e)) return { ok: false, error: 'Not allowed.' };
  try { return await fn(getNativeBoard(), ...args); } catch (err) { return { ok: false, error: err.message }; }
};
ipcMain.handle('native-board-status', nativeBoardAction((s) => s.status()));
ipcMain.handle('native-board-boards', nativeBoardAction((s, workspace) => {
  if (typeof workspace !== 'string' || workspace.length > 350) return { ok: false, error: 'Choose a workspace.' };
  return s.boards(workspace);
}));
ipcMain.handle('native-board-connect', nativeBoardAction((s, input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['target', 'workspaceId', 'boardIds', 'mode'].includes(k)) || !Array.isArray(input.boardIds) || input.boardIds.length > 32) return { ok: false, error: 'Choose the app, workspace and boards.' };
  return s.connect(input);
}));
ipcMain.handle('native-board-disconnect', nativeBoardAction((s, target) => s.disconnect(target)));
onQuit(app, () => { nativeBoardService?.stop().catch(() => {}); });
utilityHandle('mcp-status', settingsOnly, () => McpInstall.status(mcpOpts()));
utilityHandle('mcp-set-enabled', settingsOnly, (_e, on) => {
  try {
    const r = on ? McpInstall.install(mcpOpts()) : McpInstall.uninstall(mcpOpts());
    console.log(`[mcp] ${on ? 'registered' : 'unregistered'} in ${r.path}${r.changed ? '' : ' (no change)'}`);
    return McpInstall.status(mcpOpts());
  } catch (err) {
    console.warn('[mcp] registration failed:', err.message);
    return { ...McpInstall.status(mcpOpts()), error: err.message };
  }
});

const AiTools = require('./src/ai-tools-wire.js').wire({ ipcMain, shell, clipboard, home: os.homedir(), runtime: HOOK_RUNTIME, rootDir: ROOT_DIR, fromPage: (e) => fromUtilityPage(e, 'aitools'), askFromWidget: () => !!loadConfig().askFromWidget, ephemeral: EPHEMERAL, openPage: openBuddy });
const aiToolsOpen = (destination) => AiTools.open(destination);
// Preferences' "Connect other agents" buttons open the AI tools page on that
// tool, where the exact change is previewed and confirmed (src/ai-tools.js).
ipcMain.handle('connect-agent', async (e, which) => {
  if (!fromNativeBoardSettings(e)) return { ok: false, error: 'Not allowed.' };
  if (typeof which !== 'string' || !['codex', 'cursor', 'gemini', 'hermes'].includes(which)) return { ok: false };
  return { ok: aiToolsOpen(`aitools:${which}`), opened: true };
});
ipcMain.handle('git-status', (e) => settingsOnly(e) ? ({ ...git.status(), enabled: loadConfig().gitSignals !== false }) : null);
utilityHandle('signal-endpoint', e => settingsOnly(e) || widgetConfigSender(e), () => ({ port: SIGNAL_PORT, emit: EMIT_SCRIPT, token: path.join(ROOT_DIR, 'token') }));
// Not the signal server's port: an ssh -R tunnel makes this one reachable to
// every user of the far host, so it serves only the signed device route.
// A bad override is reported in Settings, never thrown at startup.
const REMOTE_PORT = process.env.CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT ? Number(process.env.CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT) : SIGNAL_PORT + 1;
function syncTailnetListener() {
  return RemoteDevices.syncTailnet(!!loadConfig().remoteTailscale, REMOTE_PORT)
    .then((r) => { if (r.error) console.log('[remote]', r.error); return r; })
    .catch((e) => { console.log('[remote] tailnet:', e.message); });
}
function remoteDevicesView() {
  const live = {};
  for (const s of readRemoteSessions(loadConfig())) live[s.device] = (live[s.device] || 0) + 1;
  return { devices: RemoteDevices.list(live), port: REMOTE_PORT, loopback: RemoteDevices.loopbackStatus(), tailnet: { enabled: !!loadConfig().remoteTailscale, ...RemoteDevices.tailnetStatus() } };
}
utilityHandle('remote-devices', settingsOnly, () => remoteDevicesView());
// The pairing code goes to the window that asked, once; nothing else keeps it.
utilityHandle('remote-pair', settingsOnly, (_e, name) => {
  const r = RemoteDevices.pair(String(name || ''));
  return r.error ? { error: r.error } : { ...remoteDevicesView(), paired: r.device, code: r.code };
});
// The clipboard forgets the code after a minute, unless something else has
// been copied since.
utilityHandle('remote-copy-code', settingsOnly, (_e, code) => {
  const text = String(code || '');
  if (!/^buddy-pair-v1\./.test(text)) return false;
  clipboard.writeText(text);
  setTimeout(() => { if (clipboard.readText() === text) clipboard.writeText(''); }, 60000);
  return true;
});
utilityHandle('remote-revoke', settingsOnly, (_e, id) => {
  const revoked = RemoteDevices.revoke(String(id || ''));
  return { ...remoteDevicesView(), revoked };
});

// ── Health (Preferences → Health, tray Health…) ────────────────────────────
// The updater answers synchronously from its last check.
const updateStatus = () => (Updater ? Updater.healthStatus() : { state: 'unknown' });
function healthReport() {
  const report = Health.runChecks({
    home: os.homedir(),
    root: ROOT_DIR,
    projectsDir: PROJECTS_DIR || undefined,
    runtime: HOOK_RUNTIME,
    askFromWidget: !!loadConfig().askFromWidget,
    version: app.getVersion(),
    updateStatus,
    mcp: McpInstall.status(mcpOpts()),
    signal: { listening: !!signalServer?.listening, port: SIGNAL_PORT, error: signalServerError },
    burst: BurstIpc.status(),
    burstFacts: BurstIpc.healthFacts(),
  });
  // Dev runs share the machine with a real install and never rewrite its hooks.
  report.checks = report.checks.map(({ fix, fixLabel, ...c }) =>
    ((!AUTO_INSTALL_HOOKS && ['reinstall-hooks', 'connect-codex', 'connect-hermes'].includes(fix)) || (!app.isPackaged && ['connect-codex', 'connect-hermes'].includes(fix)))
      ? c : { ...c, ...(fix ? { fix, fixLabel } : {}) });
  return report;
}
utilityHandle('health-report', settingsOnly, () => healthReport());
ipcMain.handle('health-fix', (e, id) => {
  if (!fromNativeBoardSettings(e)) return { error: 'Not allowed.' };
  // Enabling goes through Hermes' own CLI, so this one fix answers asynchronously.
  if (id === 'connect-hermes' && app.isPackaged && AUTO_INSTALL_HOOKS) {
    return require('./adapters/hermes-activity').connect({ home: os.homedir(), runtime: HOOK_RUNTIME })
      .then((r) => r.ok ? null : r.error || 'Hermes activity could not be connected.', (err) => err.message)
      .then((error) => { console.log(`[health] fix "connect-hermes"${error ? ` failed: ${error}` : ''}`); return { error, report: healthReport() }; });
  }
  // burst-<action>: an allow-listed Burst mutation (src/burst-ipc.js), behind its own consent dialog.
  if (typeof id === 'string' && id.startsWith('burst-')) {
    return BurstIpc.runAction(id.slice('burst-'.length)).then((r) => {
      const error = r.ok || r.cancelled ? null : r.error;
      console.log(`[health] fix ${JSON.stringify(id)}${error ? ` failed: ${error}` : r.cancelled ? ' cancelled' : ''}`);
      return { error, data: r.ok ? r.data : null, cancelled: r.cancelled === true, report: healthReport() };
    });
  }
  let error = null;
  try {
    if (id === 'reinstall-hooks') {
      if (!AUTO_INSTALL_HOOKS) error = EPHEMERAL ? 'Plexiform is running from a temporary copy or a disk image; move it to Applications first' : 'dev runs never install hooks';
      else { error = installHooks(); createTray(); }
    } else if (id === 'connect-codex') {
      if (!fromNativeBoardSettings(e)) error = 'Not allowed.';
      else if (!app.isPackaged || !AUTO_INSTALL_HOOKS) error = 'Open the installed app to connect Codex.';
      else {
        const r = Adapters.get('codex').installActivity({ home: os.homedir(), runtime: HOOK_RUNTIME });
        if (!r.ok) error = r.error || 'Codex hooks could not be configured.';
      }
    } else if (id === 'connect-hermes') error = 'Open the installed app to connect Hermes.';
    else if (id === 'enable-mcp') McpInstall.install(mcpOpts());
    else if (id === 'clear-stale-locks') Health.clearStaleLocks({ root: ROOT_DIR });
    else if (id === 'open-burst-console') BurstIpc.openConsole().catch((err) => console.log(`[health] burst console: ${err.message}`));
    else error = 'unknown fix';
  } catch (err) { error = err.message; }
  console.log(`[health] fix ${JSON.stringify(id)}${error ? ` failed: ${error}` : ''}`);
  return { error, report: healthReport() };
});
// Preferences → Backups. Settings is the only caller.
const backupsSenderOk = settingsOnly;
const backupsOff = { error: 'Backups are off in this run.' };
const safeId = Backups.isSnapshotId;
ipcMain.handle('backups-list', (e) => {
  if (!backupsSenderOk(e)) return { error: 'not allowed' };
  return backups ? { dir: backups.dir, snapshots: backups.list() } : backupsOff;
});
ipcMain.handle('backups-now', (e) => {
  if (!backupsSenderOk(e)) return { error: 'not allowed' };
  if (!backups) return backupsOff;
  try { return backups.snapshot('manual'); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('backups-diff', (e, id) => {
  if (!backupsSenderOk(e)) return { error: 'not allowed' };
  if (!backups) return backupsOff;
  return safeId(id) ? backups.diff(id) : { error: 'bad arguments' };
});
ipcMain.handle('backups-restore', (e, id, pick) => {
  if (!backupsSenderOk(e)) return { error: 'not allowed' };
  if (!backups) return backupsOff;
  if (!safeId(id)) return { error: 'bad arguments' };
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 500) : undefined);
  let r;
  const prevConfig = loadConfig();
  try { r = backups.restore(id, { files: strs(pick?.files), configKeys: strs(pick?.configKeys) }); } catch (err) { return { error: `Could not restore: ${err.message}` }; }
  if (r.error) return r;
  console.log(`[backups] restored ${id}: ${JSON.stringify(r.restored)} keys ${JSON.stringify(r.configKeys)}`);
  // Config and rules are read from disk on every change; usage history is
  // held by the history worker, so restoring it takes a relaunch.
  configCache = { key: null, value: null };
  historyStore = null;
  cameosChanged();
  applyConfigEffects(prevConfig, loadConfig());
  const relaunch = r.usage && !IS_DEV_RUN;
  if (relaunch) setTimeout(() => { app.relaunch(); app.exit(0); }, 2500);
  return { ...r, relaunch };
});
ipcMain.handle('backups-open-folder', (e) => {
  if (!backupsSenderOk(e) || !backups) return null;
  fs.mkdirSync(backups.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(backups.dir, 0o700); } catch { /* not ours to change */ }
  return shell.openPath(backups.dir);
});

// Shared by Health's Copy diagnostics and the feedback form, so both carry
// the same already-scrubbed text.
function buildDiagnostics() {
  let logText = '';
  for (const f of ['app.log.old', 'app.log']) { try { logText += fs.readFileSync(path.join(ROOT_DIR, f), 'utf8'); } catch { /* rotated away or never written */ } }
  const text = Health.diagnostics({
    report: healthReport(),
    versions: process.versions,
    platform: { os: process.platform, release: IS_MAC ? `macOS ${process.getSystemVersion()}` : os.release(), arch: process.arch, packaged: app.isPackaged },
    logText,
    // Watched repos and open sessions' folders (the names notifications
    // show) name projects too.
    scrubWith: {
      home: os.homedir(), user: os.userInfo().username, hostname: os.hostname(),
      names: [
        ...(git.status().repos || []).map((r) => r.repo),
        ...(loadConfig().gitRepos || []),
        ...aggregateState().sessions.map((x) => String(x.cwd || '').split('/').filter(Boolean).pop() || ''),
      ],
    },
  });
  return text;
}
utilityHandle('health-copy-diagnostics', settingsOnly, () => {
  const text = buildDiagnostics();
  clipboard.writeText(text);
  return { lines: text.split('\n').length - 1 };
});

utilityHandle('choose-sound-file', widgetConfigSender, async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, {
    title: 'Choose a sound',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['aiff', 'aif', 'wav', 'mp3', 'm4a', 'caf'] }],
  });
  return r.canceled || !r.filePaths[0] ? null : `file:${r.filePaths[0]}`;
});

utilityHandle('cameos-list', widgetConfigSender, () => cameoListing());
utilityHandle('cameos-choose-file', widgetConfigSender, async () => {
  const r = await dialog.showOpenDialog(lightsWin || undefined, {
    title: 'Choose a photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return Cameos.readSource(nativeImage, r.filePaths[0]); } catch (err) { return { error: err.message }; }
});
utilityHandle('cameos-add', widgetConfigSender, (_e, p) => {
  const res = Cameos.addPhoto({ dir: CAMEO_DIR, nativeImage, source: p?.source, rect: p?.rect, shape: p?.shape, name: p?.name, replace: p?.replace, eyes: p?.eyes, mouth: p?.mouth });
  if (res.error) return { error: res.error };
  return { id: res.id, list: cameosChanged() };
});
utilityHandle('cameos-remove', widgetConfigSender, (_e, id) => {
  try {
    backupFirst();
    Cameos.removePhoto(CAMEO_DIR, String(id));
    return cameosChanged();
  } catch (err) { return { error: err.message }; }
});

// The whole setup (setup.js) as one file. Import is two steps so the user sees
// what's in the file before choosing replace or merge; the parsed file waits
// here in between.
const readCameoPng = (id) => fs.readFileSync(path.join(CAMEO_DIR, `${id}.png`));
let pendingSetup = null;
utilityHandle('setup-export', e => settingsOnly(e) || widgetConfigSender(e), async (e) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) || undefined, { title: 'Export setup', defaultPath: path.join(app.getPath('documents'), 'plexiform-setup.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  try {
    const bundle = Setup.exportSetup({ config: loadConfig(), cameoIndex: Cameos.loadIndex(CAMEO_DIR), readPng: readCameoPng });
    fs.writeFileSync(r.filePath, JSON.stringify(bundle, null, 2));
    return { file: r.filePath, cameos: bundle.cameos.length };
  } catch (err) { return { error: `Could not export: ${err.message}` }; }
});
utilityHandle('setup-import-pick', widgetConfigSender, async () => {
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
utilityHandle('setup-import-apply', widgetConfigSender, (_e, mode) => {
  if (!pendingSetup) return { error: 'Choose a setup file first.' };
  backupFirst();
  const plan = Setup.planImport(pendingSetup, { config: loadConfig(), cameoIndex: Cameos.loadIndex(CAMEO_DIR), readPng: readCameoPng }, mode === 'replace' ? 'replace' : 'merge');
  pendingSetup = null;
  // Faces first, so rules that wear them resolve on the first broadcast.
  for (const id of plan.remove) Cameos.removePhoto(CAMEO_DIR, id);
  const failed = plan.add.map((c) => Cameos.importPhoto(CAMEO_DIR, c)).filter((x) => x.error).map((x) => x.error);
  const cameos = cameosChanged();
  return { config: commitConfig(plan.partial), cameos, failed };
});

utilityHandle('reset-rules', widgetConfigSender, () => {
  backupFirst();
  const next = saveConfig({ rules: Rules.defaultRules() });
  broadcastStatus();
  return next;
});

// The Lights editor can push a look onto the real widget for a few seconds so
// the user sees the rule in place, at size, in the corner it actually lives in.
utilityHandle('preview-on-widget', widgetConfigSender, (e, look, ms = 4000) => {
  previewLook = { look, expiresAt: Date.now() + ms };
  win?.show();
  broadcastStatus();
  setTimeout(() => {
    if (previewLook && Date.now() >= previewLook.expiresAt) previewLook = null;
    broadcastStatus();
  }, ms + 50);
});

ipcMain.handle('open-lights', e => { if (widgetOnly(e) || fromUtilityPage(e, 'help')) createLightsWindow(); });
ipcMain.handle('open-preferences', e => { if (widgetConfigSender(e)) createSettingsWindow(); });

// A subtle system alert sound when the resolved look's sound channel turns on
// (transition only, not every poll).
let lastSoundKey = null;
function maybePlayAlertSound() {
  const config = loadConfig();
  const { look, reason, owned } = aggregateState();
  if (reason === 'preview') return;
  const { key, restored } = GitSignals.soundKey(look, owned, config.rules, config.gitSignals !== false ? git.active() : []);
  // F5: a git rule's sound is held while you're busy like any other rule's.
  if (config.sounds && key && key !== lastSoundKey && !restored && pingAllowed(owned.sound, { lamp: look.lamp })) playSound(look.sound);
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
const DEV_PROFILE = IS_DEV_RUN ? path.join(os.tmpdir(), `plexiform-dev-${process.pid}`) : null;
if (DEV_PROFILE) {
  app.setPath('userData', DEV_PROFILE);
  const sweep = () => { try { fs.rmSync(DEV_PROFILE, { recursive: true, force: true }); } catch { /* already gone */ } };
  onQuit(app, sweep);
  process.on('exit', sweep);
  // Sweep profiles orphaned by a hard kill, so /tmp doesn't fill up.
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      const m = /^plexiform-dev-(\d+)$/.exec(d);
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
      const link = argv.find((a) => DEEP_LINK_RE.test(a));
      if (link) handleDeepLink(link);
      else if (argv.includes('--lights')) createLightsWindow();
      else if (argv.includes('--buddy')) openBuddy();
      else if (WindowLaunch.shouldOpenWindowOnLaunch({ ...windowLaunchInput('second-instance'), atLogin: false })) { console.error('[startup] second-instance: opening window'); openBuddy(); }
      else win?.show();
    } catch (err) {
      console.error('[second-instance] could not surface a window:', err.message);
    }
  });
}

// While the old app is installed its Open at Login can start it again, and
// the two would fight over the hooks: ask it to quit, and say why. Runs at
// start (waiting up to 5 s, so it frees the signal port), 30 s later and on
// wake (not waiting). Its own start-up install may have pointed the hooks back
// at itself, so once it has gone they are put back.
function quitOldAppIfInstalled(waitMs = 0) {
  if (!RenameMigration.oldAppInstalled({ platform: process.platform, home: os.homedir() })) return;
  const { asked } = RenameMigration.quitOldInstance({ ...quitOldOpts, waitMs });
  if (asked.length) RenameMigration.whenGone(asked, () => { if (AUTO_INSTALL_HOOKS && !areHooksInstalled()) installHooks({ narrow: true }); });
  if (asked.length && Notification.isSupported()) new Notification({ title: `${RenameMigration.OLD.productName} was running`, body: `It is ${Brand.name} now, so the old app was asked to quit. Remove it, or turn off its Open at Login.`, silent: true }).show();
}

// src/rename-migration.js, after ready; each step runs until it succeeds.
function renameFollowUp() {
  const home = os.homedir();
  quitOldAppIfInstalled(5000);
  if (renameCopy?.retry && Notification.isSupported()) new Notification({ title: `${RenameMigration.OLD.productName} settings come across next launch`, body: `${RenameMigration.OLD.productName} was still running. Quit it, then open ${Brand.name} again.`, silent: true }).show();
  if (renameCopy?.gaveUp && Notification.isSupported()) new Notification({ title: `${RenameMigration.OLD.productName} settings did not come across`, body: `${Brand.name} stopped trying after ${RenameMigration.MAX_TRIES} launches (${renameCopy.reason}). Your old settings are still in ${OLD_USER_DATA}.`, silent: true }).show();
  return RenameMigration.runFollowUp({
    userData: app.getPath('userData'),
    steps: {
      // From a translocated copy or a disk image the hooks would point at a temporary path, and any
      // config that couldn't be rewritten still runs the old app: either way, try again next launch.
      hooks: () => (AUTO_INSTALL_HOOKS ? RenameMigration.rewriteHooks({ home, runtime: HOOK_RUNTIME, askFromWidget: !!loadConfig().askFromWidget, mcpEntry: mcpOpts().entry }).every((r) => !r.error) : false),
      login: () => {
        if (EPHEMERAL) return false;
        if (RenameMigration.moveLoginItem({ platform: process.platform, app, loginItem: LoginItem, autoLaunchConfigured: fs.existsSync(path.join(ROOT_DIR, '.auto-launch-configured')) }) && Notification.isSupported()) new Notification({ title: `${Brand.name} opens at login`, body: `As ${RenameMigration.OLD.productName} was set to. Turn it off from the tray menu if you'd rather it didn't.`, silent: true }).show();
      },
      // An ephemeral copy can't re-point the hooks, so the old app stays until it can.
      'remove-old-app': () => !EPHEMERAL && RenameMigration.offerRemoveOldApp({
        platform: process.platform, home, name: Brand.name, stillUsedBy: RenameMigration.findOldReferences({ home, runtime: HOOK_RUNTIME }),
        showDialog: (opts) => { app.focus({ steal: true }); return dialog.showMessageBox(opts); },
        trashItem: (p) => shell.trashItem(p),
      }),
    },
  });
}

app.whenReady().then(() => {
  if (DEMO || DIAG) console.error('[startup] ready');
  if (process.platform === 'darwin') app.dock.hide();
  // Release CI: start, install hooks, run one, open the window, quit (src/smoke.js).
  const smokeReport = Smoke.reportPathFrom(process.argv);
  // An AppImage's copies for older versions go only once this is the one running instance.
  if (gotLock) { try { HookPaths.prune(HOOK_PATHS); } catch (err) { console.warn('[hooks] could not tidy old copies:', err.message); } }
  if (smokeReport) { Smoke.run({ app, installHooks, areHooksInstalled, createWindow, getWindow: () => win, settingsPath: CLAUDE_SETTINGS_PATH, sessionsDir: SESSIONS_DIR, reportPath: smokeReport }); return; }
  if (fs.existsSync(path.join(nativeBoardDir(), 'connections.bin'))) {
    try { getNativeBoard().start().catch(() => console.warn('[native-board] saved connections could not start')); }
    catch { console.warn('[native-board] saved connections require reconnecting in Settings'); }
  }
  // The rest of the rename migration, once, before the hook check below: a
  // running old copy is asked to quit and every agent config already points
  // here. Its last step (offer to bin the old app) waits on the person.
  if (RENAME_MIGRATES && gotLock) {
    renameFollowUp().catch((err) => console.warn('[rename]', err.message));
    RenameMigration.watchOldApp({ check: quitOldAppIfInstalled, powerMonitor });
  }
  // Dev runs share the machine with a real install: they must not rewrite the
  // user's hooks or claim Open at Login out from under it.
  if (AUTO_INSTALL_HOOKS && !areHooksInstalled()) installHooks();

  const autoLaunchMarker = path.join(ROOT_DIR, '.auto-launch-configured');
  if (!IS_DEV_RUN && !fs.existsSync(autoLaunchMarker)) {
    LoginItem.set(true);
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.writeFileSync(autoLaunchMarker, new Date().toISOString());
  }

  createWindow();
  // In-app updates on every platform, each checked against the signed release
  // (src/updater/). A dev run gets the IPC but never installs; the visual tests
  // stand in a fixture-driven stub instead (excluded from the package).
  if (IS_DEV_RUN && !app.isPackaged && process.env.CLAUDE_BUDDY_UPDATER_STUB) {
    const UpdateStub = require('./src/update-stub.js');
    updaterService = UpdateStub.create(process.env.CLAUDE_BUDDY_UPDATER_STUB);
    UpdateStub.register(ipcMain, updaterService);
  } else {
    updaterService = Updater.start({ app, ipcMain, net, dev: IS_DEV_RUN, isBusy: () => Updater.busyReason(aggregateState({ ignoreTravel: true })) });
    Updater.markLaunched({ app });
  }
  watchUpdater();
  createTray();
  signalServer = startSignalServer();
  syncFastHook();
  signalServer.on('error', (e) => { signalServerError = e.code || e.message; });
  signalServer.on('listening', () => { signalServerError = null; });
  // Rate limits live in the detector (one capture per pane per 15 s, four per scan).
  every(5000, () => { scanPaneDialogs().catch((err) => console.warn('[pane-dialogs]', err.message)); }, 'pane-dialogs');
  // Dev and demo runs share this machine with a real install; they only
  // listen for devices when given a port of their own.
  if (!IS_DEV_RUN || process.env.CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT) RemoteDevices.listenLoopback(REMOTE_PORT);
  syncTailnetListener();
  // Tailscale can come up (or change address) after Buddy does.
  every(60000, () => { if (loadConfig().remoteTailscale) syncTailnetListener(); }, 'tailnet');
  if (backups) {
    backups.dailyCheck();
    every(60 * 60 * 1000, () => backups.dailyCheck(), 'backups');
  }
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
  (async () => {
    // `--buddy-mock-accounts` (dev): the mock accounts hub on loopback, listening before anything below can create the window.
    if (devMock) {
      devAccountsHub = await devMock.listen(); // privacy-flow: local-board-hub
      devMockReady = true;
      console.log('[buddy] mock accounts hub at', devAccountsHub);
      onQuit(app, () => { devMock.close(); });
    }
    // Links that arrived before ready (cold start), then any in our own argv
    // (Windows/Linux pass the link as an argument).
    linksReady = true;
    for (const link of [...pendingLinks.splice(0), ...process.argv.filter((a) => DEEP_LINK_RE.test(a))]) handleDeepLink(link);
    // Runners the member left on come back at launch, window or not; a dev
    // run shares the Mac with an installed app, so only when asked to.
    const resumeRunners = app.isPackaged ? !IS_DEV_RUN : process.env.BUDDY_RESUME_RUNNERS === '1';
    if (resumeRunners) { try { getBuddy().resumeDevices(); } catch (err) { console.error('[buddy] could not resume runners:', err.message); } }
    syncInteractionHost();
    if (WindowLaunch.shouldOpenWindowOnLaunch(windowLaunchInput('launch'))) { console.error('[startup] opening window'); openBuddy(); }
    // Dev: `electron . --buddy [page] [--buddy-shot out-prefix]` opens the Buddy
    // window (optionally on a page) and can capture both halves, then quit.
    // `--buddy-accounts-walk prefix` (with --buddy-mock-accounts) walks the
    // account flow against the mock hub, capturing each step.
    if (!process.argv.includes('--buddy')) return;
    const at = process.argv.indexOf('--buddy');
    const page = process.argv[at + 1]?.startsWith('--') ? null : process.argv[at + 1] ?? null;
    const mock = devMock;
    openBuddy(page);
    const connectAt = app.isPackaged ? -1 : process.argv.indexOf('--buddy-connect');
    if (connectAt > 0 && process.argv[connectAt + 1]) buddyWin.devConnect(process.argv[connectAt + 1]).then((r) => console.log('[buddy-connect]', JSON.stringify(r)));
    const walkAt = app.isPackaged || !mock ? -1 : process.argv.indexOf('--buddy-accounts-walk');
    if (walkAt > 0 && process.argv[walkAt + 1]) {
      require('./buddy-window/dev-walk').walkAccounts({ buddy: buddyWin, mock, hub: devAccountsHub, prefix: process.argv[walkAt + 1], fs })
        .catch((err) => console.error('[walk] failed:', err.stack))
        .finally(() => app.quit());
      return;
    }
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
  })();
  // After the widget has had time to appear, so the panel can sit beside it.
  if (process.argv.includes('--help-window') || process.argv.includes('--shot-help')) setTimeout(createHelpWindow, 1200);
  else setTimeout(maybeAutoShowHelp, 2500);

  // A busy turn writes its session file many times a second and every write
  // fires this watcher — coalesce them into at most one refresh per 250 ms.
  let watchTimer = null;
  fs.watch(SESSIONS_DIR, { persistent: true }, () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      broadcastStatusIfChanged();
      saveLastHook();
      maybePlayAlertSound();
      refreshUsageLive();
      refreshSpend(SPEND_LIVE_MS);
    }, 250);
  });

  every(4000, () => {
    broadcastStatusIfChanged();
    maybePlayAlertSound();
    tickStats(readSessions(loadConfig()));
    saveLastHook();
  }, 'poll');
  every(30000, flushStats, 'stats-flush');
  // GitHub is asked at most once a poll interval (github-signals decides);
  // dev runs never call gh, but still show saved events.
  if (IS_DEV_RUN) git.pause('dev-run');
  else {
    gitTick = () => {
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
  }
  refreshSpend();
  every(SPEND_POLL_MS, awayFeeds.tick, 'feeds');
  syncEyePoll();
  applyLowPower();
  watchPowerForMotion();
  sweepSessionFiles();
  every(10 * 60 * 1000, sweepSessionFiles, 'session-sweep');
  checkOnline();
  every(60000, checkOnline, 'net');
  BusyWatch.start();
  powerMonitor.on('resume', checkOnline);
  initVoice();
  // Other agents live on disk, not in hooks: poll for them.
  if (!DEMO) { syncAgents(); every(OMC_POLL_MS, syncAgents, 'omc-agents'); }

  if (AUTO_INSTALL_HOOKS) every(10 * 60 * 1000, () => { if (!areHooksInstalled()) installHooks(); }, 'hooks');
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
        report.terminal = await terminalForSessions(localSessions(st.sessions));
        report.result = await knockNow();
      } catch (e) {
        report.error = e.stack || e.message;
      }
      // stderr, and a file: a GUI Electron process does not reliably deliver
      // stdout to a redirected shell.
      console.error('[demo knock]', JSON.stringify(report, null, 2));
      try { fs.writeFileSync(path.join(os.tmpdir(), 'plexiform-knock-demo.json'), JSON.stringify(report, null, 2)); } catch { /* ignore */ }
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
app.on('before-quit', () => { flushStats(); backups?.flush(); lightsWin?.destroy(); });
// The embedded board hub gets SIGTERM and a grace period to close its DB
// before we exit, once; a second quit goes straight through.
let hubStopped = false;
app.on('before-quit', (e) => {
  if (hubStopped || (!buddyWin && !tasksProcess && !hostSync.active())) return;
  e.preventDefault();
  hubStopped = true;
  tasksSvc?.stop();
  // Hosting off on the team hub first (≤ 1.5 s), while its sign-in still works.
  hostSync.release().catch(() => {}).finally(() => Promise.allSettled([buddyWin?.stop(), tasksProcess?.stop({ final: true })]).finally(() => app.quit()));
});

app.on('activate', () => {
  if (WindowLaunch.shouldOpenWindowOnLaunch(windowLaunchInput('activate'))) { console.error('[startup] activate: opening window'); openBuddy(); return; }
  if (!lightsWin) win?.showInactive();
});

app.on('window-all-closed', () => {
  // Keep running in the tray.
});
