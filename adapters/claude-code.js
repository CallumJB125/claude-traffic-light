// Claude Code: hooks in ~/.claude/settings.json, one per event, each running
// hooks/set-status.js with the raw signal. What a signal means visually lives
// in the app's rules, so this list only changes when Claude Code grows an
// event. set-status.js is the runtime (host app, pid, subagents, the blocking
// PermissionRequest); it resolves signals through resolveSignal() below, the
// same step normalize() gives /hook/claude and `emit.js --adapter claude`.
//
// Limitation: /hook/claude and `emit.js --adapter claude` go through
// applyBareSignal, which records less than set-status.js (no host app, model,
// subagent list, cost, or PermissionRequest answer). The app's installs
// always run set-status.js; only reporter mode (hooks/remote.js), whose
// sessions show on another machine, installs `emit.js --adapter claude`.
const fs = require('fs');
const path = require('path');
const Runtime = require('./runtime.js');

const SCRIPT = 'set-status.js';

// PermissionRequest and Elicitation are opt-in (they change how approvals and
// MCP input requests reach you) and block: each waits up to 60s for the
// widget's answer. (AskUserQuestion's PreToolUse waits too, when the same
// askFromWidget switch is on; see set-status.js.)
const OPTIONAL_EVENTS = [['PermissionRequest', 'permission-request', 60], ['Elicitation', 'elicitation', 60]];
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

// Defence in depth for the answer protocol (hooks/answer-file.js): the agent's
// own file tools may never write Buddy's state dir, requests/ included. One
// `Edit(path)` rule covers every built-in file-editing tool (Write, MultiEdit,
// NotebookEdit): Claude Code only consults Edit/Read path rules and ignores a
// `Write(path)` one (code.claude.com/docs/en/permissions#read-and-edit);
// `~/path` is the documented home-relative form, `//path` the absolute one.
// The state dir is the app's (runtime.dataDir = CLAUDE_TRAFFIC_LIGHT_HOME or
// ~/.claude-traffic-light); DENY_RULES is the default install's.
const DENY_RULES = ['Edit(~/.claude-traffic-light/**)'];
function denyRulesFor(home, runtime) {
  const root = path.resolve(runtime?.dataDir || process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(home, '.claude-traffic-light'));
  const rel = path.relative(path.resolve(home), root);
  const inHome = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return [`Edit(${inHome ? `~/${rel.split(path.sep).join('/')}` : `/${root.split(path.sep).join('/')}`}/**)`];
}
const rulesOf = (opts) => (opts?.home ? denyRulesFor(opts.home, opts.runtime) : DENY_RULES);

// A permissions block or deny list that isn't the documented shape (object,
// array) is the person's to fix: Buddy adds nothing rather than replace it.
function denyShapeProblem(settings) {
  const p = settings?.permissions;
  if (p === undefined) return null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'permissions is not an object';
  if (p.deny !== undefined && !Array.isArray(p.deny)) return 'permissions.deny is not a list';
  return null;
}

function withDenyRules(settings, rules = DENY_RULES) {
  const out = { ...(settings || {}) };
  const problem = denyShapeProblem(out);
  if (problem) {
    console.warn(`[claude-code] ${problem}: Buddy's deny rule ${rules.join(', ')} was not added; fix the settings file to protect Buddy's state from the agent's file tools.`);
    return out;
  }
  const perms = { ...(out.permissions || {}) };
  const deny = Array.isArray(perms.deny) ? perms.deny.slice() : [];
  for (const r of rules) if (!deny.includes(r)) deny.push(r);
  out.permissions = { ...perms, deny };
  return out;
}

// Removes exactly `rules` (the ones Buddy recorded adding), nothing else.
function withoutDenyRules(settings, rules = DENY_RULES) {
  const out = { ...(settings || {}) };
  if (denyShapeProblem(out) || !out.permissions || !Array.isArray(out.permissions.deny)) return out;
  const perms = { ...out.permissions, deny: out.permissions.deny.filter((r) => !rules.includes(r)) };
  if (!perms.deny.length) delete perms.deny;
  if (Object.keys(perms).length) out.permissions = perms;
  else delete out.permissions;
  return out;
}

const hasDenyRules = (settings, rules = DENY_RULES) => rules.every((r) => Array.isArray(settings?.permissions?.deny) && settings.permissions.deny.includes(r));

// Which deny rules Buddy itself added to which settings file, so uninstall
// never removes the same rule the person had written first. Kept in Buddy's
// state dir (which the rule protects).
function addedRecord(home, runtime, fsImpl = fs) {
  const file = path.join(runtime?.dataDir || process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(home, '.claude-traffic-light'), 'claude-deny-rules.json');
  let all = {};
  try { all = JSON.parse(fsImpl.readFileSync(file, 'utf8')) || {}; } catch {}
  return {
    get: (settingsFile) => (Array.isArray(all[settingsFile]) ? all[settingsFile].filter((r) => typeof r === 'string') : []),
    set(settingsFile, rules) {
      if (rules.length) all[settingsFile] = rules; else delete all[settingsFile];
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
  };
}

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
  if (signal === 'permission-request' || signal === 'elicitation') { resolved = 'permission-ask'; askKind = 'request'; }
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
// of our hooks and every foreign one kept. opts.strip narrows which of ours
// are replaced (the rename re-points only the old app's), and replaces them
// where they stand so the file's order stays.
function apply(settings, runtime, opts = {}) {
  const out = withDenyRules(settings, rulesOf({ ...opts, runtime }));
  const wanted = eventsFor(opts).map(([event, , timeout]) => {
    const hook = { type: 'command', command: commandFor(event, runtime) };
    if (timeout) hook.timeout = timeout;
    return [event, hook];
  });
  if (opts.strip) {
    out.hooks = Runtime.repointMatcherHooks(out.hooks, opts.strip, wanted);
    return out;
  }
  out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
  for (const [event, hook] of wanted) out.hooks[event] = (out.hooks[event] || []).concat([{ matcher: '', hooks: [hook] }]);
  return out;
}

// opts.denyRules: the deny rules to remove (uninstall passes the ones Buddy
// recorded adding).
function strip(settings, opts = {}) {
  const out = withoutDenyRules(settings, opts.denyRules || DENY_RULES);
  out.hooks = Runtime.stripMatcherHooks(out.hooks, isOurs);
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function check(settings, runtime, opts = {}) {
  const has = (event) => (settings?.hooks?.[event] || []).some((h) => h.hooks?.some((hh) => hh.command === commandFor(event, runtime)));
  return HOOK_EVENTS.every(([e]) => has(e)) && OPTIONAL_EVENTS.every(([e]) => has(e) === !!opts.askFromWidget)
    && (hasDenyRules(settings, rulesOf({ ...opts, runtime })) || !!denyShapeProblem(settings));
}

const configPath = (home) => path.join(home, '.claude', 'settings.json');

// Only a rule that wasn't there before is Buddy's to remove later.
function noteAddedDenyRules({ home, runtime, file, before, after, fs: fsImpl }) {
  const had = Array.isArray(before.permissions?.deny) ? before.permissions.deny : [];
  const added = denyRulesFor(home, runtime).filter((r) => !had.includes(r) && hasDenyRules(after, [r]));
  if (!added.length) return;
  const rec = addedRecord(home, runtime, fsImpl || fs);
  rec.set(file, [...new Set(rec.get(file).concat(added))]);
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  capabilities: { working: true, yourTurn: true, blocked: true, answer: true, subagents: true, limits: true, cost: true },
  transport: 'command',
  SCRIPT,
  DENY_RULES,
  denyRulesFor,
  HOOK_EVENTS,
  OPTIONAL_EVENTS,
  configPath,
  detect: ({ home, exists }) => exists(path.join(home, '.claude')),
  isOurs,
  commandFor,
  apply,
  strip,
  check,
  noteAddedDenyRules,
  resolveSignal,
  normalize,
  answer,
  install({ home, runtime, askFromWidget = false, fs: fsImpl }) {
    const file = configPath(home);
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    const cur = Runtime.readJsonConfig(file, fsImpl);
    const rules = denyRulesFor(home, runtime);
    // First time Buddy adds its deny rules to an existing settings file, keep
    // a copy of the file as it was.
    if (!hasDenyRules(cur, rules) && Object.keys(cur).length) Runtime.backupOnce(file, fsImpl);
    const next = apply(cur, runtime, { askFromWidget, home });
    Runtime.writeJsonConfig(file, next, fsImpl);
    noteAddedDenyRules({ home, runtime, file, before: cur, after: next, fs: fsImpl });
    return { ok: true, file };
  },
  uninstall({ home, fs: fsImpl }) {
    const file = configPath(home);
    const cur = Runtime.readJsonConfig(file, fsImpl);
    const rec = addedRecord(home, null, fsImpl || fs);
    const ours = rec.get(file).filter((r) => hasDenyRules(cur, [r]));
    // A deny rule Buddy has no record of adding may be the person's own (or
    // from an install before the record existed): it stays, and we say so.
    const unsure = [...new Set(DENY_RULES.concat(denyRulesFor(home)))].filter((r) => hasDenyRules(cur, [r]) && !ours.includes(r));
    if (unsure.length) console.warn(`[claude-code] left ${unsure.join(', ')} in ${file}: Buddy has no record of adding it; remove it by hand if it was Buddy's.`);
    if (!cur.hooks && !ours.length) return { ok: true, file, changed: false };
    Runtime.writeJsonConfig(file, strip(cur, { denyRules: ours }), fsImpl);
    try { rec.set(file, []); } catch {}
    return { ok: true, file, changed: true };
  },
  isInstalled({ home, runtime, askFromWidget = false, fs: fsImpl }) {
    try { return check(Runtime.readJsonConfig(configPath(home), fsImpl), runtime, { askFromWidget, home }) && Runtime.wrapperPresent(runtime, {}, fsImpl || undefined); } catch { return false; }
  },
};
