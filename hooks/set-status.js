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

const KNOWN = ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'subagent-start', 'subagent-done', 'permission-denied', 'turn-failed', 'stop', 'session-start', 'compact', 'notification', 'session-end'];
// Sessions started under an older install still call `<colour> <reason>`
// (e.g. `green tool-use`); the reason is the signal we want.
const LEGACY_REASONS = { 'prompt-submit': 'prompt-submit', 'tool-use': 'tool-use', notification: 'notification', stop: 'stop', 'session-end': 'session-end' };
const [, , a, b] = process.argv;
const signal = KNOWN.includes(a) ? a : (['green', 'amber', 'red', 'done'].includes(a) && LEGACY_REASONS[b]) || null;
if (!signal) process.exit(0);

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let data = null;
if (!process.stdin.isTTY) {
  try {
    data = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    // no / unparsable payload
  }
}

const sessionId = (data && (data.session_id || data.sessionId)) || process.env.CLAUDE_SESSION_ID || 'unknown';
const cwd = (data && data.cwd) || process.cwd();
const file = path.join(SESSIONS_DIR, `${HOST_TAG}-${sessionId}.json`);

if (signal === 'session-end') {
  fs.rmSync(file, { force: true });
  process.exit(0);
}

let resolved = signal;
if (signal === 'notification') {
  // Notification fires for a real permission ask, a usage-limit message, and
  // a routine "still waiting on you" idle nudge. Each becomes its own signal
  // so rules can treat them differently (the default rules ignore the nudge).
  const text = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
  if (/usage limit|rate limit|out of tokens|reached your (5-hour|weekly) limit|quota exceeded/.test(text)) resolved = 'limit-hit';
  else if (/permission|approve|allow|confirm/.test(text)) resolved = 'permission-ask';
  else resolved = 'idle-nudge';
}

const tool = (data && (data.tool_name || data.toolName)) || null;

// PreToolUse fires many times a second during a busy turn. Skip the write if
// nothing changed in the last second — the app polls anyway, and this keeps
// the fs.watch storm down. `workingSince` marks when the current turn began
// (for the "working over N minutes" signal) and resets on each new prompt.
let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (prev.signal === resolved && prev.tool === tool && Date.now() - new Date(prev.updatedAt).getTime() < 1000) process.exit(0);
} catch {
  // first write
}
const now = new Date().toISOString();
const TURN_END = new Set(['stop', 'idle-nudge', 'permission-ask', 'limit-hit', 'session-start']);
const workingSince = resolved === 'prompt-submit' ? now : TURN_END.has(resolved) ? null : (prev?.workingSince || now);

fs.writeFileSync(
  file,
  JSON.stringify({ sessionId, host: HOST_TAG, cwd, signal: resolved, tool, workingSince, updatedAt: now }, null, 2)
);
