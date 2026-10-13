// Goose (block/goose): hooks ride on its Open Plugins layout. A user plugin
// lives in ~/.agents/plugins/<name>/ with plugin.json and hooks/hooks.json;
// Plexiform owns ~/.agents/plugins/plexiform/ outright and never edits any
// other plugin. hooks.json: { hooks: { <Event>: [{ hooks: [{ type:
// 'command', command, timeout }] }] } } (goose hooks guide). The payload
// arrives on stdin: event, session_id, working_dir, tool_name. Observe only:
// PreToolUse and Stop read a block decision from stdout, so emit prints
// nothing and goose carries on as it would without us.
const path = require('path');
const Runtime = require('./runtime.js');

const EVENTS = [
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'prompt-submit'],
  ['PreToolUse', 'tool-use'],
  ['PostToolUse', 'tool-done'],
  ['PostToolUseFailure', 'tool-failed'],
  ['Stop', 'stop'],
  ['SessionEnd', 'session-end'],
];
const SIGNAL_OF = Object.fromEntries(EVENTS);
const MANIFEST = { name: 'plexiform', version: '1.0.0', description: 'Session activity for Plexiform; no conversation content' };

const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && /--adapter goose\b/.test(String(command || ''));

function commandFor(event, runtime) {
  return SIGNAL_OF[event] ? Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'goose', event]) : null;
}

function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const ev = SIGNAL_OF[event] ? event : (SIGNAL_OF[d.event] ? d.event : null);
  if (!ev) return [];
  const signal = SIGNAL_OF[ev];
  return [{ signal, sessionId: d.session_id || d.sessionId || null, cwd: d.working_dir || d.cwd || null, tool: /^tool-/.test(signal) ? (d.tool_name || null) : null, pid: null, extra: {} }];
}

function apply(_current, runtime) {
  const hooks = {};
  for (const [event] of EVENTS) hooks[event] = [{ hooks: [{ type: 'command', command: commandFor(event, runtime), timeout: 10 }] }];
  return { hooks };
}

function check(data, runtime) {
  return EVENTS.every(([event]) => (data?.hooks?.[event] || []).some((g) => (g?.hooks || []).some((h) => h && h.command === commandFor(event, runtime))));
}

const pluginDir = (home) => path.join(home, '.agents', 'plugins', 'plexiform');
const configPath = (home) => path.join(pluginDir(home), 'hooks', 'hooks.json');
const manifestPath = (home) => path.join(pluginDir(home), 'plugin.json');

module.exports = {
  id: 'goose',
  label: 'Goose',
  capabilities: { working: true, yourTurn: true, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  ownFile: true,
  EVENTS,
  configPath,
  manifestPath,
  pluginDir,
  detect: ({ home, exists }) => exists(path.join(home, '.config', 'goose')) || exists(path.join(home, '.local', 'share', 'goose')),
  isOurs,
  commandFor,
  apply,
  strip: () => ({}),
  files: (home) => [configPath(home), manifestPath(home)],
  holdsOurs({ home, fs: fsImpl }) {
    try { return JSON.stringify(Runtime.readJsonConfig(configPath(home), fsImpl)).includes('--adapter ' + module.exports.id); } catch { return false; }
  },
  check,
  normalize,
  install({ home, runtime, fs: fsImpl }) {
    const file = configPath(home);
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeJsonConfig(manifestPath(home), MANIFEST, fsImpl);
    Runtime.writeJsonConfig(file, apply(null, runtime), fsImpl);
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl }) {
    const f = fsImpl || require('fs');
    const file = configPath(home);
    for (const p of [file, manifestPath(home)]) { try { f.rmSync(p, { force: true }); } catch { /* gone */ } }
    for (const d of [path.dirname(file), pluginDir(home)]) { try { f.rmdirSync(d); } catch { /* not empty or gone */ } }
    return { ok: true, file };
  },
  isInstalled({ home, runtime, fs: fsImpl }) {
    try { return check(Runtime.readJsonConfig(configPath(home), fsImpl), runtime) && Runtime.wrapperPresent(runtime, {}, fsImpl || undefined); } catch { return false; }
  },
};
