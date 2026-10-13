// OpenCode: plugins are JS modules loaded from ~/.config/opencode/plugins/
// (every file there), so Plexiform owns one file of its own,
// ~/.config/opencode/plugins/plexiform.js, and never edits another plugin.
// The plugin forwards a few hooks (opencode.ai/docs/plugins: event,
// tool.execute.before/after, chat.message) to emit.js --adapter opencode
// with a small JSON payload on stdin: { sessionID, tool, type, directory }.
// Observe only: it never throws from a hook (which would block the tool)
// and never answers permission.ask.
const fs = require('fs');
const path = require('path');
const Runtime = require('./runtime.js');

const MARKER = '// plexiform-opencode-plugin v1 (written by Plexiform; safe to delete)';
// event types the plugin forwards; everything else stays in OpenCode.
const EVENT_TYPES = ['session.created', 'session.idle', 'session.error', 'session.deleted', 'permission.asked'];
const HOOKS = ['event', 'tool.execute.before', 'tool.execute.after', 'chat.message'];

const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && /--adapter opencode\b/.test(String(command || ''));
const ourPlugin = (text) => typeof text === 'string' && text.includes(MARKER);

// The argv the plugin spawns (no shell: Bun's child_process takes an array).
const argvFor = (runtime) => Runtime.argvCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'opencode']);
// commandFor is the adapter contract; the plugin spawns argvFor + [hook].
const commandFor = (hook, runtime) => (HOOKS.includes(hook) ? [...argvFor(runtime), hook].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ') : null);

function pluginText(runtime) {
  return `${MARKER}
// Forwards session activity (ids, tool names, event types) to Plexiform on this
// computer. No prompts, file contents or model output leave OpenCode.
import { spawn } from "node:child_process";
const ARGV = ${JSON.stringify(argvFor(runtime))};
const TYPES = ${JSON.stringify(EVENT_TYPES)};
function send(hook, payload) {
  try {
    const child = spawn(ARGV[0], ARGV.slice(1).concat([hook]), { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  } catch {}
}
const sid = (p) => (p && (p.sessionID || (p.info && p.info.id))) || null;
export const PlexiformPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    const type = event && event.type;
    if (!TYPES.includes(type)) return;
    send("event", { type, sessionID: sid(event.properties), directory });
  },
  "tool.execute.before": async (input) => { send("tool.execute.before", { sessionID: input && input.sessionID, tool: input && input.tool, directory }); },
  "tool.execute.after": async (input) => { send("tool.execute.after", { sessionID: input && input.sessionID, tool: input && input.tool, directory }); },
  "chat.message": async (input) => { send("chat.message", { sessionID: input && input.sessionID, directory }); },
});
`;
}

function normalize(hook, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const base = { sessionId: typeof d.sessionID === 'string' ? d.sessionID : (d.sessionId || null), cwd: typeof d.directory === 'string' ? d.directory : (d.cwd || null), pid: null, extra: {} };
  if (hook === 'tool.execute.before') return [{ ...base, signal: 'tool-use', tool: typeof d.tool === 'string' ? d.tool : null }];
  if (hook === 'tool.execute.after') return [{ ...base, signal: 'tool-done', tool: typeof d.tool === 'string' ? d.tool : null }];
  if (hook === 'chat.message') return [{ ...base, signal: 'prompt-submit', tool: null }];
  if (hook !== 'event') return [];
  const t = d.type;
  if (t === 'session.created') return [{ ...base, signal: 'session-start', tool: null }];
  if (t === 'session.idle') return [{ ...base, signal: 'stop', tool: null }];
  if (t === 'session.error') return [{ ...base, signal: 'turn-failed', tool: null }];
  if (t === 'session.deleted') return [{ ...base, signal: 'session-end', tool: null }];
  if (t === 'permission.asked') return [{ ...base, signal: 'permission-ask', tool: null, extra: { askKind: 'request' } }];
  return [];
}

const configPath = (home) => path.join(home, '.config', 'opencode', 'plugins', 'plexiform.js');
const files = (home) => [configPath(home)];

function plan({ home, runtime, fs: fsImpl = fs }) {
  const file = configPath(home);
  let before = '';
  try { before = fsImpl.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (before && !ourPlugin(before)) throw new Error(`${file} exists and was not written by Plexiform, so it was left alone.`);
  return { files: [{ file, before, after: pluginText(runtime) }] };
}

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: { working: true, yourTurn: true, blocked: true, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  ownFile: true,
  text: true,
  MARKER,
  HOOKS,
  EVENT_TYPES,
  configPath,
  files,
  detect: ({ home, exists }) => exists(path.join(home, '.config', 'opencode')) || exists(path.join(home, '.local', 'share', 'opencode')),
  isOurs,
  commandFor,
  argvFor,
  pluginText,
  normalize,
  plan,
  holdsOurs({ home, fs: fsImpl = fs }) { try { return ourPlugin(fsImpl.readFileSync(configPath(home), 'utf8')); } catch { return false; } },
  install({ home, runtime, fs: fsImpl = fs }) {
    const p = plan({ home, runtime, fs: fsImpl });
    if (Runtime.argvNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeTextAtomic(p.files[0].file, p.files[0].after, fsImpl, undefined, { newMode: 0o644 });
    return { ok: true, file: p.files[0].file };
  },
  uninstall({ home, fs: fsImpl = fs }) {
    const file = configPath(home);
    try { if (ourPlugin(fsImpl.readFileSync(file, 'utf8'))) fsImpl.rmSync(file, { force: true }); } catch { /* gone */ }
    return { ok: true, file };
  },
  isInstalled({ home, runtime, fs: fsImpl = fs }) {
    try { return fsImpl.readFileSync(configPath(home), 'utf8') === pluginText(runtime) && Runtime.wrapperPresent(runtime, { argv: true }, fsImpl); } catch { return false; }
  },
};
