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

let detectedState = state;
if (data && state === 'amber') {
  const text = JSON.stringify(data).toLowerCase();
  if (/usage limit|rate limit|out of tokens|context limit|quota exceeded/.test(text)) {
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
