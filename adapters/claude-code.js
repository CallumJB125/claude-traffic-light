// Claude Code: hooks in ~/.claude/settings.json, one per event, each running
// hooks/set-status.js with the raw signal. What a signal means visually lives
// in the app's rules, so this list only changes when Claude Code grows an
// event. set-status.js is the runtime (host app, pid, subagents, the blocking
// PermissionRequest); it resolves signals through resolveSignal() below, the
// same step normalize() gives /hook/claude and `emit.js --adapter claude`.
const path = require('path');
const Runtime = require('./runtime.js');

const SCRIPT = 'set-status.js';

// PermissionRequest is opt-in (it changes how approvals reach you) and is the
// only hook that blocks: it waits up to 60s for the widget's answer.
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
const SIGNAL_OF = Object.fromEntries(HOOK_EVENTS.concat(OPTIONAL_EVENTS).map(([e, s]) => [e, s]));
const RAW_SIGNALS = new Set(Object.values(SIGNAL_OF));

// Ours: set-status.js in any form (old `node "…"`, colour-style, moved .app),
// plus the delegate.js entries very old installs registered on their own.
const isOurs = (command) => Runtime.runsScript(command, [SCRIPT, 'delegate.js']);

// Claude Code tags each Notification with notification_type. Types not listed
// (auth_success, elicitation_complete, …) are bookkeeping and leave the
// session's signal alone.
const NOTIFICATION_TYPES = {
  permission_prompt: 'permission-ask',
  elicitation_dialog: 'permission-ask',
  elicitation_url_dialog: 'permission-ask',
  idle_prompt: 'idle-nudge',
};

// Raw hook signal + payload → the signal the session machine steps with.
// { resolved (null = ignore), askKind, via }. askKind says what kind of ask a
// permission-ask is: 'request' (the blocking PermissionRequest hook),
// 'question' (AskUserQuestion) or 'notification' — only a notification ask
// can be a transient one the widget sits out.
function resolveSignal(signal, data) {
  const tool = (data && (data.tool_name || data.toolName)) || null;
  let resolved = signal;
  let via = signal;
  let askKind = null;
  if (signal === 'notification') {
    // A usage limit is spotted by its text whatever the type; older Claude
    // Code sends no type at all, so the text is the fallback there.
    const text = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
    const type = typeof data?.notification_type === 'string' ? data.notification_type : null;
    via = `notification/${type || 'regex'}`;
    if (/usage limit|rate limit|out of tokens|reached your (5-hour|weekly) limit|quota exceeded/.test(text)) resolved = 'limit-hit';
    else if (type) resolved = NOTIFICATION_TYPES[type] || null;
    else if (/permission|approve|allow|confirm/.test(text)) resolved = 'permission-ask';
    else resolved = 'idle-nudge';
    if (resolved === 'permission-ask') askKind = 'notification';
  }
  if (signal === 'permission-request') { resolved = 'permission-ask'; askKind = 'request'; }
  // AskUserQuestion blocks on the person until its PostToolUse: an ask, not work.
  if (signal === 'tool-use' && tool === 'AskUserQuestion') { resolved = 'permission-ask'; askKind = 'question'; via = 'tool-use/AskUserQuestion'; }
  // After an auto-compaction mid-turn Claude carries straight on, so that
  // SessionStart is the compaction, not a new start.
  if (signal === 'session-start' && data?.source === 'compact') { resolved = 'compact'; via = 'session-start/compact'; }
  return { resolved, askKind, via, tool };
}

// event: a Claude Code hook event name (PreToolUse…) or a raw signal.
function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const raw = SIGNAL_OF[event] || (RAW_SIGNALS.has(event) ? event : null) || SIGNAL_OF[d.hook_event_name] || null;
  if (!raw) return [];
  const r = resolveSignal(raw, d);
  if (!r.resolved) return [];
  const sessionId = d.session_id || d.sessionId || null;
  const fromSubagent = (/^tool-/.test(r.resolved) || r.resolved === 'permission-denied') && !!d.agent_id;
  return [{ signal: r.resolved, sessionId, cwd: d.cwd || null, tool: r.tool, pid: null, extra: { raw, askKind: r.askKind, via: r.via, fromSubagent } }];
}

// A widget answer → what the PermissionRequest hook prints for Claude Code.
function answer(decision) {
  if (decision !== 'allow' && decision !== 'deny') return null;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from the Claude Traffic Light widget' } } };
}

function commandFor(event, runtime) {
  const signal = SIGNAL_OF[event];
  return signal ? Runtime.shellCommand(runtime, Runtime.script(runtime, SCRIPT), [signal]) : null;
}

const eventsFor = (opts = {}) => (opts.askFromWidget ? HOOK_EVENTS.concat(OPTIONAL_EVENTS) : HOOK_EVENTS);

// Pure: settings object in, settings object out, with exactly one current set
// of our hooks and every foreign one kept.
function apply(settings, runtime, opts = {}) {
  const out = { ...(settings || {}) };
  out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
  for (const [event, , timeout] of eventsFor(opts)) {
    const hook = { type: 'command', command: commandFor(event, runtime) };
    if (timeout) hook.timeout = timeout;
    out.hooks[event] = (out.hooks[event] || []).concat([{ matcher: '', hooks: [hook] }]);
  }
  return out;
}

function strip(settings) {
  const out = { ...(settings || {}) };
  out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function check(settings, runtime, opts = {}) {
  const has = (event) => (settings?.hooks?.[event] || []).some((h) => h.hooks?.some((hh) => hh.command === commandFor(event, runtime)));
  return HOOK_EVENTS.every(([e]) => has(e)) && OPTIONAL_EVENTS.every(([e]) => has(e) === !!opts.askFromWidget);
}

const configPath = (home) => path.join(home, '.claude', 'settings.json');

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  capabilities: { working: true, yourTurn: true, blocked: true, answer: true, subagents: true, limits: true, cost: true },
  transport: 'command',
  SCRIPT,
  HOOK_EVENTS,
  OPTIONAL_EVENTS,
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.claude')),
  isOurs,
  commandFor,
  apply,
  strip,
  check,
  resolveSignal,
  normalize,
  answer,
  install({ home, runtime, askFromWidget = false, fs: fsImpl }) {
    const file = configPath(home);
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeJsonConfig(file, apply(Runtime.readJsonConfig(file, fsImpl), runtime, { askFromWidget }), fsImpl);
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl }) {
    const file = configPath(home);
    const cur = Runtime.readJsonConfig(file, fsImpl);
    if (!cur.hooks) return { ok: true, file, changed: false };
    Runtime.writeJsonConfig(file, strip(cur), fsImpl);
    return { ok: true, file, changed: true };
  },
  isInstalled({ home, runtime, askFromWidget = false, fs: fsImpl }) {
    try { return check(Runtime.readJsonConfig(configPath(home), fsImpl), runtime, { askFromWidget }) && Runtime.wrapperPresent(runtime, {}, fsImpl || undefined); } catch { return false; }
  },
};
