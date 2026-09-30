#!/usr/bin/env node
// Reporter mode: this machine's agent sessions show on a Buddy running on
// another machine. The hooks are the usual ones (emit.js); once this machine
// is paired they also hand each event to a detached sender, which signs it
// with this device's key and posts it to the desktop's device listener. See
// docs/remote-reporter.md.
//
//   node hooks/remote.js pair <url | unix:/path/to.sock> [--force] [--no-hooks]
//                                          paste the pairing code when asked;
//                                          saves remote.json, installs the hooks
//   node hooks/remote.js status            what is paired, and whether it answers
//   node hooks/remote.js heartbeat [--every <s>]
//                                          report the sessions still running here
//                                          (once, or every <s> seconds)
//   node hooks/remote.js unpair            forget the pairing, remove the hooks
//
// <url> is where the desktop's device port is reachable from here:
// http://127.0.0.1:<port> at the end of an `ssh -R` tunnel to the desktop's
// device port (47173), unix:<socket> for a tunnel to a socket, or
// http://<desktop tailnet address>:47173.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Protocol = require('./remote-protocol.js');
const Transport = require('./transport.js');
const SessionState = require('./session-state.js');

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const HOST_TAG = os.hostname().split('.')[0];
const CONFIG_FILE = 'remote.json';
const STATE_FILE = 'remote-state.json';
// After a send goes unanswered (not refused), hooks skip sending for this
// long: an unreachable address costs the sender a whole timeout, and a busy
// turn fires hooks several times a second.
const BACKOFF_MS = 30000;
// The reporter's own session files, once nothing has touched them for this
// long and their agent is gone, are the heartbeat's to delete.
const SWEEP_AFTER_MS = 24 * 3600 * 1000;

const configPath = (rootDir = ROOT_DIR) => path.join(rootDir, CONFIG_FILE);
const isPaired = (rootDir = ROOT_DIR) => fs.existsSync(configPath(rootDir));

function loadConfig(rootDir = ROOT_DIR) {
  try { return Transport.validate(JSON.parse(fs.readFileSync(configPath(rootDir), 'utf8'))); } catch { return null; }
}

function saveConfig(rootDir, config) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const file = configPath(rootDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

function backingOff(rootDir = ROOT_DIR, now = Date.now()) {
  try { return now < Number(JSON.parse(fs.readFileSync(path.join(rootDir, STATE_FILE), 'utf8')).downUntil); } catch { return false; }
}

function noteResult(rootDir, r, now = Date.now()) {
  const file = path.join(rootDir, STATE_FILE);
  try {
    // A refusal (401, 400) means the desktop is up; only silence backs off.
    if (!r.status) fs.writeFileSync(file, JSON.stringify({ downUntil: now + BACKOFF_MS, error: r.error || null }));
    else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch { /* best effort */ }
}

// The next per-session sequence number: ms-based so it survives a lost local
// file, and at least one past the last so two events in a millisecond still
// order. The desktop drops anything not newer than what it has.
const nextSeq = (prevSeq, now = Date.now()) => Math.max(now, (Number.isSafeInteger(prevSeq) ? prevSeq : 0) + 1);

// A normalized adapter event → what leaves the machine. The raw hook payload
// never does (prompts, tool inputs, transcript paths): only the signal, the
// tool's name and the folder, which the desktop shows and never opens.
function wireEvent(source, e) {
  const extra = e.extra && typeof e.extra === 'object' ? e.extra : {};
  return {
    source,
    sessionId: SessionState.safeSessionId(e.sessionId),
    seq: e.seq,
    signal: e.signal,
    tool: typeof e.tool === 'string' ? e.tool.slice(0, 80) : null,
    cwd: typeof e.cwd === 'string' ? e.cwd.slice(0, 500) : '',
    askKind: typeof extra.askKind === 'string' ? extra.askKind : null,
    via: typeof extra.via === 'string' ? extra.via.slice(0, 60) : null,
    fromSubagent: extra.fromSubagent === true,
  };
}

async function send(kind, fields, { rootDir = ROOT_DIR, ignoreBackoff = false } = {}) {
  const config = loadConfig(rootDir);
  if (!config) return { ok: false, skipped: 'not paired' };
  if (!ignoreBackoff && backingOff(rootDir)) return { ok: false, skipped: 'desktop unreachable, backing off' };
  const r = await Transport.create(config).send(Protocol.envelope(kind, config.device, fields));
  noteResult(rootDir, r);
  return r;
}

// For a hook: hand the events to a detached sender and exit 0 at once, so no
// hook ever waits on the network. The sender outlives the hook; the desktop
// orders what arrives by seq.
function dispatchThenExit(source, events, { rootDir = ROOT_DIR } = {}) {
  const list = events.filter((e) => e && e.sessionId && Protocol.validSeq(e.seq)).slice(0, Protocol.MAX_EVENTS).map((e) => wireEvent(source, e));
  if (!list.length || !loadConfig(rootDir) || backingOff(rootDir)) process.exit(0);
  const exit = () => process.exit(0);
  setTimeout(exit, 250);
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [__filename, '__send'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: rootDir } });
    child.on('error', exit);
    child.unref();
    // The whole envelope fits a pipe buffer, so this lands at once.
    child.stdin.end(JSON.stringify({ kind: 'session', fields: { events: list } }), exit);
  } catch { exit(); }
}

// The detached half: read the job, send it, record whether the desktop
// answered. Always exits.
function senderMain() {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { if (text.length < Protocol.MAX_BODY_BYTES) text += c; });
  process.stdin.on('end', async () => {
    try {
      const job = JSON.parse(text);
      if (job && job.kind === 'session' && job.fields && Array.isArray(job.fields.events)) await send('session', { events: job.fields.events });
    } catch { /* nothing to send */ }
    process.exit(0);
  });
}

// The agent process a hook runs under, for the heartbeat's liveness check
// (the desktop can't check a pid on this machine). Hook commands may run
// through a shell, so shells are skipped. One `ps` for the whole walk, and
// none when the parent is the pid already on file.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
function agentPid(cached, ppid = process.ppid, psOutput = null) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  if (!ppid || ppid <= 1) return null;
  if (cached === ppid) return ppid;
  let out = psOutput;
  if (out === null) {
    try { out = require('child_process').execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 500, maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
  }
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  let pid = ppid;
  for (let depth = 0; depth < 3 && pid > 1; depth += 1) {
    const p = procs.get(pid);
    if (!p) return null;
    if (!SHELLS.has((p.comm.split('/').pop() || '').replace(/^-/, ''))) return pid;
    pid = p.ppid;
  }
  return null;
}

// What the heartbeat says about each session still running here: enough to
// rebuild it on a desktop that missed events (asleep, tunnel down, restarted).
// Only files this reporter wrote (they carry remoteSeq) and whose agent
// process is alive; a session with no recorded pid can't be vouched for.
// Old ones whose agent is gone are swept on the way.
function liveSessions(rootDir = ROOT_DIR, now = Date.now()) {
  const dir = path.join(rootDir, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(dir, f);
    const s = SessionState.readJson(file);
    if (!s || s.host !== HOST_TAG || !Protocol.validSeq(s.remoteSeq)) continue;
    const alive = Number(s.claudePid) > 1 && !SessionState.processGone(s, HOST_TAG);
    if (!alive) {
      try { if (now - fs.statSync(file).mtimeMs > SWEEP_AFTER_MS) fs.rmSync(file, { force: true }); } catch { /* gone already */ }
      continue;
    }
    if (out.length >= Protocol.MAX_HEARTBEAT_SESSIONS || !s.signal) continue;
    const source = String(s.source || 'claude');
    out.push({ source: Protocol.SOURCE.test(source) ? source : 'custom', sessionId: SessionState.safeSessionId(s.sessionId), seq: s.remoteSeq, signal: s.signal, tool: typeof s.tool === 'string' ? s.tool.slice(0, 80) : null, cwd: typeof s.cwd === 'string' ? s.cwd.slice(0, 500) : '', updatedAt: s.updatedAt || null });
  }
  return out;
}

const heartbeat = (opts = {}) => send('heartbeat', { sessions: liveSessions(opts.rootDir) }, { ...opts, ignoreBackoff: true });

// ── Hooks in reporter mode ──────────────────────────────────────────────────
// Claude Code's events run emit.js through the Claude adapter, which writes
// the local session file (for the heartbeat) and dispatches. Only these
// entries are ever added or stripped: set-status.js belongs to a Buddy app on
// this machine, which pairing refuses to sit beside unless forced.
function reporterHooks() {
  const Claude = require('../adapters/claude-code.js');
  const Runtime = require('../adapters/runtime.js');
  const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && / --adapter claude /.test(String(command));
  function apply(settings, runtime) {
    const out = { ...(settings || {}) };
    out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
    for (const [event] of Claude.HOOK_EVENTS) {
      const command = Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'claude', event]);
      out.hooks[event] = (out.hooks[event] || []).concat([{ matcher: '', hooks: [{ type: 'command', command }] }]);
    }
    return out;
  }
  function strip(settings) {
    const out = { ...(settings || {}) };
    out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
    if (!Object.keys(out.hooks).length) delete out.hooks;
    return out;
  }
  return { apply, strip, isOurs, Claude, Runtime };
}

function installHooks({ home = os.homedir(), rootDir = ROOT_DIR } = {}) {
  const { apply, Claude, Runtime } = reporterHooks();
  const runtime = Runtime.make({ execPath: null, hooksDir: __dirname, dataDir: rootDir });
  const file = Claude.configPath(home);
  Runtime.writeJsonConfig(file, apply(Runtime.readJsonConfig(file), runtime));
  return file;
}

function uninstallHooks({ home = os.homedir() } = {}) {
  const { strip, Claude, Runtime } = reporterHooks();
  const file = Claude.configPath(home);
  const cur = Runtime.readJsonConfig(file);
  if (cur.hooks) Runtime.writeJsonConfig(file, strip(cur));
  return file;
}

// A Buddy app on this machine: its port or token file, or its set-status.js
// hooks in Claude Code's settings. Its sessions already show on this
// machine's own widget; reporting them elsewhere too is opt-in (--force).
function localBuddy({ home = os.homedir(), rootDir = ROOT_DIR } = {}) {
  if (fs.existsSync(path.join(rootDir, 'port')) || fs.existsSync(path.join(rootDir, 'token'))) return 'a Buddy app is running here (its port file exists)';
  try {
    const { Claude, Runtime } = reporterHooks();
    const hooks = Runtime.readJsonConfig(Claude.configPath(home)).hooks || {};
    if (Object.values(hooks).some((groups) => (Array.isArray(groups) ? groups : []).some((g) => (g.hooks || []).some((h) => Claude.isOurs(h.command))))) return `Buddy's own hooks are installed in ${Claude.configPath(home)}`;
  } catch { /* unreadable settings: nothing to detect */ }
  return null;
}

// Plain http to a Tailscale address is only private if this machine is on
// the tailnet too; otherwise it would cross whatever network is there.
const hasTailnetAddress = (ifaces = os.networkInterfaces()) => Object.values(ifaces).some((addrs) => (addrs || []).some((a) => a && !a.internal && Protocol.isTailnetIPv4(a.address)));
function routeProblem(config, ifaces) {
  if (!config || !config.url) return null;
  const u = new URL(config.url);
  return u.protocol === 'http:' && Protocol.isTailnetIPv4(u.hostname) && !hasTailnetAddress(ifaces)
    ? `${u.hostname} is a Tailscale address, but this machine has none: plain http would cross the local network. Start Tailscale here, or use an ssh tunnel.` : null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Whatever the other end says is printed only after this.
const clean = (v) => Protocol.displayString(String(v ?? ''), 200);

function readCode(say) {
  if (process.env.BUDDY_PAIRING_CODE) {
    say('Using BUDDY_PAIRING_CODE. If you typed it on a command line it is in your shell history now; clear that line.');
    return Promise.resolve(process.env.BUDDY_PAIRING_CODE);
  }
  if (!process.stdin.isTTY) return new Promise((resolve) => { let t = ''; process.stdin.on('data', (c) => { t += c; }); process.stdin.on('end', () => resolve(t)); });
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write('Pairing code (from Buddy → Preferences → Remote devices; not shown as you paste): ');
  // Don't echo the code: it is the device's key.
  rl._writeToOutput = () => {};
  return new Promise((resolve) => rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); }));
}

function targetConfig(arg) {
  if (typeof arg === 'string' && arg.startsWith('unix:')) return { socketPath: arg.slice(5) };
  return { url: arg };
}

async function cli(argv) {
  const [cmd, arg] = argv;
  const say = (...a) => console.log(...a);
  const answer = (r) => (r.ok ? 'ok' : r.status && !r.authentic ? `HTTP ${r.status} from something that is not your Buddy (the answer isn't signed with this device's key)`
    : r.status ? `HTTP ${r.status} ${clean(r.body && r.body.error)}` : clean(r.error || r.skipped));
  if (cmd === 'pair') {
    const target = targetConfig(arg);
    if (!Transport.validate({ ...target, device: 'x', token: '0'.repeat(64) })) {
      say('Usage: remote.js pair <url | unix:/path.sock>. The url must be https, or http to 127.0.0.1 (an ssh -R tunnel) or a Tailscale IPv4; a socket must sit in a directory only you can enter (chmod 700).');
      return 1;
    }
    const problem = routeProblem(Transport.validate({ ...target, device: 'x', token: '0'.repeat(64) }));
    if (problem) { say(problem); return 1; }
    const here = localBuddy();
    if (here && !argv.includes('--force')) {
      say(`Not pairing: ${here}. This machine's sessions already show on its own widget. To report them to another Buddy as well, run again with --force (the app's own hooks stay as they are).`);
      return 1;
    }
    const pairing = Protocol.parsePairingCode(await readCode(say));
    if (!pairing) { say('That is not a Buddy pairing code (buddy-pair-v1.…). Pair the device again in Buddy to get a new one.'); return 1; }
    const file = saveConfig(ROOT_DIR, { transport: 'direct', ...target, device: pairing.device, token: pairing.token });
    say(`Saved ${file} (readable by you only).`);
    const r = await send('ping', {}, { ignoreBackoff: true });
    say(r.ok ? `Buddy answered: paired as "${clean(r.body && r.body.name)}".` : `Buddy did not answer (${answer(r)}). Saved anyway; check the tunnel and run \`remote.js status\`. A code unused for 10 minutes expires: revoke and pair again.`);
    if (!argv.includes('--no-hooks')) say(`Installed reporter hooks into ${installHooks()}. Restart running Claude Code sessions for them to take effect.`);
    return 0;
  }
  if (cmd === 'status') {
    const c = loadConfig();
    if (!c) { say(isPaired() ? `${configPath()} is unreadable or invalid.` : 'Not paired.'); return 1; }
    const problem = routeProblem(c);
    if (problem) { say(problem); return 1; }
    const r = await send('ping', {}, { ignoreBackoff: true });
    say(`Device ${c.device} → ${c.url || `unix:${c.socketPath}`}: ${r.ok ? `ok (${clean(r.body && r.body.name)})` : `no (${answer(r)})`}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'heartbeat') {
    const every = Number(argv[argv.indexOf('--every') + 1]);
    const once = async () => { const r = await heartbeat(); if (!r.ok) console.error(`heartbeat: ${answer(r)}`); return r.ok; };
    if (!argv.includes('--every')) return (await once()) ? 0 : 1;
    if (!(every >= 5)) { say('--every takes seconds, at least 5.'); return 1; }
    await once();
    setInterval(once, every * 1000);
    return null;
  }
  if (cmd === 'unpair') {
    fs.rmSync(configPath(), { force: true });
    fs.rmSync(path.join(ROOT_DIR, STATE_FILE), { force: true });
    say(`Removed the pairing and the reporter hooks from ${uninstallHooks()}. Revoke the device in Buddy too.`);
    return 0;
  }
  if (cmd === '__send') { senderMain(); return null; }
  say('Usage: remote.js pair <url | unix:/path.sock> [--force] | status | heartbeat [--every <seconds>] | unpair');
  return 1;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => { if (code !== null) process.exit(code); }, (e) => { console.error(clean(e.message)); process.exit(1); });
}

module.exports = { ROOT_DIR, BACKOFF_MS, SWEEP_AFTER_MS, configPath, isPaired, loadConfig, saveConfig, backingOff, nextSeq, wireEvent, send, dispatchThenExit, agentPid, liveSessions, heartbeat, reporterHooks, installHooks, uninstallHooks, localBuddy, routeProblem, hasTailnetAddress, cli };
