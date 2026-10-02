#!/usr/bin/env node
// Generic emitter for any agent, not just Claude Code:
//
//   emit.js <signal> [--source name] [--session id] [--cwd path] [--tool name]
//                  [--task id] [--title text] [--summary text]
//   emit.js --adapter <id> [event]      payload JSON on stdin, or (Codex) as the last arg
//
// signals: prompt-submit | tool-use | tool-done | tool-failed | stop |
//          turn-failed | permission-ask | permission-denied | limit-hit |
//          idle-nudge | session-start | session-end | subagent-start |
//          subagent-done | compact
//
// --adapter hands the event and payload to adapters/<id>.js normalize(), the
// same step the app's POST /hook/:adapter route takes. Installs from before
// the adapter layer still call `--cursor <event>` and `--codex`; both are
// read as their adapter.
// Never break the calling agent: any failure exits 0 quietly.
process.on('uncaughtException', () => process.exit(0));
const fs = require('fs');
const path = require('path');
const os = require('os');
const SessionState = require('./session-state.js');
const Adapters = require('../adapters/index.js');

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const HOST_TAG = os.hostname().split('.')[0];
const KNOWN = ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'stop', 'turn-failed', 'permission-ask', 'permission-denied', 'limit-hit', 'idle-nudge', 'session-start', 'session-end', 'subagent-start', 'subagent-done', 'compact'];

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

function readStdin() {
  if (process.stdin.isTTY) return '';
  const buf = Buffer.alloc(65536); let out = '';
  const sleeper = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    let n; try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') { Atomics.wait(sleeper, 0, 0, 10); continue; } break; }
    if (n === 0) break; out += buf.toString('utf8', 0, n);
  }
  return out;
}
const parse = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

let adapterId = opt('adapter');
let event = adapterId ? argv[argv.indexOf('--adapter') + 2] : null;
if (!adapterId && opt('cursor')) { adapterId = 'cursor'; event = opt('cursor'); }
if (!adapterId && argv.includes('--codex')) adapterId = 'codex';

function emitAdapter(payload) {
  const adapter = Adapters.get(adapterId);
  if (!adapter) process.exit(0);
  const reply = opt('lifecycle') ? null : adapter.reply ? adapter.reply(event, payload) : null;
  // fs.writeSync, like set-status.js: stdout is an async pipe on macOS and
  // process.exit below would cut the reply short.
  if (reply) {
    const buf = Buffer.from(JSON.stringify(reply));
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let off = 0; off < buf.length;) {
      try { off += fs.writeSync(1, buf, off); } catch (e) {
        if (e.code !== 'EAGAIN') break;
        Atomics.wait(sleeper, 0, 0, 5);
      }
    }
  }
  const events = adapter.normalize(event, payload).filter((e) => KNOWN.includes(e.signal));
  if (!events.length) process.exit(0);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  // Paired as a reporter (hooks/remote.js): the local file also records the
  // agent's pid (the heartbeat checks it) and a per-session sequence number
  // (the desktop orders events by it), and each event is dispatched.
  const Remote = fs.existsSync(path.join(ROOT_DIR, 'remote.json')) ? require('./remote.js') : null;
  const fallbackSession = process.env.CLAUDE_SESSION_ID || `${adapter.id}-${process.ppid}`;
  const accepted = [];
  for (const e of events) {
    e.sessionId = SessionState.safeSessionId(e.sessionId || fallbackSession);
    const file = SessionState.sessionFileFor(SESSIONS_DIR, HOST_TAG, adapter.id, e.sessionId);
    const before = Remote ? SessionState.readJson(file) : null;
    if (Remote && !e.pid && !e.codexLifecycle) e.pid = Remote.agentPid(before?.claudePid);
    if (Remote && e.signal === 'session-end') e.seq = Remote.nextSeq(before?.remoteSeq);
    const applied = SessionState.applyAdapterEvent(SESSIONS_DIR, { host: HOST_TAG, source: adapter.id, event: e, fallbackSession, fallbackCwd: process.cwd(), decorate: Remote && ((next, prev) => { next.remoteSeq = e.seq = Remote.nextSeq(prev?.remoteSeq); }) });
    if (!applied) continue;
    if (Remote && !e.cwd) e.cwd = process.cwd();
    accepted.push(e);
  }
  if (Remote) Remote.dispatchThenExit(adapter.id, accepted);
  else process.exit(0);
}

if (adapterId) {
  const lifecycle = opt('lifecycle');
  if (argv.includes('--lifecycle')) {
    const codex = Adapters.get('codex');
    if (adapterId !== 'codex' || !codex.LIFECYCLE_EVENTS.includes(lifecycle)) process.exit(0);
    event = lifecycle;
    // These two events explicitly require JSON stdout on success. A neutral
    // object never approves, blocks, continues, or supplies model context,
    // even when input is malformed, oversized, or never reaches EOF.
    if (event === 'Stop' || event === 'SubagentStop') fs.writeSync(1, '{}');
    let bytes = 0; const chunks = [];
    const timer = setTimeout(() => process.exit(0), 750);
    process.stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) process.exit(0);
      chunks.push(chunk);
    });
    process.stdin.on('error', () => process.exit(0));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      emitAdapter(parse(Buffer.concat(chunks, bytes).toString('utf8')));
    });
    process.stdin.resume();
  } else {
    // Legacy notify JSON remains argv; lifecycle JSON is explicitly stdin.
    emitAdapter(adapterId === 'codex' ? parse(argv[argv.length - 1]) : parse(readStdin()));
  }
}

// The bare-signal form, when no adapter was named (the adapter branch above
// may still be sending, so it must not fall through to here).
if (!adapterId) {
  const signal = argv.find((a) => KNOWN.includes(a)) || null;
  if (!signal) process.exit(0);
  // Lower case, as the desktop's reporter check wants a source to be.
  const source = /^[a-z][a-z0-9_-]{0,23}$/.test(String(opt('source') || '').toLowerCase()) ? opt('source').toLowerCase() : 'custom';
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const sessionId = SessionState.safeSessionId(opt('session') || process.env.CLAUDE_SESSION_ID || `${source}-${process.ppid}`);
  const file = SessionState.sessionFileFor(SESSIONS_DIR, HOST_TAG, source, sessionId);
  let cwd = '';
  let seq = null;
  const Remote = fs.existsSync(path.join(ROOT_DIR, 'remote.json')) ? require('./remote.js') : null;
  if (signal === 'session-end') { if (Remote) seq = Remote.nextSeq(SessionState.readJson(file)?.remoteSeq); fs.rmSync(file, { force: true }); }
  // Same lock and state step as the Claude Code hook and the app's /signal
  // endpoint, so what the app and the pollers stored on the file survives.
  else {
    SessionState.withLock(file, () => {
      const prev = SessionState.readJson(file);
      cwd = opt('cwd') || prev?.cwd || process.cwd();
      const next = SessionState.applyBareSignal(prev, { sessionId, host: HOST_TAG, source, cwd, signal, tool: opt('tool') || null,
        taskId: opt('task'), taskTitle: opt('title'), taskSummary: opt('summary') });
      if (Remote) next.remoteSeq = seq = Remote.nextSeq(prev?.remoteSeq);
      SessionState.writeJsonAtomic(file, next);
    });
  }
  if (Remote) Remote.dispatchThenExit(source.replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'custom', [{ signal, seq, sessionId: SessionState.safeSessionId(sessionId), cwd, tool: opt('tool') || null }]);
}
