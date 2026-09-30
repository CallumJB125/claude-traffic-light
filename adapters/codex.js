// Codex CLI: ~/.codex/config.toml — a top-level `notify` array Codex runs
// with the event JSON as its last argument. An argv array can't carry an
// `ENV=1` prefix, so on macOS/Linux the command is the generated wrapper
// script, which sets ELECTRON_RUN_AS_NODE and execs the app binary; on
// Windows it is the exe with --buddy-hook (see runtime.js).
//
// Codex runs exactly one notify command, and other tools (Codex Computer
// Use, …) use it too, so one that isn't Buddy's is never replaced: install
// returns { error } and leaves the file alone.
const path = require('path');
const fs = require('fs');
const Runtime = require('./runtime.js');

const tomlString = (s) => JSON.stringify(String(s));

function commandFor(_event, runtime) {
  return Runtime.argvCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'codex']);
}

const notifyLine = (runtime) => `notify = [${commandFor('notify', runtime).map(tomlString).join(', ')}]`;

// Ours: the old ["node", ".../emit.js", "--codex"] and the current
// [..., ".../emit.js", "--adapter", "codex"].
const isOurs = (line) => /emit\.js",\s*("--codex"|"--adapter",\s*"codex")\s*\]\s*$/.test(String(line || ''));

// Top-level keys come before the first [table] header.
function topNotify(lines) {
  const tableAt = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = tableAt < 0 ? lines.length : tableAt;
  return lines.slice(0, top).findIndex((l) => /^\s*notify\s*=/.test(l));
}

// Pure: → { text } or { error } (a foreign notify is in the way).
function apply(tomlText, runtime) {
  const lines = String(tomlText || '').split('\n');
  const at = topNotify(lines);
  if (at >= 0 && !isOurs(lines[at])) {
    return { error: `${lines[at].trim().slice(0, 120)} is already set, and Codex runs only one notify command. Buddy left it alone; remove that line yourself to let Buddy use it instead.` };
  }
  const rest = at >= 0 ? lines.filter((_, i) => i !== at) : lines;
  return { text: [notifyLine(runtime), ...rest].join('\n').replace(/\n+$/, '') + '\n' };
}

function strip(tomlText) {
  const lines = String(tomlText || '').split('\n');
  const at = topNotify(lines);
  if (at < 0 || !isOurs(lines[at])) return String(tomlText || '');
  return lines.filter((_, i) => i !== at).join('\n');
}

function check(tomlText, runtime) {
  const lines = String(tomlText || '').split('\n');
  const at = topNotify(lines);
  return at >= 0 && lines[at].trim() === notifyLine(runtime);
}

// Codex notify JSON: { type: 'agent-turn-complete', 'thread-id', cwd, … }.
function normalize(_event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  return [{ signal: d.type === 'agent-turn-complete' ? 'stop' : 'tool-use', sessionId: d['thread-id'] || d.thread_id || d.session_id || null, cwd: d.cwd || null, tool: null, pid: null, extra: {} }];
}

const configPath = (home) => path.join(home, '.codex', 'config.toml');
const readText = (file, fsImpl) => { try { return fsImpl.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; } };

module.exports = {
  id: 'codex',
  label: 'Codex CLI',
  capabilities: { working: false, yourTurn: true, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.codex')),
  isOurs,
  commandFor,
  notifyLine,
  apply,
  strip,
  check,
  normalize,
  install({ home, runtime, fs: fsImpl = fs }) {
    const file = configPath(home);
    const r = apply(readText(file, fsImpl), runtime);
    if (r.error) return { ok: false, file, error: r.error };
    if (Runtime.argvNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, r.text);
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl = fs }) {
    const file = configPath(home);
    const cur = readText(file, fsImpl);
    const next = strip(cur);
    if (next !== cur) fsImpl.writeFileSync(file, next);
    return { ok: true, file, changed: next !== cur };
  },
  isInstalled({ home, runtime, fs: fsImpl = fs }) {
    try { return check(readText(configPath(home), fsImpl), runtime) && Runtime.wrapperPresent(runtime, { argv: true }, fsImpl); } catch { return false; }
  },
};
