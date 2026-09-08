#!/usr/bin/env node
// Writes ~/.claude-traffic-light/status.json. Called by Claude Code hooks.
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATUS_DIR = path.join(os.homedir(), '.claude-traffic-light');
const STATUS_FILE = path.join(STATUS_DIR, 'status.json');

const [, , stateArg, reasonArg] = process.argv;
const state = ['green', 'amber', 'red'].includes(stateArg) ? stateArg : 'amber';
const reason = reasonArg || 'hook';

if (!fs.existsSync(STATUS_DIR)) fs.mkdirSync(STATUS_DIR, { recursive: true });

// Read stdin (Claude Code hooks pass JSON payload on stdin) without blocking if empty.
let payload = '';
if (!process.stdin.isTTY) {
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch {
    // no stdin piped
  }
}

let detectedState = state;
if (payload) {
  try {
    const data = JSON.parse(payload);
    const text = JSON.stringify(data).toLowerCase();
    if (state === 'amber' && /usage limit|rate limit|out of tokens|context limit|quota/.test(text)) {
      detectedState = 'red';
    }
  } catch {
    // ignore unparsable payload
  }
}

fs.writeFileSync(
  STATUS_FILE,
  JSON.stringify({ state: detectedState, updatedAt: new Date().toISOString(), reason }, null, 2)
);
