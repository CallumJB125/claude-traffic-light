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
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const HOST_TAG = os.hostname().split('.')[0];

const KNOWN = ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'subagent-start', 'subagent-done', 'permission-denied', 'turn-failed', 'stop', 'session-start', 'compact', 'notification', 'session-end', 'task-created', 'task-done', 'permission-request'];
const REQUESTS_DIR = path.join(ROOT_DIR, 'requests');
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

const sessionId = (data && (data.session_id || data.sessionId)) || process.env.CLAUDE_SESSION_ID || 'unknown';
const cwd = (data && data.cwd) || process.cwd();
const file = path.join(SESSIONS_DIR, `${HOST_TAG}-${sessionId}.json`);
// delegate.js keeps {reads, trims, at} per session here (same file naming).
const delegatedFile = path.join(ROOT_DIR, 'router', 'delegated', `${String(sessionId).replace(/[^\w.-]/g, '_').slice(0, 120)}.json`);

if (signal === 'session-end') {
  fs.rmSync(file, { force: true });
  fs.rmSync(delegatedFile, { force: true });
  process.exit(0);
}

function readDelegated(prevValue) {
  try {
    const c = JSON.parse(fs.readFileSync(delegatedFile, 'utf8'));
    if (!c.reads && !c.trims) return prevValue;
    return { reads: Number(c.reads) || 0, trims: Number(c.trims) || 0, at: c.at || null };
  } catch {
    return prevValue;
  }
}

const tool = (data && (data.tool_name || data.toolName)) || null;

// Claude Code tags each Notification with notification_type. Types not listed
// here (auth_success, elicitation_complete, …) are bookkeeping and leave the
// session's signal alone.
const NOTIFICATION_TYPES = {
  permission_prompt: 'permission-ask',
  elicitation_dialog: 'permission-ask',
  elicitation_url_dialog: 'permission-ask',
  idle_prompt: 'idle-nudge',
};
let resolved = signal;
// How this write came about — main.js quotes it in its transition log.
let via = signal;
// What kind of ask a permission-ask is: 'request' (the blocking
// PermissionRequest hook), 'question' (AskUserQuestion) or 'notification'.
// Only a notification ask can be a transient one the widget should sit out.
let askKind = null;
if (signal === 'notification') {
  // A usage limit is spotted by its text whatever the type; older Claude Code
  // sends no type at all, so the message text is the fallback there.
  const text = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
  const type = typeof data?.notification_type === 'string' ? data.notification_type : null;
  via = `notification/${type || 'regex'}`;
  if (/usage limit|rate limit|out of tokens|reached your (5-hour|weekly) limit|quota exceeded/.test(text)) resolved = 'limit-hit';
  else if (type) resolved = NOTIFICATION_TYPES[type] || null;
  else if (/permission|approve|allow|confirm/.test(text)) resolved = 'permission-ask';
  else resolved = 'idle-nudge';
  if (!resolved) process.exit(0);
  if (resolved === 'permission-ask') askKind = 'notification';
}
// The widget shows a PermissionRequest the same way as a Notification ask.
if (signal === 'permission-request') { resolved = 'permission-ask'; askKind = 'request'; }
// AskUserQuestion blocks on the person until its PostToolUse, so it is an ask,
// not work.
if (signal === 'tool-use' && tool === 'AskUserQuestion') { resolved = 'permission-ask'; askKind = 'question'; via = 'tool-use/AskUserQuestion'; }

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
    if (a.kind && a.kind !== 'subagent') return true; // owned by the watcher
    return a.status === 'done' ? now - t < DONE_KEEP_MS : now - t < AGENT_MAX_MS;
  });
  // Not on `stop`: a foreground Agent call blocks the turn, so a turn can only
  // end while *background* agents are still running. They end via SubagentStop.
  if (signal === 'session-start') {
    return agents.map((a) => (a.kind === 'subagent' && a.status !== 'done' ? { ...a, status: 'done' } : a));
  }
  if (signal !== 'subagent-start' && signal !== 'subagent-done') return agents;
  const p = payload || {};
  const id = String(p.agent_id || p.agentId || p.subagent_id || p.task_id || `agent-${now}`);
  // 'oh-my-claudecode:executor' is 'executor' on a 12px chip.
  const name = String(p.agent_type || p.subagent_type || p.agentType || p.agent_name || p.description || 'agent').split(':').pop().slice(0, 40);
  const status = signal === 'subagent-done' ? 'done' : 'working';
  const existing = agents.find((a) => a.id === id);
  if (existing) agents = agents.map((a) => (a.id === id ? { ...a, name: a.name || name, status, since: status === 'done' ? nowIso : a.since } : a));
  else agents = agents.concat([{ id, name, kind: 'subagent', status, since: nowIso, parent: sessionId }]);
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

// The router shim exports CLAUDE_TRAFFIC_LIGHT_ROUTE="<model>|<reason>" before
// it execs claude, and every hook process inherits claude's environment.
function envRoute() {
  const v = process.env.CLAUDE_TRAFFIC_LIGHT_ROUTE;
  if (!v) return null;
  const i = v.indexOf('|');
  const model = (i < 0 ? v : v.slice(0, i)).trim();
  if (!['opus', 'sonnet', 'haiku'].includes(model)) return null;
  return { model, reason: i < 0 ? '' : v.slice(i + 1).slice(0, 200) };
}

const TURN_END = new Set(['stop', 'idle-nudge', 'permission-ask', 'limit-hit', 'session-start', 'turn-failed', 'permission-denied']);
const prev = readPrev();
const turnOver = !!prev && TURN_END.has(prev.signal);
// A background subagent's own tool hooks carry its agent_id.
const fromSubagent = /^tool-/.test(resolved) && !!(data && data.agent_id);
const isTask = resolved === 'task-created' || resolved === 'task-done';
// Task events are always bookkeeping. Once the turn is over, so is anything a
// background agent does — it must not look like the turn restarted.
const bookkeeping = isTask || (turnOver && (resolved === 'subagent-start' || resolved === 'subagent-done' || fromSubagent));

function writeSession() {
  const now = new Date().toISOString();
  const workingSince = turnOver && bookkeeping ? (prev.workingSince ?? null)
    : resolved === 'prompt-submit' ? now : TURN_END.has(resolved) ? null : (prev?.workingSince || now);
  // Task progress for the current turn: created/done counts, reset per prompt.
  let tasks = resolved === 'prompt-submit' ? { created: 0, done: 0 } : (prev?.tasks || { created: 0, done: 0 });
  if (resolved === 'task-created') tasks = { ...tasks, created: tasks.created + 1 };
  if (resolved === 'task-done') tasks = { ...tasks, done: Math.min(tasks.created, tasks.done + 1) };
  const signalOut = bookkeeping ? (prev?.signal || 'tool-use') : resolved;
  const changed = signalOut !== (prev?.signal ?? null);
  // A permission notification after the turn ended has no tool call of the
  // main thread behind it (a background agent's, or a stale prompt) — tag it
  // so the app's log shows it.
  const viaOut = bookkeeping ? (prev?.via ?? null)
    : askKind === 'notification' && (prev?.signal === 'stop' || prev?.signal === 'idle-nudge') ? `${via} after-stop` : via;
  const agents = updateAgents(prev?.agents, resolved, data, now);
  const hostApp = detectHostApp(prev?.hostApp);
  // Write-then-rename so the app's poller never reads a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      sessionId, host: HOST_TAG, hostApp, cwd, signal: signalOut,
      tool: signalOut === resolved ? tool : (prev?.tool ?? null),
      // What the session showed before this signal, and since when this one
      // has held — the app shows a young notification ask as prevSignal.
      prevSignal: changed ? (prev?.signal ?? null) : (prev?.prevSignal ?? null),
      signalSince: changed ? now : (prev?.signalSince || prev?.updatedAt || now),
      askKind: bookkeeping ? (prev?.askKind ?? null) : askKind,
      via: viaOut,
      workingSince, tasks, agents,
      // Execution mode and ralph iteration are owned by the app's OMC watcher;
      // carry them through so a hook write never erases them.
      mode: prev?.mode ?? null,
      iteration: prev?.iteration ?? 0,
      // The router's pick for this session; `escalated` is set by the app
      // when the transcript shows you switched up from it.
      route: envRoute() || prev?.route || undefined,
      escalated: prev?.escalated || undefined,
      // What delegate.js kept out of this session's context so far.
      delegated: readDelegated(prev?.delegated || undefined),
      // updatedAt means "the session last moved" (ignored-N timers, last-touch
      // guard); bookkeeping must not bump it, so it stamps agentsAt instead.
      updatedAt: bookkeeping && prev?.updatedAt ? prev.updatedAt : now,
      agentsAt: bookkeeping ? now : (prev?.agentsAt ?? null),
    }, null, 2)
  );
  fs.renameSync(tmp, file);
}

// ── PermissionRequest: a BLOCKING hook. Write the request where the widget
// can see it, then wait for an answer file. Answer → print the decision for
// Claude Code. No answer in time → exit silently, so the normal dialog shows.
if (signal === 'permission-request') {
  writeSession();
  const waitMs = Number(process.env.CLAUDE_TRAFFIC_LIGHT_ASK_MS || 55000);
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
  if (decision === 'allow' || decision === 'deny') {
    const out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from the Claude Traffic Light widget' } } };
    process.stdout.write(JSON.stringify(out));
  }
  process.exit(0);
}

// PreToolUse fires many times a second during a busy turn. Skip the write if
// nothing changed in the last second — the app polls anyway, and this keeps
// the fs.watch storm down. Subagent events carry bookkeeping it must never drop.
// `workingSince` marks when the current turn began (for the "working over N
// minutes" signal) and resets on each new prompt.
if (prev && resolved !== 'subagent-start' && resolved !== 'subagent-done') {
  const agentChurn = bookkeeping && fromSubagent;
  const last = Date.parse(agentChurn ? prev.agentsAt : prev.updatedAt);
  if ((agentChurn || (prev.signal === resolved && prev.tool === tool)) && Date.now() - last < 1000) process.exit(0);
}
writeSession();
