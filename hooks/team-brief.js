#!/usr/bin/env node
// SessionStart team brief (docs/TEAM-CONTEXT-CONTRACT.md): asks the running app
// for at most 1500 characters on who else is working in this repository and
// hands it to the AI as session context. The app holds the hub sign-in and does
// the gating (setting on, repo linked, sharing on); this side only checks the
// setting first so a session start with it off costs one small file read.
// Dependency-free (fs, path, os, http) and never throws: silence on any doubt.
//
//   team-brief.js [--adapter claude|codex|gemini]   payload JSON on stdin
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http'); // privacy-flow: local-server

const TIMEOUT_MS = 800;
const MAX = 1500;
const MAX_REPLY = 16 * 1024;
// Adapters whose SessionStart output is documented to reach the model as
// context, all in the same hookSpecificOutput shape.
const CONTEXT_ADAPTERS = new Set(['claude', 'codex', 'gemini']);

const rootDir = (env = process.env) => env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');

function enabled(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).teamBrief === true; } catch { return false; }
}

function endpoint(root) {
  try {
    const port = Number(fs.readFileSync(path.join(root, 'port'), 'utf8').trim());
    const token = fs.readFileSync(path.join(root, 'token'), 'utf8').trim();
    return Number.isInteger(port) && port > 0 && port < 65536 && /^[0-9a-f]{64}$/.test(token) ? { port, token } : null;
  } catch { return null; }
}

function ask({ port, token }, body, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const data = Buffer.from(JSON.stringify(body));
    let req;
    const timer = setTimeout(() => { done(null); if (req) req.destroy(); }, timeoutMs);
    try {
      req = http.request({ host: '127.0.0.1', port, path: '/team/activity', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-buddy-token': token } }, (res) => { // privacy-flow: local-server
        let text = '';
        res.on('data', (c) => { text += c; if (text.length > MAX_REPLY) { done(null); req.destroy(); } });
        res.on('end', () => { try { done(res.statusCode === 200 ? JSON.parse(text) : null); } catch { done(null); } });
      });
      req.on('error', () => done(null));
      req.end(data);
    } catch { done(null); }
  });
}

function output(brief) {
  if (typeof brief !== 'string' || !brief.trim()) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief.slice(0, MAX) } };
}

// → the hook output object, or null for silence.
async function run({ adapter = 'claude', payload = {}, root = rootDir(), timeoutMs = TIMEOUT_MS } = {}) {
  try {
    if (!CONTEXT_ADAPTERS.has(adapter) || !enabled(root)) return null;
    const d = payload && typeof payload === 'object' ? payload : {};
    // A compaction carries on the same work; the brief was given at the start.
    if (d.source === 'compact') return null;
    const cwd = typeof d.cwd === 'string' && path.isAbsolute(d.cwd) ? d.cwd : process.cwd();
    const ep = endpoint(root);
    if (!ep) return null;
    const session = typeof d.session_id === 'string' ? d.session_id.slice(0, 120) : null;
    const reply = await ask(ep, { op: 'brief', args: { cwd, session } }, timeoutMs);
    return reply && reply.available === true ? output(reply.brief) : null;
  } catch { return null; }
}

// fs.writeSync, as set-status.js: stdout is an async pipe on macOS and the
// caller exits right after.
function print(out) {
  if (!out) return;
  const buf = Buffer.from(JSON.stringify(out));
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(1, buf, off); } catch (e) {
      if (e.code !== 'EAGAIN') break;
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
}

module.exports = { run, output, print, enabled, endpoint, CONTEXT_ADAPTERS, TIMEOUT_MS, MAX };

if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--adapter');
  const adapter = i >= 0 ? argv[i + 1] : 'claude';
  const chunks = [];
  let bytes = 0, started = false;
  const go = () => !started && (started = true) && run({ adapter, payload: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; } })() })
    .then((out) => { print(out); process.exit(0); }, () => process.exit(0));
  if (process.stdin.isTTY) go();
  else {
    const t = setTimeout(go, 500);
    process.stdin.on('data', (c) => { bytes += c.length; if (bytes > 1024 * 1024) process.exit(0); chunks.push(c); });
    process.stdin.on('end', () => { clearTimeout(t); go(); });
    process.stdin.on('error', () => process.exit(0));
  }
}
