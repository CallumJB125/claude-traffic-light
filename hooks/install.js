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
// PermissionRequest is opt-in (it changes how approvals reach you) and is
// the only hook that blocks: it waits up to 60s for the widget's answer.
const OPTIONAL_EVENTS = [['PermissionRequest', 'permission-request', 60]];
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
  ['TaskCreated', 'task-created'],
  ['TaskCompleted', 'task-done'],
  ['SessionEnd', 'session-end'],
];

function cmd(signal) {
  return `node "${SET_STATUS_SCRIPT}" ${signal}`;
}

function isOurs(command) {
  return /set-status\.js" /.test(command || '');
}

function install(settings, scriptPath = SET_STATUS_SCRIPT, options = {}) {
  settings.hooks = settings.hooks || {};
  const command = (signal) => `node "${scriptPath}" ${signal}`;
  const events = options.askFromWidget ? HOOK_EVENTS.concat(OPTIONAL_EVENTS) : HOOK_EVENTS;
  // Strip every previous install (old colour-style commands, moved .app
  // paths) so exactly one current set survives.
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event]
      .map((h) => ({ ...h, hooks: (h.hooks || []).filter((hh) => !isOurs(hh.command)) }))
      .filter((h) => h.hooks.length > 0);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  for (const [event, signal, timeout] of events) {
    settings.hooks[event] = settings.hooks[event] || [];
    const hook = { type: 'command', command: command(signal) };
    if (timeout) hook.timeout = timeout;
    settings.hooks[event].push({ matcher: '', hooks: [hook] });
  }
  return settings;
}

function isInstalled(settings, scriptPath = SET_STATUS_SCRIPT, options = {}) {
  const command = (signal) => `node "${scriptPath}" ${signal}`;
  const has = (event, signal) => (settings.hooks?.[event] || []).some((h) => h.hooks?.some((hh) => hh.command === command(signal)));
  const wantAsk = !!options.askFromWidget;
  return HOOK_EVENTS.every(([e, s]) => has(e, s)) && OPTIONAL_EVENTS.every(([e, s]) => has(e, s) === wantAsk);
}

// ── Other agents ────────────────────────────────────────────────────────────
const EMIT_SCRIPT = path.join(__dirname, 'emit.js');

// Cursor: ~/.cursor/hooks.json ({version:1, hooks:{event:[{command}]}}).
function installCursor(hooksJson, emitPath = EMIT_SCRIPT) {
  const out = hooksJson && typeof hooksJson === 'object' ? { ...hooksJson } : {};
  out.version = out.version || 1;
  out.hooks = { ...(out.hooks || {}) };
  const ours = (c) => /emit\.js" --cursor /.test(c || '');
  for (const ev of ['beforeSubmitPrompt', 'beforeShellExecution', 'beforeMCPExecution', 'afterFileEdit', 'stop']) {
    const list = (out.hooks[ev] || []).filter((h) => !ours(h.command));
    list.push({ command: `node "${emitPath}" --cursor ${ev}` });
    out.hooks[ev] = list;
  }
  return out;
}

// Codex CLI: ~/.codex/config.toml — a `notify` array. Returns the new file text.
function installCodex(tomlText, emitPath = EMIT_SCRIPT) {
  const line = `notify = ["node", "${emitPath}", "--codex"]`;
  const lines = String(tomlText || '').split('\n').filter((l) => !/^\s*notify\s*=/.test(l));
  return [line, ...lines].join('\n').replace(/\n+$/, '') + '\n';
}

// Gemini CLI: ~/.gemini/settings.json — best effort, mirrors the Claude
// hook shape it documents (hooks: {Event: [{matcher, hooks:[{type, command}]}]}).
function installGemini(settings, emitPath = EMIT_SCRIPT) {
  const out = settings && typeof settings === 'object' ? { ...settings } : {};
  out.hooks = { ...(out.hooks || {}) };
  const ours = (c) => /emit\.js" /.test(c || '');
  const add = (ev, signal) => {
    const list = (out.hooks[ev] || []).map((h) => ({ ...h, hooks: (h.hooks || []).filter((hh) => !ours(hh.command)) })).filter((h) => h.hooks.length);
    list.push({ matcher: '', hooks: [{ type: 'command', command: `node "${emitPath}" ${signal} --source gemini` }] });
    out.hooks[ev] = list;
  };
  add('BeforeTool', 'tool-use'); add('AfterTool', 'tool-done'); add('AfterAgent', 'stop'); add('SessionStart', 'session-start'); add('SessionEnd', 'session-end');
  return out;
}

module.exports = { HOOK_EVENTS, OPTIONAL_EVENTS, install, isInstalled, cmd, installCursor, installCodex, installGemini, EMIT_SCRIPT };

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
