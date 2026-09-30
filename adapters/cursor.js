// Cursor: ~/.cursor/hooks.json ({version:1, hooks:{event:[{command}]}}). The
// event name rides on the command line, the payload arrives on stdin, and the
// before* hooks expect a JSON reply on stdout.
const path = require('path');
const Runtime = require('./runtime.js');

const EVENTS = ['beforeSubmitPrompt', 'beforeShellExecution', 'beforeMCPExecution', 'afterFileEdit', 'stop'];
const SIGNALS = { beforeSubmitPrompt: 'prompt-submit', beforeShellExecution: 'tool-use', beforeMCPExecution: 'tool-use', afterFileEdit: 'tool-done', beforeReadFile: 'tool-use', stop: 'stop' };
const NEEDS_REPLY = new Set(['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'beforeSubmitPrompt']);

// Old `node "…/emit.js" --cursor <event>` and the current `--adapter cursor`.
const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && /emit\.js" --(cursor|adapter cursor) /.test(String(command || ''));

function commandFor(event, runtime) {
  return Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'cursor', event]);
}

function toolOf(event, d) {
  if (event === 'beforeShellExecution') return 'Bash';
  if (event === 'afterFileEdit') return 'Edit';
  if (event === 'beforeMCPExecution') return d.tool_name ? `mcp__${d.tool_name}` : 'mcp__tool';
  if (event === 'beforeReadFile') return 'Read';
  return null;
}

function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const signal = SIGNALS[event];
  if (!signal) return [];
  return [{ signal, sessionId: d.conversation_id || d.conversationId || null, cwd: d.workspace_roots?.[0] || d.cwd || null, tool: toolOf(event, d), pid: null, extra: {} }];
}

// "allow" keeps Cursor unblocked: Buddy watches, it never gates.
const reply = (event) => (NEEDS_REPLY.has(event) ? { permission: 'allow', continue: true } : null);

function strip(hooksJson) {
  const out = hooksJson && typeof hooksJson === 'object' ? { ...hooksJson } : {};
  out.version = out.version || 1;
  out.hooks = {};
  for (const [ev, list] of Object.entries((hooksJson && hooksJson.hooks) || {})) {
    const kept = (Array.isArray(list) ? list : []).filter((h) => !isOurs(h && h.command));
    if (kept.length) out.hooks[ev] = kept;
  }
  return out;
}

function apply(hooksJson, runtime) {
  const out = strip(hooksJson);
  for (const ev of EVENTS) out.hooks[ev] = (out.hooks[ev] || []).concat([{ command: commandFor(ev, runtime) }]);
  return out;
}

function check(hooksJson, runtime) {
  return EVENTS.every((ev) => (hooksJson?.hooks?.[ev] || []).some((h) => h && h.command === commandFor(ev, runtime)));
}

const configPath = (home) => path.join(home, '.cursor', 'hooks.json');

module.exports = {
  id: 'cursor',
  label: 'Cursor',
  capabilities: { working: true, yourTurn: true, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  EVENTS,
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.cursor')),
  isOurs,
  commandFor,
  apply,
  strip,
  check,
  normalize,
  reply,
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
