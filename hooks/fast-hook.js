// The hook side of the fast path (feature flag `fastHook`, default OFF).
//
// set-status.js is launched for every hook event, and its own work (process
// walks, tmux and ps lookups, a session-file read-modify-write) is paid in a
// fresh process each time. When the app is running with the fast path on, it
// listens on a local socket (a unix socket in the data folder, a named pipe on
// Windows) and runs that same script itself, in-process, for the frequent
// events whose answer it already has. This file builds the message and sends
// it. It is dependency-free (fs, path, crypto, net) and never throws: any
// failure, timeout or refusal is just "not forwarded", and set-status.js then
// does its normal work. No endpoint file (the flag is off, the app is not
// running) costs one failed read.
//
// Nothing secret is written anywhere: the endpoint file (mode 0600, written by
// the app) holds the socket path and a per-run token, and the message carries
// that token back over the socket, exactly as the app's HTTP signal endpoint
// takes its x-buddy-token. The hook payload is what already goes to the
// session file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENDPOINT_FILE = 'hook-endpoint.json';
const DEFAULT_TIMEOUT_MS = 250;
const MAX_MESSAGE_BYTES = 262144;

// Events worth forwarding: frequent, non-blocking, no terminal capture. Session
// start/end and the two blocking asks (and AskUserQuestion's PreToolUse, which
// may wait for an answer) always take the full path in their own process.
const FORWARD_SIGNALS = new Set(['tool-use', 'tool-done', 'tool-failed', 'prompt-submit', 'stop', 'subagent-start', 'subagent-done', 'task-created', 'task-done', 'notification']);
// The only environment the hook's work looks at; everything else stays here.
const FORWARD_ENV = ['__CFBundleIdentifier', 'TERM_PROGRAM', 'TMUX', 'TMUX_PANE', 'STY', 'BUDDY_OWNED'];

function eligible(signal, data) {
  if (!FORWARD_SIGNALS.has(signal)) return false;
  if (data && data.tool_name === 'AskUserQuestion') return false;
  return true;
}

// Where the app listens. A pure function of the data folder so both sides
// agree without talking.
function pipePath(rootDir, platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\plexiform-hook-${crypto.createHash('sha1').update(String(rootDir).toLowerCase()).digest('hex').slice(0, 16)}`;
  return path.join(rootDir, 'hook.sock');
}

function readEndpoint(rootDir, fsImpl = fs) {
  try {
    const e = JSON.parse(fsImpl.readFileSync(path.join(rootDir, ENDPOINT_FILE), 'utf8'));
    return e && e.v === 1 && typeof e.path === 'string' && typeof e.token === 'string' && e.token.length >= 32 ? { path: e.path, token: e.token } : null;
  } catch { return null; }
}

function build({ signal, payload, env, ppid, cwd, token }) {
  const sent = {};
  for (const k of FORWARD_ENV) if (typeof env[k] === 'string') sent[k] = env[k];
  return { v: 1, token, signal, payload: payload || '', env: sent, ppid, cwd };
}

// → Promise<boolean>: true only when the app says it handled the event.
function forward(msg, endpoint, { timeoutMs = DEFAULT_TIMEOUT_MS, net = require('net') } = {}) { // privacy-flow: local-server
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); try { socket && socket.destroy(); } catch { /* gone */ } resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      const body = JSON.stringify(msg) + '\n';
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return done(false);
      socket = net.connect(endpoint.path); // privacy-flow: local-server
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(body));
      socket.on('data', (c) => {
        buf += c;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try { done(JSON.parse(buf.slice(0, nl)).ok === true); } catch { done(false); }
      });
      socket.on('error', () => done(false));
      socket.on('close', () => done(false));
    } catch { done(false); }
  });
}

module.exports = { ENDPOINT_FILE, FORWARD_SIGNALS, FORWARD_ENV, DEFAULT_TIMEOUT_MS, MAX_MESSAGE_BYTES, eligible, pipePath, readEndpoint, build, forward };
