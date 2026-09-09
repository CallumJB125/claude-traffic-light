#!/usr/bin/env node
// Writes ~/.claude-traffic-light/sessions/<session_id>.json. Called by Claude
// Code hooks so every live session reports its own state independently; the
// widget aggregates all of them (see main.js: aggregateState).
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');

const [, , stateArg, reasonArg] = process.argv;
const state = ['green', 'amber', 'red'].includes(stateArg) ? stateArg : 'amber';
const reason = reasonArg || 'hook';

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Claude Code pipes a JSON payload (including session_id, cwd, etc) on stdin.
let payload = '';
if (!process.stdin.isTTY) {
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch {
    // no stdin piped
  }
}

let data = null;
if (payload) {
  try {
    data = JSON.parse(payload);
  } catch {
    // ignore unparsable payload
  }
}

const sessionId = (data && (data.session_id || data.sessionId)) || process.env.CLAUDE_SESSION_ID || 'unknown';
const cwd = (data && data.cwd) || process.cwd();

if (reason === 'session-end') {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  fs.rm(file, { force: true }, () => {});
  process.exit(0);
}

// Claude Code's Notification hook fires for two different things and its
// payload doesn't distinguish them by any field except the message text:
//   - a real permission request ("Claude needs your permission to use X")
//   - a routine idle nudge once the terminal's sat quiet after Claude
//     finished ("Claude is waiting for your input")
// Only the first is an actual block worth surfacing — the second just means
// a task finished normally, which isn't "needs your input" in any sense
// that should light up amber. So a notification event only escalates to
// amber when the message text looks like a real permission/approval ask;
// otherwise this exits without touching the session file at all, leaving
// its last real state (almost always still green from the last tool call).
let detectedState = state;
if (reason === 'notification') {
  const text = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
  const isPermissionRequest = /permission|approve|allow|confirm/.test(text);
  if (!isPermissionRequest) process.exit(0);
}

// Only the actual notification text is checked — not the whole JSON payload
// (which also carries cwd/transcript paths that can innocently contain
// words like "limit" and would otherwise cause false positives).
if (data && state === 'amber' && typeof data.message === 'string') {
  const text = data.message.toLowerCase();
  if (/usage limit|rate limit|out of tokens|reached your (5-hour|weekly) limit|quota exceeded/.test(text)) {
    detectedState = 'red';
  }
}

fs.writeFileSync(
  path.join(SESSIONS_DIR, `${sessionId}.json`),
  JSON.stringify(
    { sessionId, cwd, state: detectedState, updatedAt: new Date().toISOString(), reason },
    null,
    2
  )
);
