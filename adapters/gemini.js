// Gemini CLI: ~/.gemini/settings.json, best effort. Mirrors the Claude hook
// shape it documents (hooks: {Event: [{matcher, hooks:[{type, command}]}]});
// the payload arrives on stdin (session_id, cwd, tool_name).
const path = require('path');
const Runtime = require('./runtime.js');

const EVENTS = [['BeforeTool', 'tool-use'], ['AfterTool', 'tool-done'], ['AfterAgent', 'stop'], ['SessionStart', 'session-start'], ['SessionEnd', 'session-end']];
const SIGNAL_OF = Object.fromEntries(EVENTS);

// Old `node "…/emit.js" <signal> --source gemini` and the current `--adapter gemini`.
const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && /--source gemini\b|--adapter gemini\b/.test(String(command || ''));

function commandFor(event, runtime) {
  return SIGNAL_OF[event] ? Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'gemini', event]) : null;
}

function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const signal = SIGNAL_OF[event] || SIGNAL_OF[d.hook_event_name] || null;
  if (!signal) return [];
  return [{ signal, sessionId: d.session_id || d.sessionId || null, cwd: d.cwd || null, tool: /^tool-/.test(signal) ? (d.tool_name || null) : null, pid: null, extra: {} }];
}

// opts.strip: which of ours are replaced, where they stand (the rename's
// re-point); without it every one of ours goes and the current set is appended.
function apply(settings, runtime, opts = {}) {
  const out = { ...(settings && typeof settings === 'object' ? settings : {}) };
  const wanted = EVENTS.map(([event]) => [event, { type: 'command', command: commandFor(event, runtime) }]);
  if (opts.strip) {
    out.hooks = Runtime.repointMatcherHooks(out.hooks, opts.strip, wanted);
    return out;
  }
  out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
  for (const [event, hook] of wanted) out.hooks[event] = (out.hooks[event] || []).concat([{ matcher: '', hooks: [hook] }]);
  return out;
}

function strip(settings) {
  const out = { ...(settings && typeof settings === 'object' ? settings : {}) };
  out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function check(settings, runtime) {
  return EVENTS.every(([event]) => (settings?.hooks?.[event] || []).some((h) => h.hooks?.some((hh) => hh.command === commandFor(event, runtime))));
}

const configPath = (home) => path.join(home, '.gemini', 'settings.json');

module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',
  capabilities: { working: true, yourTurn: true, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  EVENTS,
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.gemini')),
  isOurs,
  commandFor,
  apply,
  strip,
  check,
  normalize,
  install({ home, runtime, fs: fsImpl }) {
    const file = configPath(home);
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeJsonConfig(file, apply(Runtime.readJsonConfig(file, fsImpl), runtime), fsImpl);
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl }) {
    const file = configPath(home);
    Runtime.writeJsonConfig(file, strip(Runtime.readJsonConfig(file, fsImpl)), fsImpl);
    return { ok: true, file };
  },
  isInstalled({ home, runtime, fs: fsImpl }) {
    try { return check(Runtime.readJsonConfig(configPath(home), fsImpl), runtime) && Runtime.wrapperPresent(runtime, {}, fsImpl || undefined); } catch { return false; }
  },
};
