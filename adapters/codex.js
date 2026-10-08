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

// Additive lifecycle hooks. notify remains a separate, backwards-compatible
// TOML API: installing activity must never replace somebody else's notify.
const LIFECYCLE_VERSION = 1;
const LIFECYCLE_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
const ACTIVITY_MARKER = 'Plexiform Codex activity v1';
const ID = /^[A-Za-z0-9_.-]{1,120}$/;
const TURN_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const SIGNALS = { SessionStart: 'session-start', UserPromptSubmit: 'prompt-submit', PreToolUse: 'tool-use', PostToolUse: 'tool-done', PermissionRequest: 'permission-ask', Stop: 'stop', Interrupt: 'idle-nudge', SessionEnd: 'session-end', SubagentStart: 'subagent-start', SubagentStop: 'subagent-done' };
const lifecycleConfigPath = (home) => path.join(home, '.codex', 'hooks.json');
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function lifecycleCommandFor(event, runtime) {
  if (!LIFECYCLE_EVENTS.includes(event)) throw new Error('Unsupported Codex lifecycle event');
  const script = Runtime.script(runtime, 'emit.js');
  const args = ` --adapter codex --lifecycle ${event}`;
  if (runtime.platform === 'win32') {
    // These values are app-owned paths, not event inputs. cmd expansion in a
    // quoted path is still unsafe: refuse it rather than weakening quoting.
    const runner = runtime.node ? 'node' : Runtime.wrapperPath(runtime);
    if ([runner, script, runtime.execPath || ''].some((v) => /[%!"\r\n]/.test(v))) throw new Error('Unsupported characters in Codex hook runtime paths');
    return `${runtime.node ? runner : `"${runner}"`} "${script}"${args}`;
  }
  if ([script, runtime.execPath || ''].some((v) => /[\0\r\n]/.test(v))) throw new Error('Unsupported characters in Codex hook runtime paths');
  return runtime.node ? `node ${shQuote(script)}${args}` : `ELECTRON_RUN_AS_NODE=1 ${shQuote(runtime.execPath)} ${shQuote(script)}${args}`;
}

function activityHook(event, runtime) {
  return { type: 'command', command: lifecycleCommandFor(event, runtime), timeout: 3, statusMessage: ACTIVITY_MARKER };
}

function validateActivity(config) {
  if (!object(config)) throw new Error('Codex hooks configuration is not an object');
  if (config.hooks === undefined) return;
  if (!object(config.hooks)) throw new Error('Codex hooks configuration has an invalid hooks object');
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups)) throw new Error('Codex hooks configuration has an invalid event group');
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks) || group.hooks.some((h) => !object(h))) throw new Error('Codex hooks configuration has an invalid handler group');
    }
  }
}

// An exact generated handler shape and closed command suffix, not the legacy
// broad emit.js predicate. Foreign commands/extra handler metadata stay.
function isActivityOurs(hook, event) {
  if (!object(hook) || !LIFECYCLE_EVENTS.includes(event) || Object.keys(hook).sort().join(',') !== 'command,statusMessage,timeout,type'
      || hook.type !== 'command' || hook.timeout !== 3 || hook.statusMessage !== ACTIVITY_MARKER || typeof hook.command !== 'string') return false;
  const suffix = ` --adapter codex --lifecycle ${event}`;
  if (!hook.command.endsWith(suffix)) return false;
  const prefix = hook.command.slice(0, -suffix.length);
  // Only command forms emitted above, with a quoted absolute hooks/emit.js.
  const posixWord = "'(?:[^'\\x00\\r\\n]|'\\\\'')*'";
  const posix = new RegExp(`^(?:node|ELECTRON_RUN_AS_NODE=1 ${posixWord}) (${posixWord})$`).exec(prefix);
  if (posix) {
    const script = posix[1].slice(1, -1).replace(/'\\''/g, "'");
    return script.startsWith('/') && script.endsWith('/hooks/emit.js');
  }
  const win = /^(node|"([^"%!\r\n]+)") "([^"%!\r\n]+)"$/.exec(prefix);
  const absolute = (v) => /^[A-Za-z]:\\/.test(v) || /^\\\\[^\\]+\\[^\\]+\\/.test(v);
  return !!win && absolute(win[3]) && win[3].endsWith('\\hooks\\emit.js')
    && (win[1] === 'node' || (absolute(win[2]) && win[2].endsWith('\\bin\\buddy-hook.cmd')));
}

function stripActivity(config) {
  validateActivity(config);
  const hooks = Object.create(null);
  for (const [event, groups] of Object.entries(config.hooks || {})) {
    const kept = [];
    for (const group of groups) {
      const handlers = group.hooks.filter((h) => !isActivityOurs(h, event));
      if (handlers.length === group.hooks.length) kept.push(group);
      else if (handlers.length) kept.push({ ...group, hooks: handlers });
      else if (Object.keys(group).some((k) => !['matcher', 'hooks'].includes(k))) kept.push({ ...group, hooks: [] });
    }
    if (kept.length || groups.length === 0) hooks[event] = kept;
  }
  return { ...config, hooks };
}

function checkActivity(config, runtime) {
  validateActivity(config);
  return LIFECYCLE_EVENTS.every((event) => {
    const matches = (config.hooks?.[event] || []).flatMap((g) => g.hooks.map((h) => ({ g, h }))).filter(({ h }) => isActivityOurs(h, event));
    return matches.length === 1 && (!matches[0].g.matcher || matches[0].g.matcher === '')
      && Object.entries(activityHook(event, runtime)).every(([k, v]) => matches[0].h[k] === v);
  });
}

function applyActivity(config, runtime) {
  validateActivity(config);
  if (checkActivity(config, runtime)) return config;
  const next = stripActivity(config);
  for (const event of LIFECYCLE_EVENTS) next.hooks[event] = [...(next.hooks[event] || []), { hooks: [activityHook(event, runtime)] }];
  return next;
}

function activitySnapshot(file, fsImpl) {
  let stat;
  try { stat = fsImpl.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { text: '', data: {}, target: file, stat: null }; throw e; }
  const target = fsImpl.realpathSync(file); // A dangling symlink must not be replaced.
  stat = fsImpl.statSync(target);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Codex hooks configuration is not a bounded regular file');
  // Inspect the opened descriptor before data reads, including a raced FIFO
  // on POSIX. These are ordinary trusted config fixtures, not the Windows
  // native private-reader boundary or an atomic filesystem/security lease.
  const same = (a, b) => ['dev', 'ino', 'mtimeMs', 'ctimeMs', 'size'].every((k) => a[k] === b[k]);
  const fd = fsImpl.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  let text;
  try {
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || opened.size > 2 * 1024 * 1024 || !same(stat, opened)) throw new Error('Codex hooks configuration changed; review it again');
    const bytes = Buffer.alloc(opened.size);
    for (let off = 0; off < bytes.length;) {
      const n = fsImpl.readSync(fd, bytes, off, Math.min(65536, bytes.length - off), off);
      if (!Number.isInteger(n) || n <= 0) throw new Error('Codex hooks configuration changed; review it again');
      off += n;
    }
    const after = fsImpl.fstatSync(fd);
    if (!same(opened, after) || !same(opened, fsImpl.statSync(target))) throw new Error('Codex hooks configuration changed; review it again');
    stat = after; text = bytes.toString('utf8');
  } finally { fsImpl.closeSync(fd); }
  const data = Runtime.parseJsonConfig(text, file);
  validateActivity(data);
  return { text, data, target, stat };
}

function writeActivity(file, snapshot, next, fsImpl) {
  const current = activitySnapshot(file, fsImpl);
  if (current.target !== snapshot.target || current.text !== snapshot.text || !!current.stat !== !!snapshot.stat
      || (current.stat && ['dev', 'ino', 'mtimeMs', 'size'].some((k) => current.stat[k] !== snapshot.stat[k]))) throw new Error('Codex hooks configuration changed; review it again');
  const text = snapshot.text ? Runtime.jsonTextLike(snapshot.text, next) : JSON.stringify(next, null, 2) + '\n';
  if (!Runtime.writeTextAtomic(snapshot.target, text, fsImpl, snapshot.stat?.mtimeMs ?? null, { newMode: 0o600 })) throw new Error('Codex hooks configuration changed; review it again');
}

function installActivity({ home, runtime, fs: fsImpl = fs }) {
  const file = lifecycleConfigPath(home);
  try {
    const cur = activitySnapshot(file, fsImpl);
    const next = applyActivity(cur.data, runtime);
    const changed = next !== cur.data;
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    if (changed) writeActivity(file, cur, next, fsImpl);
    return { ok: true, file, changed };
  } catch (err) { return { ok: false, file, changed: false, error: err.message }; }
}

function uninstallActivity({ home, fs: fsImpl = fs }) {
  const file = lifecycleConfigPath(home);
  try {
    const cur = activitySnapshot(file, fsImpl);
    const next = stripActivity(cur.data);
    const changed = JSON.stringify(next) !== JSON.stringify(cur.data) && !!cur.stat;
    if (changed) writeActivity(file, cur, next, fsImpl);
    return { ok: true, file, changed };
  } catch (err) { return { ok: false, file, changed: false, error: err.message }; }
}

function isActivityInstalled({ home, runtime, fs: fsImpl = fs }) {
  try { return checkActivity(activitySnapshot(lifecycleConfigPath(home), fsImpl).data, runtime) && Runtime.wrapperPresent(runtime, {}, fsImpl); } catch { return false; }
}

function normalizeLifecycle(event, d) {
  if (!object(d) || d.hook_event_name !== event || typeof d.session_id !== 'string' || !ID.test(d.session_id) || typeof d.cwd !== 'string' || !d.cwd || d.cwd.length > 500 || /[\0\r\n]/.test(d.cwd)) return [];
  if (!['SessionStart', 'SessionEnd'].includes(event) && (typeof d.turn_id !== 'string' || !TURN_ID.test(d.turn_id))) return [];
  if ((event.startsWith('Subagent') || d.agent_id !== undefined) && (typeof d.agent_id !== 'string' || !ID.test(d.agent_id))) return [];
  if (d.agent_id !== undefined && !['SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(event)) return [];
  if (event === 'SessionStart' && !['startup', 'resume', 'clear', 'compact', 'fork'].includes(d.source)) return [];
  // Exact local function identities only; never inspect question or reply text.
  const inputKind = new Map([['request_user_input', 'sync'], ['functions.request_user_input', 'sync'],
    ['request_user_input_async', 'async'], ['functions.request_user_input_async', 'async']]).get(d.tool_name) || null;
  const inputId = inputKind && typeof d.tool_use_id === 'string' && TURN_ID.test(d.tool_use_id) ? d.tool_use_id : null;
  const tool = ['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(event)
    ? (new Map([['Bash', 'Bash'], ['exec_command', 'Bash'], ['write_stdin', 'Bash'], ['apply_patch', 'Edit']]).get(d.tool_name) || (typeof d.tool_name === 'string' && /^mcp__/.test(d.tool_name) ? 'MCP tool' : 'Tool')) : null;
  return [{ signal: event === 'SessionStart' && d.source === 'compact' ? 'compact' : SIGNALS[event], sessionId: d.session_id,
    cwd: d.cwd, tool, pid: null, extra: {}, codexLifecycle: LIFECYCLE_VERSION, codexEvent: event,
    codexTurnId: typeof d.turn_id === 'string' && TURN_ID.test(d.turn_id) ? d.turn_id : null, codexAgentId: d.agent_id || null,
    codexSessionSource: event === 'SessionStart' ? d.source : null,
    codexInputKind: ['PreToolUse', 'PostToolUse'].includes(event) && inputId ? inputKind : null,
    codexToolUseId: ['PreToolUse', 'PostToolUse'].includes(event) ? inputId : null }];
}

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
  if (LIFECYCLE_EVENTS.includes(_event)) return normalizeLifecycle(_event, payload);
  const d = payload && typeof payload === 'object' ? payload : {};
  return [{ signal: d.type === 'agent-turn-complete' ? 'stop' : 'tool-use', sessionId: d['thread-id'] || d.thread_id || d.session_id || null, cwd: d.cwd || null, tool: null, pid: null, extra: {} }];
}

const configPath = (home) => path.join(home, '.codex', 'config.toml');
const readText = (file, fsImpl) => { try { return fsImpl.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; } };

module.exports = {
  id: 'codex',
  label: 'Codex CLI',
  capabilities: { working: true, yourTurn: true, blocked: true, answer: false, subagents: true, limits: false, cost: false },
  transport: 'command',
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.codex')),
  isOurs,
  commandFor,
  notifyLine,
  topNotify,
  apply,
  strip,
  check,
  normalize,
  LIFECYCLE_VERSION, LIFECYCLE_EVENTS, lifecycleConfigPath, lifecycleCommandFor, isActivityOurs,
  validateActivity, applyActivity, stripActivity, checkActivity, installActivity, uninstallActivity, isActivityInstalled,
  install({ home, runtime, fs: fsImpl = fs }) {
    const file = configPath(home);
    const r = apply(readText(file, fsImpl), runtime);
    if (r.error) return { ok: false, file, error: r.error };
    if (Runtime.argvNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeTextAtomic(file, r.text, fsImpl);
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl = fs }) {
    const file = configPath(home);
    const cur = readText(file, fsImpl);
    const next = strip(cur);
    if (next !== cur) Runtime.writeTextAtomic(file, next, fsImpl);
    return { ok: true, file, changed: next !== cur };
  },
  isInstalled({ home, runtime, fs: fsImpl = fs }) {
    try { return check(readText(configPath(home), fsImpl), runtime) && Runtime.wrapperPresent(runtime, { argv: true }, fsImpl); } catch { return false; }
  },
};
