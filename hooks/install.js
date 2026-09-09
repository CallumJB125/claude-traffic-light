#!/usr/bin/env node
// Registers Claude Code hooks (in ~/.claude/settings.json) that report every
// session's raw signals to the traffic light. Safe to run repeatedly; only
// ever adds or strips its own set-status.js entries.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SET_STATUS_SCRIPT = path.join(__dirname, 'set-status.js');

// One hook per Claude Code event, each passing the raw signal. The visual
// meaning lives in the app's rules, so this list only changes when Claude
// Code grows a new event.
const HOOK_EVENTS = [
  ['UserPromptSubmit', 'prompt-submit'],
  ['PreToolUse', 'tool-use'],
  ['PostToolUse', 'tool-done'],
  ['PostToolUseFailure', 'tool-failed'],
  ['SubagentStart', 'subagent-start'],
  ['SubagentStop', 'subagent-done'],
  ['PermissionDenied', 'permission-denied'],
  ['StopFailure', 'turn-failed'],
  ['Stop', 'stop'],
  ['Notification', 'notification'],
  ['SessionStart', 'session-start'],
  ['PreCompact', 'compact'],
  ['SessionEnd', 'session-end'],
];

function cmd(signal) {
  return `node "${SET_STATUS_SCRIPT}" ${signal}`;
}

function isOurs(command) {
  return /set-status\.js" /.test(command || '');
}

function install(settings, scriptPath = SET_STATUS_SCRIPT) {
  settings.hooks = settings.hooks || {};
  const command = (signal) => `node "${scriptPath}" ${signal}`;
  // Strip every previous install (old colour-style commands, moved .app
  // paths) so exactly one current set survives.
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event]
      .map((h) => ({ ...h, hooks: (h.hooks || []).filter((hh) => !isOurs(hh.command)) }))
      .filter((h) => h.hooks.length > 0);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  for (const [event, signal] of HOOK_EVENTS) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command: command(signal) }] });
  }
  return settings;
}

function isInstalled(settings, scriptPath = SET_STATUS_SCRIPT) {
  const command = (signal) => `node "${scriptPath}" ${signal}`;
  return HOOK_EVENTS.every(([event, signal]) =>
    (settings.hooks?.[event] || []).some((h) => h.hooks?.some((hh) => hh.command === command(signal)))
  );
}

module.exports = { HOOK_EVENTS, install, isInstalled, cmd };

if (require.main === module) {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
      console.error('Could not parse', SETTINGS_PATH, '- aborting to avoid clobbering it.');
      process.exit(1);
    }
  }
  install(settings);
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('Installed Claude Code hooks into', SETTINGS_PATH);
  console.log('Restart any running Claude Code sessions for the hooks to take effect.');
}
