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

// Only the actual notification text is checked — not the whole JSON payload
// (which also carries cwd/transcript paths that can innocently contain
// words like "limit" and would otherwise cause false positives).
let detectedState = state;
if (data && state === 'amber' && typeof data.message === 'string') {
  const text = data.message.toLowerCase();
  if (/usage limit|rate limit|out of tokens|reached your (5-hour|weekly) limit|quota exceeded/.test(text)) {
    detectedState = 'red';
  }
}

if (reason === 'session-end') {
  const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
  fs.rm(file, { force: true }, () => {});
  process.exit(0);
}

fs.writeFileSync(
  path.join(SESSIONS_DIR, `${sessionId}.json`),
  JSON.stringify(
    { sessionId, cwd, state: detectedState, updatedAt: new Date().toISOString(), reason },
    null,
    2
  )
);
