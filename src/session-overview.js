'use strict';

// Local session metadata only. Never forward a session object to this page:
// it may also contain tool, task, prompt, host or credential information.
const LIMIT = 100;
const CHILD_LIMIT = 64;
const Machine = require('../hooks/session-machine');
const RECENT_MS = 90_000;
const PROVIDERS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', 'claude-code': 'Claude Code', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes', opencode: 'OpenCode', copilot: 'Copilot' });
const STATUSES = Object.freeze({
  'session-start': 'Ready', 'prompt-submit': 'Working', 'tool-use': 'Working', 'tool-done': 'Working',
  'tool-failed': 'Working', 'permission-denied': 'Working', compact: 'Compacting',
  'permission-ask': 'Waiting on you', 'user-question': 'Waiting on you', 'question-ask': 'Waiting on you',
  'subagent-start': 'Working', 'subagent-done': 'Working', 'stop': 'Turn stopped', 'idle': 'Idle',
  'idle-nudge': 'Idle', 'turn-failed': 'Turn failed', 'limit-hit': 'Limit reached', 'session-end': 'Ended',
});
const CHILD_STATUSES = Object.freeze({ working: 'Working', waiting: 'Waiting on you', done: 'Stopped', stopped: 'Stopped', stale: 'Status unknown' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function elapsed(value, now) {
  const stamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) && stamp >= 0 && stamp <= now ? now - stamp : null;
}
function projectLeaf(value) {
  if (typeof value !== 'string') return 'Local project';
  const parts = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').split(/[\\/]/).filter(Boolean);
  const leaf = parts.at(-1);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0, 100) : 'Local project';
}
function isLocal(row) {
  return object(row) && !row.remote && !row.device && !(typeof row.sessionId === 'string' && row.sessionId.startsWith('remote:'));
}
// Optional per-row additions (Burst compaction and handover); the raw row never leaves.
function extras(enrich, row) {
  try { const burst = enrich ? enrich(row) : null; return burst ? { burst } : {}; } catch { return {}; }
}
// The local handover document's status for the row (src/session-handover.js).
function handoverOf(fn, row) {
  try { const h = fn ? fn(row) : null; return h ? { handover: h } : {}; } catch { return {}; }
}
// Opaque handle plus the attached/made card label and the repo share state (src/session-actions.js rowInfo).
function actionsOf(fn, row) {
  try { const a = fn ? fn(row) : null; return a ? { actions: { handle: String(a.handle), card: a.card ? { label: String(a.card.label).slice(0, 160), how: a.card.how === 'made' ? 'made' : 'attached' } : null, share: a.share ? { on: a.share.on === true } : null } } : {}; } catch { return {}; }
}
// Open hub collisions on the row's files (src/collision-alerts.js): text, path and the other record id.
function collisionsOf(fn, row) {
  try {
    const list = fn ? fn(row) : null;
    return Array.isArray(list) && list.length ? { collisions: list.slice(0, 5).map(c => ({ text: String(c.text).slice(0, 240), path: String(c.path).slice(0, 400), other: String(c.other).slice(0, 300) })) } : {};
  } catch { return {}; }
}
// The session id goes to the page only where a row action needs it: the context drawer
// (Claude Code, or a session Burst reports on) and Message (owned, or Burst coordination).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function sessionTools(row, more) {
  if (typeof row.sessionId !== 'string' || !SESSION_ID.test(row.sessionId)) return {};
  const claude = row.source == null || row.source === 'claude-code';
  const owned = row.ownership === 'plexiform-owned';
  const message = owned ? 'owned' : more.burst?.coordination ? 'burst' : null;
  const context = claude ? { engine: 'claude' } : row.source === 'codex' && more.burst ? { engine: 'codex' } : null;
  if (!message && !context) return {};
  return { session: row.sessionId, ...(context ? { context } : {}), ...(message ? { message } : {}) };
}
// Working trees two or more live sessions share while they hold uncommitted work (src/worktree-share.js).
function sharedOf(fn, rows) {
  try {
    const list = fn ? fn(rows) : [];
    return (Array.isArray(list) ? list : []).filter(t => object(t) && Array.isArray(t.sessions) && t.sessions.length > 1).slice(0, 20).map(t => ({
      project: projectLeaf(t.toplevel), sessions: t.sessions.length, dirty: Number.isSafeInteger(t.dirty) && t.dirty > 0 ? t.dirty : 0, ids: new Set(t.sessions),
    }));
  } catch { return []; }
}
function snapshot({ sessions = [], activity = {}, available = true, now = Date.now(), enrich = null, handover = null, info = null, sharedTrees = null, collisions = null } = {}) {
  const time = Number.isFinite(now) && now >= 0 ? now : Date.now();
  let latest = null, omitted = 0;
  const rows = [];
  const input = Array.isArray(sessions) ? sessions : [];
  const trees = sharedOf(sharedTrees, input.filter(isLocal));
  // The app's bounded session store is the source; no provider chats or
  // private provider state is consulted here, including for freshness.
  for (const row of input) {
    if (!isLocal(row)) continue;
    const lifecycle = row.source === 'codex' && row.codexLifecycle === 1;
    const age = elapsed(lifecycle ? row.codexHookAt : row.updatedAt, time);
    if (lifecycle && age !== null && (latest === null || age < latest)) latest = age;
    if (rows.length >= LIMIT) { omitted++; continue; }
    const rawChildren = lifecycle ? row.codexAgents : Machine.withFreshAgents(row, time).agents;
    const presented = Machine.effectiveSignal({ ...row, agents: lifecycle ? row.agents : rawChildren, signal: row.signal }).signal;
    const children = Array.isArray(rawChildren) ? rawChildren.filter(child => object(child) && typeof child.status === 'string' && Object.hasOwn(CHILD_STATUSES, child.status)).slice(0, CHILD_LIMIT).map((child, index) => ({
      label: `${lifecycle ? 'Codex subagent' : 'Agent'} ${index + 1}`, status: lifecycle && row.codexClosedTurn === false && child.status !== 'done' && Machine.codexInputPending({ source: 'codex', codexLifecycle: 1, codexTurnId: child.turnId, codexClosedTurn: false, codexInputRequests: child.codexInputRequests }, time) ? 'Waiting on you' : CHILD_STATUSES[child.status],
    })) : [];
    const stuck = object(row.stuck) && Number.isFinite(row.stuck.sinceMs) ? row.stuck : null;
    const more = extras(enrich, row);
    const tree = trees.find(t => t.ids.has(row.sessionId));
    rows.push({
      // Claude Code's own hook (set-status.js) writes no source field.
      provider: row.source == null ? PROVIDERS.claude : typeof row.source === 'string' && Object.hasOwn(PROVIDERS, row.source) ? PROVIDERS[row.source] : 'Local AI',
      project: projectLeaf(row.cwd),
      status: lifecycle && row.codexClosedTurn === true ? 'Turn stopped' : Machine.claudeInputPending(row) || Machine.codexInputPending(row, time) ? 'Waiting on you' : stuck ? 'Stuck?' : typeof presented === 'string' && Object.hasOwn(STATUSES, presented) ? STATUSES[presented] : 'Unknown',
      ...(stuck ? { stuck: { tool: stuck.tool || null, since_ms: stuck.sinceMs } } : {}),
      freshness: available === false || age === null ? 'unknown' : age <= RECENT_MS ? 'recent' : 'stale', age_ms: age, lifecycle, children,
      ...more,
      ...sessionTools(row, more),
      ...(tree && !more.burst?.coordination ? { sharedTree: tree.project } : {}),
      ...handoverOf(handover, row),
      ...actionsOf(info, row),
      ...collisionsOf(collisions, row),
    });
  }
  rows.sort((a, b) => (a.age_ms ?? Infinity) - (b.age_ms ?? Infinity));
  return {
    observed_at: time,
    status: available === false || !Array.isArray(sessions) ? 'unavailable' : omitted ? 'partial' : 'complete', omitted,
    activity: { configured: activity.available === false ? null : typeof activity.configured === 'boolean' ? activity.configured : null,
      observed: latest !== null, latest_age_ms: latest }, sessions: rows,
    ...(trees.length ? { shared: trees.map(({ project, sessions: n, dirty }) => ({ project, sessions: n, dirty })) } : {}),
  };
}
module.exports = { snapshot, RECENT_MS, LIMIT, CHILD_LIMIT };
