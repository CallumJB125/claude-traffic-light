#!/usr/bin/env node
// Registers Claude Code hooks (in ~/.claude/settings.json) that keep the
// traffic light in sync with every live session. Safe to run multiple times.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SET_STATUS_SCRIPT = path.join(__dirname, 'set-status.js');

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
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
  const already = hooks[event].some((h) => h.hooks && h.hooks.some((hh) => hh.command === command));
  if (!already) hooks[event].push(entry);
}

const settings = loadSettings();
settings.hooks = settings.hooks || {};

// Drop any old install's Stop→amber hook — Stop fires after every single
// response, including totally routine ones, so it used to mark amber just
// for finishing a turn. Matched by script name + trailing args, not the
// full command, since the script's own path can differ between installs
// (dev checkout vs packaged .app). Only ever strips our own set-status.js
// calls, never a Stop hook the user or another tool added.
const isOldStopCmd = (command) => /set-status\.js" amber stop$/.test(command || '');
if (settings.hooks.Stop) {
  settings.hooks.Stop = settings.hooks.Stop
    .map((h) => ({ ...h, hooks: (h.hooks || []).filter((hh) => !isOldStopCmd(hh.command)) }))
    .filter((h) => h.hooks.length > 0);
}

// New turn starts -> that session goes green (working).
addHook(settings.hooks, 'UserPromptSubmit', '', cmd('green', 'prompt-submit'));
// About to run a tool -> still green (working).
addHook(settings.hooks, 'PreToolUse', '', cmd('green', 'tool-use'));
// Needs the user (permission prompt, Claude Code's own "still waiting on
// you" idle nudge, or a usage/rate-limit message which set-status.js sniffs
// from stdin and escalates to red) -> amber. This is the only "your input
// is needed" signal — Stop alone isn't, see above.
addHook(settings.hooks, 'Notification', '', cmd('amber', 'notification'));
// Finished a task cleanly (distinct from the removed amber-on-Stop) ->
// eyes go green and Claude gives a thumbs up until the next prompt starts
// or something actually needs you.
addHook(settings.hooks, 'Stop', '', cmd('done', 'stop'));
// Session ended -> stop counting it entirely.
addHook(settings.hooks, 'SessionEnd', '', cmd('amber', 'session-end'));

fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

console.log('Installed Claude Code hooks into', SETTINGS_PATH);
console.log('Restart any running Claude Code sessions for the hooks to take effect.');
