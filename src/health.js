// Is everything Buddy depends on in place, and if not, what fixes it.
// runChecks(ctx) backs Preferences → Health, the buddy_health MCP tool and
// onboarding. Every input arrives through ctx (fs, paths, clocks, and what
// only a running app knows), so tests and the MCP server, which has no
// Electron, supply their own.
//
// A check is { id, label, status: 'ok'|'warn'|'fail'|'info', detail,
// fix?: an id in FIXES the app knows how to run safely, next?: what to do
// by hand }.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Claude = require('../adapters/claude-code.js');
const Codex = require('../adapters/codex.js');
const HermesActivity = require('../adapters/hermes-activity.js');
const Runtime = require('../adapters/runtime.js');
const { scrub, cleanJsonError } = require('./scrub.js');
const Brand = require('../brand.js');

const LAST_HOOK_FILE = 'last-hook.json';
// A session lock is held for one read-parse-write, and the next writer breaks
// it after SessionState.STALE_LOCK_MS (2 s). One still there well past that
// was left by a hook that died, and nothing has written that session since.
const STALE_LOCK_AGE_MS = 10000;
const DISK_FAIL_BYTES = 200 * 1024 * 1024;
const DISK_WARN_BYTES = 1024 * 1024 * 1024;

const FIXES = {
  'reinstall-hooks': 'Reinstall hooks',
  'enable-mcp': 'Enable Claude integration',
  'clear-stale-locks': 'Clear stale lock',
  'connect-codex': 'Configure Codex activity',
  'connect-hermes': 'Connect Hermes activity',
  'open-burst-console': 'Open Burst console',
};
// Claude Code reads hooks once, when a session starts.
const RESTART_SESSIONS = 'Then restart your Claude sessions.';
const DAY_MS = 24 * 3600000;

// Until an updater exists (item 1 plugs one in as ctx.updateStatus). An
// updater answers synchronously from its last check.
const notConfigured = () => ({ state: 'unknown', detail: 'not set up yet' });

const tilde = (p, home) => (home && p && (p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`)) ? `~${p.slice(home.length)}` : p);

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function bytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function readJson(fsImpl, file) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; }
}

// The app binary and hook script a hook command runs, whichever form
// installed it (adapters/runtime.js shellCommand).
function hookPaths(command) {
  const c = String(command || '');
  const script = (/"([^"]*[\\/]set-status\.js)"/.exec(c) || [])[1] || null;
  const exe = (/ELECTRON_RUN_AS_NODE=1 "([^"]+)"/.exec(c) || /^"([^"]*buddy-hook(?:\.cmd)?)"/.exec(c) || [])[1] || (/^node /.test(c) ? 'node' : null);
  return { script, exe };
}

function checkHooks(ctx) {
  // macOS runs an app opened straight from Downloads from a random read-only
  // copy; hooks pinned to that path break at the next launch.
  if (/\/AppTranslocation\//.test(ctx.runtime.execPath || '')) {
    return { status: 'fail', detail: 'Plexiform is running from a temporary copy macOS made of it, so hooks can\'t point at it.', next: `Move ${Brand.name} to Applications (drag it out of Downloads), then open it from there.` };
  }
  const file = Claude.configPath(ctx.home);
  let settings;
  try { settings = Runtime.readJsonConfig(file, ctx.fs); } catch (err) {
    return { status: 'fail', detail: `${tilde(file, ctx.home)} can't be read: ${cleanJsonError(err.message)}`, next: `Fix or remove the broken JSON in ${tilde(file, ctx.home)}, then reinstall hooks. Plexiform never writes over a file it can't parse.` };
  }
  const ours = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) for (const h of g.hooks || []) if (Claude.isOurs(h.command)) ours.push({ event, command: h.command });
  }
  const fix = 'reinstall-hooks';
  if (!ours.length) return { status: 'fail', detail: "Not installed, so Claude Code can't change the light.", fix, next: RESTART_SESSIONS };
  const wrapperOk = Runtime.wrapperPresent(ctx.runtime, {}, ctx.fs);
  const opts = { askFromWidget: !!ctx.askFromWidget, home: ctx.home };
  const current = wrapperOk && Claude.check(settings, ctx.runtime, opts);
  const want = hookPaths(Claude.commandFor('Stop', ctx.runtime));
  const differ = ours.map((o) => hookPaths(o.command)).filter((p) => p.script !== want.script || p.exe !== want.exe);
  const other = differ.find((p) => p.script !== want.script);
  if (other) {
    const exists = (p) => { try { return ctx.fs.existsSync(p); } catch { return false; } };
    const gone = (other.script && !exists(other.script)) || (other.exe && other.exe !== 'node' && !exists(other.exe));
    const where = tilde(other.script || other.exe || 'an unknown path', ctx.home);
    if (current) return { status: 'warn', detail: `Installed, but also registered from ${gone ? 'a copy that isn\'t there any more' : 'another copy'} (${where}).`, fix, next: RESTART_SESSIONS };
    return gone
      ? { status: 'fail', detail: `Points at a copy of Plexiform that was moved or deleted (${where}).`, fix, next: RESTART_SESSIONS }
      : { status: 'warn', detail: `Pointing at a different copy of Plexiform (${where}), not this one.`, fix, next: RESTART_SESSIONS };
  }
  // Same script, another command form (plain node, an older runner).
  if (differ.length) return { status: 'warn', detail: 'Installed in an older form.', fix, next: RESTART_SESSIONS };
  if (current) return { status: 'ok', detail: 'Installed, and pointing at this copy of Plexiform.' };
  if (!wrapperOk) return { status: 'fail', detail: `The hook runner ${tilde(Runtime.wrapperPath(ctx.runtime), ctx.home)} is missing.`, fix, next: RESTART_SESSIONS };
  // Every hook right, only the installer's deny rule (which keeps Claude's
  // file tools out of Buddy's data folder) gone.
  const rules = Claude.denyRulesFor(ctx.home, ctx.runtime);
  const withRules = { ...settings, permissions: { ...(settings.permissions || {}), deny: [...(Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : []), ...rules] } };
  if (Claude.check(withRules, ctx.runtime, opts)) return { status: 'warn', detail: "Installed, but without the rule that keeps Claude's file tools out of Plexiform's data folder.", fix, next: RESTART_SESSIONS };
  const missing = Claude.HOOK_EVENTS.map(([e]) => e).filter((e) => !ours.some((o) => o.event === e && o.command === Claude.commandFor(e, ctx.runtime)));
  return {
    status: 'warn',
    detail: missing.length ? `Out of date: no hook for ${missing.join(', ')}.` : 'The permission-prompt hook doesn\'t match "Answer permission prompts from the widget".',
    fix,
    next: RESTART_SESSIONS,
  };
}

// Found when the Hermes CLI is installed; connecting enables Plexiform's
// metadata-only observer plugin through Hermes' own CLI (adapters/hermes-activity.js).
function checkHermesActivity(ctx) {
  if (process.platform === 'win32' || !ctx.fs.existsSync(path.join(ctx.home, '.hermes')) || !(ctx.findHermes || HermesActivity.findBin)(ctx.home)) return null;
  if ((ctx.hermesConnected || HermesActivity.isInstalled)({ home: ctx.home })) return { status: 'ok', detail: 'Hermes session activity is connected.' };
  return { status: 'warn', detail: 'Hermes is installed but its session activity is not connected to Plexiform.', fix: 'connect-hermes', next: 'Start a new Hermes session after connecting.' };
}

function checkVersion(ctx) {
  const u = (ctx.updateStatus || notConfigured)() || notConfigured();
  const v = `Version ${ctx.version || 'unknown'}`;
  if (u.state === 'available') return { status: 'warn', detail: `${v}; ${u.version ? `${u.version} is available` : 'an update is available'}.`, next: u.detail || 'Quit Plexiform and install the update from the tray.' };
  if (u.state === 'current') return { status: 'ok', detail: `${v}, up to date.` };
  return { status: 'info', detail: `${v}. Updates: ${u.state === 'error' ? `couldn't check (${u.detail || 'unknown error'})` : u.detail || 'not set up yet'}.` };
}

// Configuration is distinct from Codex's own review/trust decision. Only
// accepted lifecycle events in our own session store establish observation;
// never inspect Codex chat history or infer that an open chat is working.
function checkCodexHooks(ctx) {
  if (!ctx.fs.existsSync(path.join(ctx.home, '.codex'))) return null;
  const next = 'Review and trust the Plexiform hooks in Codex, then start a new turn. Check this row again after activity.';
  if (!Codex.isActivityInstalled({ home: ctx.home, runtime: ctx.runtime, fs: ctx.fs })) {
    return { status: 'warn', detail: 'Codex session activity is not configured for this copy of Plexiform.', fix: 'connect-codex', next };
  }
  let at = 0;
  try {
    for (const s of scanSessions(ctx).datas) {
      const t = Date.parse(s.codexHookAt || '');
      if (s.source === 'codex' && s.codexLifecycle === 1 && Number.isFinite(t) && t <= ctx.now && t > at) at = t;
    }
  } catch { /* Session-file health reports unreadable storage separately. */ }
  if (!at) return { status: 'info', detail: 'Codex hooks are configured. No lifecycle event has been received yet.', next };
  const detail = `Codex hooks are configured. Last lifecycle event: ${ago(ctx.now - at)}.`;
  return ctx.now - at <= 5 * 60000 ? { status: 'ok', detail, at: new Date(at).toISOString() }
    : { status: 'info', detail, at: new Date(at).toISOString(), next: 'No recent activity is recorded. If Codex is working, check its hook review and start a new turn.' };
}

function checkMcp(ctx) {
  const m = ctx.mcp;
  if (!m) return { status: 'info', detail: 'Unknown.' };
  const where = tilde(m.path, ctx.home);
  if (m.error) return { status: 'fail', detail: `${where} can't be read: ${cleanJsonError(m.error)}`, next: `Plexiform never writes over a file it can't parse. Fix the JSON in ${where} (Claude Code rewrites it on its next start).` };
  if (m.installed && m.current) return { status: 'ok', detail: ctx.mcpConnected ? 'Registered, and this answer came through it.' : `Registered in ${where}; new Claude Code sessions can ask Plexiform what it's showing.` };
  if (m.installed) return { status: 'warn', detail: 'Registered, but pointing at an older copy of Plexiform.', fix: 'enable-mcp', next: RESTART_SESSIONS };
  return { status: 'warn', detail: 'Off: Claude can\'t ask Plexiform "why is my light amber?".', fix: 'enable-mcp', next: RESTART_SESSIONS };
}

// ctx.signal: { listening, port, error } from the app, or { running: false }
// when the MCP server found nothing answering.
function checkSignal(ctx) {
  const s = ctx.signal || {};
  const port = s.port || 47172;
  if (s.listening) return { status: 'ok', detail: `Other tools on this Mac can reach Plexiform (port ${port}).` };
  if (s.running === false) return { status: 'fail', detail: `Plexiform isn't answering on this Mac (port ${port}): it isn't running, or another program holds its port.`, next: `Open ${Brand.name}. If it is open, quit any other copy (Activity Monitor), then quit and reopen it.` };
  // Hooks write session files directly, so the light keeps working; what
  // breaks is /signal, other agents' HTTP hooks and live status for MCP.
  const why = s.error === 'EADDRINUSE' ? `Another program is using its port (${port})` : `It couldn't start (${s.error || 'unknown reason'})`;
  return { status: 'warn', detail: `${why}, so other tools can't reach Plexiform.`, next: 'Claude Code still works. Quit any other copy of Plexiform, then reopen this one.' };
}

// A lock, or a lock a waiter renamed aside to break it and then died.
const isLockFile = (n) => n.endsWith('.json.lock') || /\.json\.lock\..+\.stale$/.test(n);

function scanSessions(ctx) {
  const dir = path.join(ctx.root, 'sessions');
  const names = ctx.fs.readdirSync(dir);
  const json = names.filter((n) => n.endsWith('.json'));
  const unreadable = [];
  const datas = [];
  for (const n of json) {
    const d = readJson(ctx.fs, path.join(dir, n));
    if (d && typeof d === 'object') datas.push(d); else unreadable.push(n);
  }
  const staleLocks = names.filter(isLockFile).filter((n) => {
    try { return ctx.now - ctx.fs.statSync(path.join(dir, n)).mtimeMs > STALE_LOCK_AGE_MS; } catch { return false; }
  });
  return { dir, json, datas, unreadable, staleLocks };
}

function checkSessions(ctx) {
  const dir = path.join(ctx.root, 'sessions');
  let scan;
  try { scan = scanSessions(ctx); } catch (err) {
    return { status: 'fail', detail: `${tilde(dir, ctx.home)} can't be read (${err.code || err.message}).`, next: err.code === 'ENOENT' ? 'Quit and reopen Plexiform: it creates the folder when it starts.' : 'Check the folder\'s permissions: every hook writes its session there.' };
  }
  try { ctx.fs.accessSync(dir, fs.constants.W_OK); } catch {
    return { status: 'fail', detail: `${tilde(dir, ctx.home)} isn't writable, so hooks can't record anything.`, next: 'Check the folder\'s permissions (it should belong to you).' };
  }
  const bits = [];
  if (scan.staleLocks.length) bits.push(`${plural(scan.staleLocks.length, 'stale lock')} left by a hook that stopped mid-write`);
  if (scan.unreadable.length) bits.push(`${plural(scan.unreadable.length, 'unreadable session file')}`);
  if (scan.staleLocks.length) return { status: 'warn', detail: `${bits.join('; ')}.`, fix: 'clear-stale-locks', fixLabel: scan.staleLocks.length === 1 ? 'Clear stale lock' : 'Clear stale locks' };
  if (scan.unreadable.length) return { status: 'warn', detail: `${bits.join('; ')}.`, next: "Each is rewritten on that session's next event, or swept within a day." };
  return { status: 'ok', detail: `${plural(scan.json.length, 'session file')}, all readable.` };
}

// Hooks stamp updatedAt when a session moves and agentsAt for bookkeeping;
// the app's own merges keep both, so they are the hook's clock.
function newestHookAt(datas) {
  let best = null;
  for (const d of datas || []) {
    if (!d) continue;
    const at = Math.max(Date.parse(d.updatedAt || '') || 0, Date.parse(d.agentsAt || '') || 0);
    if (at && (!best || at > best.at)) best = { at, source: d.source || 'claude' };
  }
  return best;
}

// The newest hook event on record: the live session files, or, once every
// session has ended (SessionEnd deletes its file), what the app last saved.
function lastHookEvent(ctx) {
  ctx = { fs, ...ctx };
  let live = null;
  try { live = newestHookAt(scanSessions(ctx).datas); } catch { /* no sessions folder */ }
  const saved = readJson(ctx.fs, path.join(ctx.root, LAST_HOOK_FILE));
  const savedAt = saved ? Date.parse(saved.at || '') : NaN;
  const kept = Number.isFinite(savedAt) ? { at: savedAt, source: saved.source || 'claude' } : null;
  return !live ? kept : !kept || live.at >= kept.at ? live : kept;
}

// For "no hook event in the last N seconds": which check most likely explains it.
function likelyCause(checks) {
  const by = (id) => (checks || []).find((c) => c.id === id);
  const hooks = by('hooks');
  if (hooks && hooks.status !== 'ok') return `Hooks: ${hooks.detail}`;
  const sessions = by('sessions');
  if (sessions && sessions.status === 'fail') return `Session folder: ${sessions.detail}`;
  return 'The hooks are in place but no session has run them. A Claude Code session opened before they were installed keeps its old settings: restart it (/exit, then claude) and send a prompt.';
}

function checkLastHook(ctx, prior) {
  const ev = lastHookEvent(ctx);
  const hooksOk = (prior.find((c) => c.id === 'hooks') || {}).status === 'ok';
  if (!ev) {
    return ctx.hookWithinMs
      ? { status: 'fail', detail: 'None received.', next: likelyCause(prior) }
      : { status: 'warn', detail: 'None recorded yet.', next: hooksOk ? 'Start a Claude Code session, or restart one opened before the hooks were installed.' : 'Fix the hooks first.' };
  }
  const age = ctx.now - ev.at;
  const at = new Date(ev.at).toISOString();
  const detail = `${ago(age).replace(/^./, (c) => c.toUpperCase())}${ev.source === 'claude' ? '' : ` (${ev.source})`}.`;
  if (ctx.hookWithinMs && age > ctx.hookWithinMs) return { status: 'fail', detail, at, next: likelyCause(prior) };
  // An old event says nothing about hooks that were broken since.
  if (!hooksOk) return { status: 'info', detail, at, next: 'Fix the hooks first.' };
  if (age > DAY_MS) return { status: 'warn', detail, at, next: 'Nothing for a day. If a Claude session ran since, check the hooks.' };
  return { status: 'ok', detail, at };
}

function checkTranscripts(ctx) {
  const dir = ctx.projectsDir || path.join(ctx.home, '.claude', 'projects');
  const where = tilde(dir, ctx.home);
  const empty = { status: 'warn', detail: `No transcripts in ${where} yet.`, next: 'Spend and model mix stay empty until Claude Code has run on this machine.' };
  let entries;
  try { entries = ctx.fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (err) {
    if (err.code === 'ENOENT') return empty;
    return { status: 'fail', detail: `${where} can't be read (${err.code || err.message}).`, next: 'Check the folder\'s permissions: spend and model mix read the transcripts there.' };
  }
  if (!entries.length) return empty;
  // Opening (not reading) the newest transcript proves access without
  // touching anything anyone wrote in it.
  let newest = null;
  for (const e of entries) {
    try { const t = ctx.fs.statSync(path.join(dir, e.name)).mtimeMs; if (!newest || t > newest.t) newest = { name: e.name, t }; } catch { /* vanished */ }
  }
  if (newest) {
    const pdir = path.join(dir, newest.name);
    try {
      const f = ctx.fs.readdirSync(pdir).find((n) => n.endsWith('.jsonl'));
      if (f) ctx.fs.closeSync(ctx.fs.openSync(path.join(pdir, f), 'r'));
    } catch (err) {
      return { status: 'fail', detail: `Transcripts in ${where} can't be opened (${err.code || err.message}).`, next: 'Check the folder\'s permissions: spend and model mix read the transcripts there.' };
    }
  }
  return { status: 'ok', detail: `${plural(entries.length, 'project folder')}, readable.` };
}

function checkDisk(ctx) {
  const statfs = ctx.statfs || ((p) => fs.statfsSync(p));
  let s;
  try { s = statfs(ctx.root); } catch { try { s = statfs(ctx.home); } catch (err) { return { status: 'info', detail: `Unknown (${err.code || err.message}).` }; } }
  const free = Number(s.bavail) * Number(s.bsize);
  const detail = `${bytes(free)} free.`;
  if (free < DISK_FAIL_BYTES) return { status: 'fail', detail: `Only ${detail}`, next: 'Free up disk space: session files and the log need it.' };
  if (free < DISK_WARN_BYTES) return { status: 'warn', detail: `Only ${detail}`, next: 'Free up some disk space soon.' };
  return { status: 'ok', detail };
}

// ctx.burst is the Burst status view model (burst-view.js statusView); only
// macOS with Burst installed gets a row. Trust is the version+pid handshake
// burst-client does before it reads anything.
function checkBurst(ctx) {
  const v = ctx.burst;
  if ((ctx.platform || process.platform) !== 'darwin' || !v || v.kind === 'unsupported' || v.kind === 'not_installed') return null;
  if (v.kind === 'untrusted') return { status: 'fail', detail: 'Whatever answers on Burst\'s port is not your Burst install, so Plexiform reads nothing from it.', next: 'Open the Burst console to check it, or turn Burst off.', fix: 'open-burst-console' };
  if (v.kind === 'off' && !v.version) return { status: 'info', detail: 'Burst is installed but not answering, so its trust can\'t be checked.' };
  return { status: 'ok', detail: 'Burst answered and is your install.' };
}

const CHECKS = [
  ['hooks', 'Claude Code hooks', checkHooks],
  ['codex-hooks', 'Codex session activity', checkCodexHooks],
  ['hermes-activity', 'Hermes session activity', checkHermesActivity],
  ['sessions', 'Session files', checkSessions],
  ['last-hook', 'Last hook event', checkLastHook],
  ['signal', "Plexiform's local connection", checkSignal],
  ['mcp', 'Claude integration (MCP)', checkMcp],
  ['transcripts', 'Transcripts', checkTranscripts],
  ['disk', 'Disk space', checkDisk],
  ['burst', 'Burst trusted', checkBurst],
  ['version', 'App version', checkVersion],
];

// ctx: { now, home, root, projectsDir, fs, statfs, runtime, askFromWidget,
//        version, updateStatus, mcp, mcpConnected, signal, hookWithinMs }
function runChecks(ctx = {}) {
  const home = ctx.home || os.homedir();
  const c = { fs, now: Date.now(), ...ctx, home, root: ctx.root || path.join(home, '.claude-traffic-light') };
  const checks = [];
  for (const [id, label, fn] of CHECKS) {
    let r;
    try { r = fn(c, checks); } catch (err) { r = { status: 'info', detail: `Couldn't check (${err.message}).` }; }
    if (!r) continue;
    const out = { id, label, ...r };
    if (out.fix && !out.fixLabel) out.fixLabel = FIXES[out.fix];
    checks.push(out);
  }
  const problems = checks.filter((x) => x.status === 'fail' || x.status === 'warn').length;
  return { at: new Date(c.now).toISOString(), ok: !checks.some((x) => x.status === 'fail'), problems, version: c.version || null, checks };
}

// Removes session locks still stale now. The rename-aside and inode check
// mirror hooks/session-state.js breakIfStale: a lock a live writer took in
// the meantime is put back, never deleted.
function clearStaleLocks(ctx) {
  const c = { fs, now: Date.now(), ...ctx };
  const dir = path.join(c.root, 'sessions');
  const removed = [];
  let names = [];
  try { names = c.fs.readdirSync(dir).filter(isLockFile); } catch { return removed; }
  for (const n of names) {
    const lock = path.join(dir, n);
    let seen;
    try { seen = c.fs.statSync(lock); } catch { continue; }
    if (c.now - seen.mtimeMs <= STALE_LOCK_AGE_MS) continue;
    // An aside file is nobody's lock any more: nothing can take its name.
    if (!n.endsWith('.json.lock')) {
      try { c.fs.rmSync(lock, { force: true }); removed.push(n); } catch { /* gone */ }
      continue;
    }
    const aside = `${lock}.health.stale`;
    try { c.fs.renameSync(lock, aside); } catch { continue; }
    try {
      if (c.fs.statSync(aside).ino !== seen.ino) c.fs.linkSync(aside, lock);
      else removed.push(n);
    } catch { /* a newer lock took the name; it stands */ }
    c.fs.rmSync(aside, { force: true });
  }
  return removed;
}

// app.log lines worth sending: startup, warnings and errors, with the stack
// lines that follow them. Never [state] lines (they name projects) or
// anything else a session wrote.
const LOG_PICK = /^\S+ \[(?:warn|error)\]|^\S+ \[log\] \[(?:startup|watchdog|hooks|mcp|signal server)\]/;
// Voice lines can carry what was said, on the line and in the stack or
// message lines after it: the tag stays, the words and those lines don't.
const VOICE_LINE = /^\S+ \[(?:log|warn|error)\]\s+(?:Error:\s*)?(?:\[voice\]|voice:)/i;
function logExcerpt(text, limit = 40) {
  const out = [];
  let keep = false;
  let voice = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\d{4}-\d\d-\d\dT/.test(line)) {
      keep = LOG_PICK.test(line);
      voice = VOICE_LINE.test(line);
      if (keep && voice) { out.push(`${line.slice(0, line.indexOf(']') + 1)} [voice] (message omitted)`); continue; }
    }
    if (!keep || voice || !line.trim()) continue;
    // Newer Node quotes the input a JSON.parse choked on, which may be anything.
    out.push(cleanJsonError(line).replace(/(is not valid JSON).*$/, '$1'));
  }
  return out.slice(-limit);
}

const MARK = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', info: 'info' };

// The Copy diagnostics text: checks, versions, OS and recent log lines,
// scrubbed. `scrubWith` is passed straight to scrub().
function diagnostics({ report, versions = {}, platform = {}, logText = '', scrubWith = {} }) {
  const lines = [
    `${Brand.name} diagnostics`,
    `Generated ${report.at}`,
    `${Brand.name} ${report.version || 'unknown'}${platform.packaged === false ? ' (dev run)' : ''} · Electron ${versions.electron || '?'} · Chrome ${versions.chrome || '?'} · Node ${versions.node || '?'}`,
    `OS ${platform.os || '?'} ${platform.release || ''} ${platform.arch || ''}`.trim(),
    '',
    `Checks: ${report.problems ? plural(report.problems, 'problem') : 'all fine'}`,
  ];
  for (const x of report.checks) {
    lines.push(`[${MARK[x.status] || x.status}] ${x.label}: ${x.detail}`);
    if (x.status !== 'ok' && x.next) lines.push(`       next: ${x.next}`);
  }
  const log = logExcerpt(logText);
  lines.push('', `Recent log (startup, warnings, errors): ${log.length ? '' : 'none'}`.trim(), ...log);
  // Scrubbed whole, then shortened: a cut first could split a quoted secret
  // or path so no pattern recognised it.
  return `${scrub(lines.join('\n'), scrubWith).split('\n').map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)).join('\n')}\n`;
}

module.exports = {
  FIXES, LAST_HOOK_FILE, STALE_LOCK_AGE_MS,
  runChecks, likelyCause, clearStaleLocks, newestHookAt, lastHookEvent, notConfigured, hookPaths, logExcerpt, diagnostics, ago,
  checkHooks, checkCodexHooks, checkVersion, checkMcp, checkSignal, checkSessions, checkLastHook, checkTranscripts, checkDisk,
};
