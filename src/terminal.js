// Terminal / Dock / AppleScript integration, extracted verbatim from main.js.
// A factory so the one call that needs the live session list (runningTerminal)
// can read it without this module importing the aggregation core.
const { app, screen, Notification, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const Rules = require('../rules.js');
const HostApp = require('../hostapp.js');
const Focus = require('./focus/index.js');
const Ids = require('./focus/ids.js');
const Tmux = require('./focus/tmux.js');
const Permission = require('./focus/permission.js');
const Jump = require('./focus/jump.js');
const GhosttyDock = require('./ghostty-dock.js');
const { writeJsonAtomic, processGone } = require('../hooks/session-state.js');
const PowerShell = require('./powershell.js');
const LinuxActivate = require('./linux-activate.js');
const TerminalAccess = require('./terminal-access.js');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const WAITING_SIGNALS = Rules.WAITING_ON_YOU;

// Best-effort: bring the terminal app most likely running the session that
// needs attention to the front, and try to raise the window whose title
// mentions the target folder via the Accessibility API.
const TERMINAL_APPS = process.platform === 'win32'
  ? ['WindowsTerminal', 'wt', 'Windows Terminal', 'powershell', 'cmd', 'Alacritty', 'WezTerm', 'Code', 'Cursor']
  : ['Ghostty Dock', 'Ghostty', 'iTerm2', 'iTerm', 'Terminal', 'Warp', 'Alacritty', 'kitty', 'WezTerm'];

function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// `preferApp`: the app the session's hook recorded (hostApp), tried first.
function activateTerminalApp(folderHint, preferApp = null, session = null, isCancelled = null) {
  if (IS_WIN) {
    // Best effort: AppActivate matches a window title containing the folder,
    // falling back to a terminal's own name.
    return new Promise((resolve) => {
      const tries = [folderHint, 'Windows Terminal', 'PowerShell', 'Command Prompt'].filter(Boolean);
      PowerShell.run(PowerShell.SCRIPTS.appActivate, tries, {}, (err, out) => { // privacy-flow: terminal-jump
        const hit = (out || '').trim();
        resolve(!err && hit && hit !== 'NONE' ? { app: hit, exact: hit === folderHint } : null);
      });
    });
  }
  if (process.platform === 'linux') {
    // exec: true on exit 0, false on another code, throws when wmctrl is missing.
    const exec = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 2000 }, (err) => { // privacy-flow: terminal-jump
      if (err && err.code === 'ENOENT') reject(err); else resolve(!err);
    }));
    const run = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 2000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || ''), missing: !!err && err.code === 'ENOENT' }))); // privacy-flow: terminal-jump
    const sock = session && Ids.tmuxSocket(session);
    const tmuxBin = sock && Focus.tmuxServerOk(sock, Ids.tmuxServerPid(session)) ? Focus.which(Tmux.BINS) : null;
    return LinuxActivate.activate(folderHint, exec, session, run, { isCancelled, tmuxBin });
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

// The Dock gives no API for making another app's icon bounce, so the bounce
// the user sees is Claude physically hopping on the icon. Our own Dock tile is
// asked to bounce too, which is a no-op while the tile is hidden but shows up
// for anyone running with the Dock icon visible.
function bounceOwnDock() {
  if (!IS_MAC || !app.dock) return;
  try { app.dock.bounce('critical'); } catch { /* dock icon hidden */ }
}

// Held so a click still reaches its handler after GC.
const liveNotes = new Set();
function showNote({ title, body, onClick }) {
  console.log(`[jump] ${title}`);
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body, silent: true });
  liveNotes.add(note);
  note.on('click', () => { liveNotes.delete(note); if (onClick) onClick(); });
  note.on('close', () => liveNotes.delete(note));
  note.show();
}

// A session started inside Ghostty Dock can still be recorded as another app
// (stock Ghostty's TERM_PROGRAM, or a session from before Dock was installed).
// When Dock is on and trusted and lists that exact session id, the jump
// targets Dock instead. Only the id is compared; Dock's output never names
// the session or changes anything else about it.
async function adoptIntoDock(s, { mode, dock: Dock = GhosttyDock, detect = Dock.detect, listStatus = Dock.listStatus } = {}) {
  if (!s || mode === 'off' || s.hostApp === Dock.APP || !Dock.validSessionId(s.sessionId)) return null;
  const dock = detect();
  if (!dock || !dock.trusted) return null;
  const listed = await listStatus({ dock });
  return listed && listed.has(s.sessionId.toLowerCase()) ? { ...s, hostApp: Dock.APP } : null;
}

// Getters, because main.js requires this module before it has worked out its
// home folder (a demo run moves it) or its host tag.
// QoL1: is the session's own long-lived process still running? Claude only: Codex's app-server can outlive its
// thread, so it is never called alive. Gone is ESRCH on a pid recorded on this computer (processGone); alive also
// needs that pid to still be a real claude process (agent-awareness's checks), so a reused pid is never alive.
async function sessionLiveness(s, localHost, isAiProcess) {
  if (!s || (s.source ?? 'claude') !== 'claude' || s.host !== localHost) return 'unknown';
  if (processGone(s, localHost)) return 'gone';
  const pid = Number(s.claudePid);
  if (!Number.isInteger(pid) || pid <= 1 || typeof isAiProcess !== 'function') return 'unknown';
  return (await isAiProcess(pid, 'claude')) ? 'alive' : 'unknown';
}

// Open-only terminals (src/focus/jump.js OPEN_ONLY): by bundle id, bounded.
function openBundle(id) {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-b', id], { timeout: 2500, killSignal: 'SIGKILL' }, (err) => resolve(!err)); // privacy-flow: terminal-jump
  });
}

// `appRunning(bundleId)`: main's prompt-free running check for Terminal access's Test (QoL4b, review B4-M1).
module.exports = ({ getSessions, getRootDir, getLocalHost, getGhosttyDockMode = () => 'auto', isAiProcess = null, appRunning = async () => false }) => {
  // ── Jump to the exact tab ─────────────────────────────────────────────────
  // The session file says where the session's tab is (hooks/terminal-id.js);
  // src/focus/ has one adapter per terminal. On macOS, anything short of a
  // hit (nothing recorded, a refused permission, a timeout, a detached tmux
  // session) switches and activates nothing and returns a note saying why;
  // only a call with no session, or another host's session, still activates
  // the app. Another machine's session gets neither (src/focus/jump.js).
  const explainedFile = () => path.join(getRootDir(), 'automation-explained.json');
  const explainer = Permission.createExplainer({
    load: () => JSON.parse(fs.readFileSync(explainedFile(), 'utf8')),
    save: (list) => { fs.mkdirSync(getRootDir(), { recursive: true }); writeJsonAtomic(explainedFile(), list); },
    notify: showNote,
    openSettings: () => shell.openExternal(Permission.SETTINGS_URL), // privacy-flow: os-settings
  });
  // QoL4b: what the jumps and the Test button have seen of each terminal's Automation permission.
  const accessFile = () => path.join(getRootDir(), 'terminal-access.json');
  const access = TerminalAccess.createStore({
    read: () => JSON.parse(fs.readFileSync(accessFile(), 'utf8')),
    write: (obj) => { fs.mkdirSync(getRootDir(), { recursive: true }); writeJsonAtomic(accessFile(), obj); },
    // Asked of LaunchServices by main, never of the app: no prompt, and no script that could launch it (review B4-M1).
    running: (bundle) => appRunning(bundle),
    script: (bundle, timeout) => new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', TerminalAccess.testScript(bundle)], { timeout, killSignal: 'SIGKILL' }, (err, _out, stderr) => resolve({ ok: !err, stderr: String(stderr || ''), timedOut: !!err && err.killed === true }))), // privacy-flow: terminal-jump
  });
  let jumper = null;
  function jumpToSession(session, folderHint, preferApp = null) {
    jumper = jumper || Jump.createJumper({
      localHost: getLocalHost(),
      platform: process.platform,
      // Ghostty Dock's trust is checked afresh on every click on one of its sessions, right before its CLI runs.
      focus: (s, over) => Focus.focusSession(s, { ...over, ghosttyDock: s && s.hostApp === GhosttyDock.APP && getGhosttyDockMode() !== 'off' ? GhosttyDock.detect() : null }),
      adopt: (s) => adoptIntoDock(s, { mode: getGhosttyDockMode() }),
      activate: activateTerminalApp,
      liveness: (s) => sessionLiveness(s, getLocalHost(), isAiProcess),
      openApp: openBundle,
      explainer,
      access: (app, state) => access.record(app, state),
      log: (msg) => console.log(`[jump] ${msg}`),
    });
    return jumper(session, folderHint, preferApp);
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
    return terminalForSessions(getSessions());
  }

  return {
    sessionLiveness,
    showNote,
    TERMINAL_APPS,
    escapeForAppleScript,
    activateTerminalApp,
    jumpToSession,
    adoptIntoDock,
    isRemote: Jump.isRemote,
    osa,
    frontmostApp,
    dockIconRect,
    clampToDisplay,
    runningProcessNames,
    terminalForSessions,
    runningTerminal,
    bounceOwnDock,
    terminalAccess: access,
  };
};
