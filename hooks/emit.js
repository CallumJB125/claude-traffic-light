#!/usr/bin/env node
// Generic emitter for any agent, not just Claude Code:
//
//   emit.js <signal> [--source name] [--session id] [--cwd path] [--tool name]
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

if (adapterId) {
  const adapter = Adapters.get(adapterId);
  if (!adapter) process.exit(0);
  // Codex passes its JSON as the last argument; everyone else pipes it.
  const payload = adapterId === 'codex' ? parse(argv[argv.length - 1]) : parse(readStdin());
  const reply = adapter.reply ? adapter.reply(event, payload) : null;
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
  for (const e of events) {
    SessionState.applyAdapterEvent(SESSIONS_DIR, { host: HOST_TAG, source: adapter.id, event: e, fallbackSession: process.env.CLAUDE_SESSION_ID || `${adapter.id}-${process.ppid}`, fallbackCwd: process.cwd() });
  }
  process.exit(0);
}

const signal = argv.find((a) => KNOWN.includes(a)) || null;
if (!signal) process.exit(0);
const source = opt('source') || 'custom';
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const sessionId = opt('session') || process.env.CLAUDE_SESSION_ID || `${source}-${process.ppid}`;
const file = path.join(SESSIONS_DIR, `${HOST_TAG}-${source}-${sessionId}.json`);
if (signal === 'session-end') { fs.rmSync(file, { force: true }); process.exit(0); }
// Same lock and state step as the Claude Code hook and the app's /signal
// endpoint, so what the app and the pollers stored on the file survives.
SessionState.withLock(file, () => {
  const prev = SessionState.readJson(file);
  const next = SessionState.applyBareSignal(prev, { sessionId, host: HOST_TAG, source, cwd: opt('cwd') || prev?.cwd || process.cwd(), signal, tool: opt('tool') || null });
  SessionState.writeJsonAtomic(file, next);
});
