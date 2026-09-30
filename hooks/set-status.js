#!/usr/bin/env node
// Writes ~/.claude-traffic-light/sessions/<host>-<session_id>.json with the
// RAW signal that just happened. What that signal means visually is decided
// by the rules in the app (rules.js), not here — so changing what a light
// means never requires reinstalling hooks.
//
//   node set-status.js <signal>
//
// signal: prompt-submit | tool-use | tool-done | subagent-done | stop |
//         session-start | compact | notification | session-end
// A hook must never break a Claude Code session: whatever goes wrong, exit 0
// quietly. (The in-process fuzzer passes a process stand-in without .on.)
if (typeof process.on === 'function') process.on('uncaughtException', () => process.exit(0));
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const HOST_TAG = os.hostname().split('.')[0];

const KNOWN = ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'subagent-start', 'subagent-done', 'permission-denied', 'turn-failed', 'stop', 'session-start', 'compact', 'notification', 'session-end', 'task-created', 'task-done', 'permission-request'];
const REQUESTS_DIR = path.join(ROOT_DIR, 'requests');
const { withLock, writeJsonAtomic } = require('./session-state.js');
const Machine = require('./session-machine.js');
// Sessions started under an older install still call `<colour> <reason>`
// (e.g. `green tool-use`); the reason is the signal we want.
const LEGACY_REASONS = { 'prompt-submit': 'prompt-submit', 'tool-use': 'tool-use', notification: 'notification', stop: 'stop', 'session-end': 'session-end' };
const [, , a, b] = process.argv;
const signal = KNOWN.includes(a) ? a : (['green', 'amber', 'red', 'done'].includes(a) && LEGACY_REASONS[b]) || null;
if (!signal) process.exit(0);

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Read the whole payload from stdin. Claude Code pipes it and closes; a
// non-blocking pipe can report EAGAIN before the data lands, so retry
// briefly rather than treating that as "no payload".
let data = null;
let payload = '';
if (!process.stdin.isTTY) {
  const buf = Buffer.alloc(65536);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(sleeper, 0, 0, 10); continue; }
      break;
    }
    if (n === 0) break;
    payload += buf.toString('utf8', 0, n);
  }
  if (payload) {
    try { data = JSON.parse(payload); } catch { /* unparsable payload */ }
  }
}

// ── Which app is this session running inside? ──────────────────────────────
// The widget walks to that app's Dock icon and knocks, so it has to know the
// real host, not just "some terminal is running". Bundle id and TERM_PROGRAM
// are free and cover the common cases; if the session is inside tmux (which
// overwrites TERM_PROGRAM) we walk up the process tree instead. The answer is
// cached in the session file, so the walk happens once per session at most.
const BUNDLE_APPS = {
  'com.mitchellh.ghostty': 'Ghostty',
  'com.googlecode.iterm2': 'iTerm2',
  'com.apple.terminal': 'Terminal',
  'dev.warp.warp': 'Warp',
  'dev.warp.warp-stable': 'Warp',
  'com.microsoft.vscode': 'Visual Studio Code',
  'com.microsoft.vscodeinsiders': 'Visual Studio Code - Insiders',
  'com.visualstudio.code.oss': 'Code - OSS',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf',
  'net.kovidgoyal.kitty': 'kitty',
  'com.github.wez.wezterm': 'WezTerm',
  'org.alacritty': 'Alacritty',
  'co.zeit.hyper': 'Hyper',
  'com.jetbrains.intellij': 'IntelliJ IDEA',
};
const TERM_PROGRAM_APPS = {
  ghostty: 'Ghostty',
  'iterm.app': 'iTerm2',
  apple_terminal: 'Terminal',
  warpterminal: 'Warp',
  warp: 'Warp',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  hyper: 'Hyper',
  wezterm: 'WezTerm',
  kitty: 'kitty',
  alacritty: 'Alacritty',
};
// Process (executable) names as they appear in `ps -o comm=`, lowercased.
const PROCESS_APPS = {
  ghostty: 'Ghostty',
  iterm2: 'iTerm2',
  iterm: 'iTerm2',
  terminal: 'Terminal',
  warp: 'Warp',
  stable: 'Warp',
  code: 'Visual Studio Code',
  'code helper': 'Visual Studio Code',
  electron: 'Visual Studio Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  kitty: 'kitty',
  'kitty-wrapper': 'kitty',
  'wezterm-gui': 'WezTerm',
  wezterm: 'WezTerm',
  alacritty: 'Alacritty',
  hyper: 'Hyper',
};

// Inside tmux the pane's own tree dead-ends at the tmux *server*, which is
// reparented to launchd — it never reaches the terminal window. The tmux
// *client* is the process that does live under the emulator, so that is where
// the walk has to start.
function tmuxClientPid() {
  if (!process.env.TMUX) return null;
  const { execFileSync } = require('child_process');
  try {
    const args = ['display-message', '-p'];
    if (process.env.TMUX_PANE) args.push('-t', process.env.TMUX_PANE);
    args.push('#{client_pid}');
    const pid = Number(execFileSync('tmux', args, { encoding: 'utf8', timeout: 1500 }).trim());
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function appFromProcessTree() {
  if (process.platform !== 'darwin') return null;
  const { execFileSync } = require('child_process');
  let pid = tmuxClientPid() || process.ppid;
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    let line;
    try {
      line = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500 }).trim();
    } catch {
      return null;
    }
    if (!line) return null;
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) return null;
    const parent = Number(m[1]);
    const exe = m[2];
    // `/Applications/Ghostty.app/Contents/MacOS/ghostty` → both "Ghostty" (the
    // bundle) and "ghostty" (the binary) are worth testing.
    const bundle = /\/([^/]+)\.app\//.exec(exe);
    if (bundle && Object.values(BUNDLE_APPS).includes(bundle[1])) return bundle[1];
    const base = (exe.split('/').pop() || '').toLowerCase();
    if (PROCESS_APPS[base]) return PROCESS_APPS[base];
    if (bundle) {
      const hit = Object.values(BUNDLE_APPS).find((n) => n.toLowerCase() === bundle[1].toLowerCase());
      if (hit) return hit;
    }
    pid = parent;
  }
  return null;
}

function detectHostApp(cached) {
  if (cached) return cached;
  const bundle = (process.env.__CFBundleIdentifier || '').toLowerCase();
  if (BUNDLE_APPS[bundle]) return BUNDLE_APPS[bundle];
  const term = (process.env.TERM_PROGRAM || '').toLowerCase();
  // tmux (and screen) replace TERM_PROGRAM with their own name, so the real
  // host is only findable by walking up to the process that owns the window.
  const multiplexed = term === 'tmux' || !!process.env.TMUX || !!process.env.STY;
  if (!multiplexed && TERM_PROGRAM_APPS[term]) return TERM_PROGRAM_APPS[term];
  return appFromProcessTree() || (TERM_PROGRAM_APPS[term] || null);
}

// ── Which process is this session? ─────────────────────────────────────────
// A session killed without SessionEnd (closed terminal, crash, kill) leaves
// its file saying whatever it said last — a question it asked shows as "Needs
// your input" for hours. Recording Claude's pid lets the app drop a session
// whose process is gone. Claude Code runs a hook as its direct child; if a
// shell ever sits in between, recording that short-lived shell would hide a
// live session, so the parent is checked once per session with ps.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
function claudePid(cached) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) return null;
  if (cached === ppid) return ppid;
  const { execFileSync } = require('child_process');
  let pid = ppid;
  for (let depth = 0; depth < 3 && pid > 1; depth += 1) {
    let line;
    try {
      line = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500 }).trim();
    } catch {
      return null;
    }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return null;
    if (!SHELLS.has((m[2].split('/').pop() || '').replace(/^-/, ''))) return pid;
    pid = Number(m[1]);
  }
  return null;
}

const sessionId = (data && (data.session_id || data.sessionId)) || process.env.CLAUDE_SESSION_ID || 'unknown';
const cwd = (data && data.cwd) || process.cwd();
const file = path.join(SESSIONS_DIR, `${HOST_TAG}-${sessionId}.json`);

if (signal === 'session-end') {
  fs.rmSync(file, { force: true });
  process.exit(0);
}

// What this hook prints for Claude Code (the PermissionRequest decision).
let hookOutput = null;

// fs.writeSync rather than process.stdout.write: stdout is a pipe, which is
// asynchronous on macOS, and process.exit would cut a large reply short.
function finish() {
  if (hookOutput) {
    const buf = Buffer.from(JSON.stringify(hookOutput));
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let off = 0; off < buf.length;) {
      try { off += fs.writeSync(1, buf, off); } catch (e) {
        if (e.code !== 'EAGAIN') break;
        Atomics.wait(sleeper, 0, 0, 5);
      }
    }
  }
  process.exit(0);
}

// SessionStart carries the model; a string, or {id, display_name}.
function modelOf(payload) {
  const m = payload && payload.model;
  const id = typeof m === 'string' ? m : m && typeof m === 'object' && typeof m.id === 'string' ? m.id : null;
  return id ? id.slice(0, 80) : null;
}

// Which signal the session machine steps with, and how it came about, is the
// Claude Code adapter's call — the same step /hook/claude takes.
const Claude = require('../adapters/claude-code.js');
const { resolved, askKind, via, tool } = Claude.resolveSignal(signal, data);
if (!resolved) process.exit(0);

// ── Other agents ────────────────────────────────────────────────────────────
// SubagentStart/Stop carry the agent's id and type; every one Claude spawns
// becomes an entry in the session file's `agents` list so the widget can show
// a chip per agent. Teammate/ralph/ultrawork entries come from the app's OMC
// watcher instead and are preserved here untouched.
const DONE_KEEP_MS = 120000;   // a finished agent lingers this long
const AGENT_MAX_MS = 3600000;  // …and a "working" one can never outlive this
function updateAgents(prevAgents, signal, payload, nowIso) {
  const now = Date.parse(nowIso);
  let agents = (Array.isArray(prevAgents) ? prevAgents : []).filter((a) => {
    if (!a || typeof a !== 'object') return false;
    const t = Date.parse(a.since || '') || now;
    // The app's scan owns teammates and mission workers (and, before `source`
    // existed, anything not a plain subagent); the hooks own their own entries
    // whatever kind the scan has since labelled them.
    if (a.source === 'scan' || (a.source !== 'hook' && a.kind && a.kind !== 'subagent')) return true;
    return a.status === 'done' ? now - t < DONE_KEEP_MS : now - t < AGENT_MAX_MS;
  });
  // Not on `stop`: a foreground Agent call blocks the turn, so a turn can only
  // end while *background* agents are still running. They end via SubagentStop.
  if (signal === 'session-start') {
    return agents.map((a) => ((a.source === 'hook' || (!a.source && a.kind === 'subagent')) && a.status !== 'done' ? { ...a, status: 'done' } : a));
  }
  if (signal !== 'subagent-start' && signal !== 'subagent-done') return agents;
  const p = payload || {};
  const id = String(p.agent_id || p.agentId || p.subagent_id || p.task_id || `agent-${now}`);
  // 'oh-my-claudecode:executor' is 'executor' on a 12px chip.
  const name = String(p.agent_type || p.subagent_type || p.agentType || p.agent_name || p.description || 'agent').split(':').pop().slice(0, 40);
  const status = signal === 'subagent-done' ? 'done' : 'working';
  const existing = agents.find((a) => a.id === id);
  if (existing) agents = agents.map((a) => (a.id === id ? { ...a, name: a.name || name, status, since: status === 'done' ? nowIso : a.since, source: 'hook' } : a));
  else agents = agents.concat([{ id, name, kind: 'subagent', status, since: nowIso, parent: sessionId, source: 'hook' }]);
  return agents.slice(-32);
}

// main.js may be mid-write of this same file; a half-written read would
// otherwise wipe agents, workingSince, tasks and mode. Retry once.
function readPrev() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.CLAUDE_TRAFFIC_LIGHT_READ_RETRY_MS || 20));
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`set-status: ${file} unreadable, starting fresh: ${e.message}\n`);
    return null;
  }
}

const prevOnEntry = readPrev();
// A background subagent's own tool hooks (and its denied calls) carry its agent_id.
const fromSubagent = (/^tool-/.test(resolved) || resolved === 'permission-denied') && !!(data && data.agent_id);

// Which signal this write leaves, and the clocks that go with it, is the
// session state machine's call (session-machine.js TRANSITIONS): task events
// and a background agent after the turn ended are bookkeeping, and the idle
// nudge after a failed turn keeps the failure.
function stepOf(prev, now) {
  return Machine.step(prev, { signal: resolved, fromSubagent, writer: 'hook', sessionSource: data?.source }, now);
}

// StopFailure carries error (rate_limit, server_error, unknown, …),
// error_details and last_assistant_message.
function failureOf(payload) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const error = str(payload?.error);
  const detail = str(payload?.error_details) || str(payload?.last_assistant_message);
  const all = [error, str(payload?.error_details), str(payload?.last_assistant_message)].filter(Boolean).join(' ');
  const failKind = /network|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|connection|offline|socket/i.test(all) ? 'network'
    : /rate[ _-]?limit|overloaded|\b529\b|\b429\b/i.test(all) ? 'limit' : 'error';
  return { failReason: [error, detail].filter(Boolean).join(': ').slice(0, 120) || null, failKind };
}

function nextSession(prev, { hostApp, pid }) {
  const now = new Date().toISOString();
  const t = stepOf(prev, now);
  // Task progress for the current turn: created/done counts, reset per prompt.
  let tasks = resolved === 'prompt-submit' ? { created: 0, done: 0 } : (prev?.tasks || { created: 0, done: 0 });
  if (resolved === 'task-created') tasks = { ...tasks, created: tasks.created + 1 };
  if (resolved === 'task-done') tasks = { ...tasks, done: Math.min(tasks.created, tasks.done + 1) };
  const signalOut = t.signal;
  const failure = signalOut !== 'turn-failed' ? { failReason: undefined, failKind: undefined }
    : resolved === 'turn-failed' ? failureOf(data)
    : { failReason: prev?.failReason ?? null, failKind: prev?.failKind || 'error' };
  // A permission notification after the turn ended has no tool call of the
  // main thread behind it (a background agent's, or a stale prompt) — tag it
  // so the app's log shows it.
  const viaOut = t.held ? (prev?.via ?? null)
    : askKind === 'notification' && (prev?.signal === 'stop' || prev?.signal === 'idle-nudge') ? `${via} after-stop` : via;
  // A compaction's SessionStart is the same session carrying on, so its
  // background agents are still running.
  const agents = updateAgents(prev?.agents, resolved === 'compact' ? 'compact' : signal, data, now);
  return {
    sessionId, host: HOST_TAG, hostApp, claudePid: pid || undefined, cwd, signal: signalOut,
    tool: signalOut === resolved ? tool : (prev?.tool ?? null),
    prevSignal: t.prevSignal,
    signalSince: t.signalSince,
    askKind: t.held ? (prev?.askKind ?? null) : askKind,
    via: viaOut,
    ...failure,
    workingSince: t.workingSince, tasks, agents,
    // Execution mode and ralph iteration are owned by the app's OMC watcher;
    // carry them through so a hook write never erases them.
    mode: prev?.mode ?? null,
    iteration: prev?.iteration ?? 0,
    // Claude Code's own word on the model.
    model: modelOf(data) || prev?.model || undefined,
    // When the session last moved, when its agents last did (bookkeeping
    // stamps agentsAt, not updatedAt), and when you last acted on it.
    updatedAt: t.updatedAt,
    agentsAt: t.agentsAt,
    touchedAt: t.touchedAt,
  };
}

// The read has to happen under the lock too, or a hook running alongside
// this one writes in between and this write throws its change away.
function writeSession(proc) {
  withLock(file, () => writeJsonAtomic(file, nextSession(readPrev(), proc)));
}

// The app's signal server is the liveness signal (no pid file exists). A
// synchronous connect probe in a child keeps this script's flow linear.
function appIsUp() {
  try {
    // The app records the port it actually bound (demo modes use others).
    let port = Number(process.env.CLAUDE_TRAFFIC_LIGHT_PORT || 47172);
    try {
      const filePort = Number(fs.readFileSync(path.join(ROOT_DIR, 'port'), 'utf8'));
      if (Number.isInteger(filePort) && filePort > 0 && filePort < 65536) port = filePort;
    } catch {}
    const probe = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`;
    return require('child_process').spawnSync(process.execPath, ['-e', probe], { timeout: 1000, stdio: 'ignore' }).status === 0;
  } catch { return true; }
}

// ── PermissionRequest: a BLOCKING hook. Write the request where the widget
// can see it, then wait for an answer file. Answer → print the decision for
// Claude Code. No answer in time → exit silently, so the normal dialog shows.
if (signal === 'permission-request') {
  const waitMs = Number(process.env.CLAUDE_TRAFFIC_LIGHT_ASK_MS || 55000);
  writeSession({ hostApp: detectHostApp(prevOnEntry?.hostApp), pid: claudePid(prevOnEntry?.claudePid) });
  // Nobody is listening for a request if the app is down: skip the 55s wait.
  if (waitMs > 0 && !appIsUp()) finish();
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  const id = `${HOST_TAG}-${sessionId}-${Date.now()}`;
  const reqFile = path.join(REQUESTS_DIR, `${id}.json`);
  const ansFile = path.join(REQUESTS_DIR, `${id}.answer`);
  const input = data?.tool_input || {};
  const summary = typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.url === 'string' ? input.url
    : Object.keys(input).length ? JSON.stringify(input) : '';
  fs.writeFileSync(reqFile, JSON.stringify({ id, sessionId, host: HOST_TAG, cwd, tool: data?.tool_name || 'tool', summary: summary.slice(0, 200), createdAt: new Date().toISOString() }, null, 2));
  const deadline = Date.now() + waitMs;
  let decision = null;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      decision = fs.readFileSync(ansFile, 'utf8').trim();
      break;
    } catch {
      Atomics.wait(sleeper, 0, 0, 150);
    }
  }
  fs.rmSync(reqFile, { force: true });
  fs.rmSync(ansFile, { force: true });
  hookOutput = Claude.answer(decision);
  finish();
}

// PreToolUse fires many times a second during a busy turn. Skip the write if
// nothing changed in the last second — the app polls anyway, and this keeps
// the fs.watch storm down. Subagent events carry bookkeeping it must never drop.
// `workingSince` marks when the current turn began (for the "working over N
// minutes" signal) and resets on each new prompt.
// Judged on the unlocked read: skipping is only ever safe, never a lost write.
if (prevOnEntry && resolved !== 'subagent-start' && resolved !== 'subagent-done') {
  const prev = prevOnEntry;
  const agentChurn = fromSubagent && stepOf(prev, new Date().toISOString()).bookkeeping;
  const last = Date.parse(agentChurn ? prev.agentsAt : prev.updatedAt);
  if ((agentChurn || (prev.signal === resolved && prev.tool === tool)) && Date.now() - last < 1000) finish();
}
// Outside the lock: the host-app and pid lookups can shell out to ps.
writeSession({ hostApp: detectHostApp(prevOnEntry?.hostApp), pid: claudePid(prevOnEntry?.claudePid) });
finish();
