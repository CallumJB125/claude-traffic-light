// GitHub Copilot CLI: hooks are JSON files under ~/.copilot/hooks/, every
// file is loaded, so Plexiform keeps its own, ~/.copilot/hooks/plexiform.json,
// and never touches anyone else's. Shape (docs.github.com, CLI hooks
// reference): { version: 1, hooks: { <event>: [{ type: 'command', command,
// timeoutSec }] } }. The payload arrives on stdin in camelCase (sessionId,
// cwd, toolName). Observe only: preToolUse and permissionRequest can gate
// the agent from stdout, so emit prints nothing for them and Copilot asks
// the person as it always does.
const path = require('path');
const Runtime = require('./runtime.js');

const EVENTS = [
  ['sessionStart', 'session-start'],
  ['userPromptSubmitted', 'prompt-submit'],
  ['preToolUse', 'tool-use'],
  ['postToolUse', 'tool-done'],
  ['postToolUseFailure', 'tool-failed'],
  ['subagentStart', 'subagent-start'],
  ['subagentStop', 'subagent-done'],
  ['agentStop', 'stop'],
  ['notification', 'notification'],
  ['errorOccurred', 'turn-failed'],
  ['sessionEnd', 'session-end'],
];
const SIGNAL_OF = Object.fromEntries(EVENTS);

const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && /--adapter copilot\b/.test(String(command || ''));

function commandFor(event, runtime) {
  return SIGNAL_OF[event] ? Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'copilot', event]) : null;
}

function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const ev = SIGNAL_OF[event] ? event : null;
  if (!ev) return [];
  let signal = SIGNAL_OF[ev];
  const extra = {};
  if (signal === 'notification') {
    const type = typeof d.notification_type === 'string' ? d.notification_type : '';
    const text = typeof d.message === 'string' ? d.message.toLowerCase() : '';
    if (/limit|quota/.test(text)) signal = 'limit-hit';
    else if (/permission|elicitation/.test(type) || /permission|approve|allow|confirm/.test(text)) { signal = 'permission-ask'; extra.askKind = 'notification'; }
    else signal = 'idle-nudge';
  }
  const sessionId = d.sessionId || d.session_id || null;
  const cwd = d.cwd || null;
  const tool = /^tool-/.test(signal) ? (d.toolName || d.tool_name || null) : null;
  return [{ signal, sessionId, cwd, tool, pid: null, extra }];
}

// The whole file is Plexiform's: apply() returns the file as it should be.
function apply(_current, runtime) {
  const hooks = {};
  for (const [event] of EVENTS) hooks[event] = [{ type: 'command', command: commandFor(event, runtime), timeoutSec: 10 }];
  return { version: 1, hooks };
}

function check(data, runtime) {
  return EVENTS.every(([event]) => (data?.hooks?.[event] || []).some((h) => h && h.command === commandFor(event, runtime)));
}

const configPath = (home) => path.join(home, '.copilot', 'hooks', 'plexiform.json');

module.exports = {
  id: 'copilot',
  label: 'Copilot CLI',
  capabilities: { working: true, yourTurn: true, blocked: true, answer: false, subagents: true, limits: true, cost: false },
  transport: 'command',
  ownFile: true,
  EVENTS,
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.copilot')),
  isOurs,
  commandFor,
  apply,
  strip: () => ({}),
  files: (home) => [configPath(home)],
  holdsOurs({ home, fs: fsImpl }) {
    try { return JSON.stringify(Runtime.readJsonConfig(configPath(home), fsImpl)).includes('--adapter ' + module.exports.id); } catch { return false; }
  },
  check,
  normalize,
  install({ home, runtime, fs: fsImpl }) {
    const file = configPath(home);
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeJsonConfig(file, apply(null, runtime), fsImpl);
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl }) {
    const file = configPath(home);
    try { (fsImpl || require('fs')).rmSync(file, { force: true }); } catch { /* already gone */ }
    return { ok: true, file };
  },
  isInstalled({ home, runtime, fs: fsImpl }) {
    try { return check(Runtime.readJsonConfig(configPath(home), fsImpl), runtime) && Runtime.wrapperPresent(runtime, {}, fsImpl || undefined); } catch { return false; }
  },
};
