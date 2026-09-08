#!/usr/bin/env node
// Registers Claude Code hooks (in ~/.claude/settings.json) that keep the
// traffic light in sync with real session events. Safe to run multiple times.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SET_STATUS_SCRIPT = path.join(__dirname, 'set-status.js');

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    console.error('Could not parse', SETTINGS_PATH, '- aborting to avoid clobbering it.');
    process.exit(1);
  }
}

function cmd(state, reason) {
  return `node "${SET_STATUS_SCRIPT}" ${state} ${reason}`;
}

function addHook(hooks, event, matcher, command) {
  hooks[event] = hooks[event] || [];
  const entry = { matcher: matcher || '', hooks: [{ type: 'command', command }] };
  const already = hooks[event].some(
    (h) => h.hooks && h.hooks.some((hh) => hh.command === command)
  );
  if (!already) hooks[event].push(entry);
}

const settings = loadSettings();
settings.hooks = settings.hooks || {};

// Claude starts working on a new turn -> green.
addHook(settings.hooks, 'UserPromptSubmit', '', cmd('green', 'prompt-submit'));
// Claude is about to run a tool -> still green (working).
addHook(settings.hooks, 'PreToolUse', '', cmd('green', 'tool-use'));
// Claude needs the user (permission prompt, waiting) -> amber, or red if the
// payload mentions usage/rate limits (set-status.js sniffs stdin for that).
addHook(settings.hooks, 'Notification', '', cmd('amber', 'notification'));
// Claude finished its turn and is waiting on you -> amber.
addHook(settings.hooks, 'Stop', '', cmd('amber', 'stop'));

fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

console.log('Installed Claude Code hooks into', SETTINGS_PATH);
console.log('Restart any running Claude Code sessions for the hooks to take effect.');
