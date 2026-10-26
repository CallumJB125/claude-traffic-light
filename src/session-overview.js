'use strict';

// Local session metadata only. Never forward a session object to this page:
// it may also contain tool, task, prompt, host or credential information.
const LIMIT = 100;
const CHILD_LIMIT = 64;
const Machine = require('../hooks/session-machine');
const RECENT_MS = 90_000;
const PROVIDERS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', 'claude-code': 'Claude Code', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes', opencode: 'OpenCode', copilot: 'Copilot' });
// Claude Code's own hook (set-status.js) writes no source field; an unknown source reads as "Local AI".
const providerLabel = (row) => (row.source == null ? PROVIDERS.claude : typeof row.source === 'string' && Object.hasOwn(PROVIDERS, row.source) ? PROVIDERS[row.source] : 'Local AI');
const Organise = require('./work-organise');
// Status words come from the five buckets (work-organise.js). A detail is kept
// only where it says more than the bucket: it reads "Idle (ended)".
const DETAILS = Object.freeze({ compact: 'Compacting', 'limit-hit': 'Limit reached', 'turn-failed': 'Turn failed', 'session-end': 'Ended' });
const CHILD_SIGNALS = Object.freeze({ working: 'working', waiting: 'needs', done: 'idle', stopped: 'idle', stale: 'idle' });
const bucketed = (id, detail = null) => ({ bucket: id, status: Organise.BUCKETS.find((b) => b.id === id).heading, ...(detail ? { detail } : {}) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function elapsed(value, now) {
  const stamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) && stamp >= 0 && stamp <= now ? now - stamp : null;
}
// The folder's name, or the one fallback ("Other work"); never a path.
const projectName = (dir) => Organise.projectOf({ cwd: typeof dir === 'string' ? dir : null }).heading;
function sessionStatus(row, presented, stuck, time) {
  if (row.source === 'codex' && row.codexLifecycle === 1 && row.codexClosedTurn === true) return bucketed('check');
  if (Machine.claudeInputPending(row) || Machine.codexInputPending(row, time)) return bucketed('needs');
  if (stuck) return bucketed('stuck', 'Stuck');
  const signal = typeof presented === 'string' ? presented : '';
  return bucketed(Organise.bucketOf(signal), Object.hasOwn(DETAILS, signal) ? DETAILS[signal] : null);
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
      project: projectName(t.toplevel), sessions: t.sessions.length, dirty: Number.isSafeInteger(t.dirty) && t.dirty > 0 ? t.dirty : 0, ids: new Set(t.sessions),
    }));
  } catch { return []; }
}
// The row's project group (organised views PR 3): {key, heading, sub} only, never a path. group(row) is main's
// synchronous resolver answer (work-organise groupOf); pending means git has not answered yet, so the page keeps
// any collapse toggle for it in memory only. Without a resolver the group is the folder, which is not pending.
const GROUP_KEY = /^(?:(?:repo|git|dir)-[0-9a-z]{1,7}|other)$/;
function groupOf(fn, row) {
  let g = null;
  try { g = fn ? fn(row) : null; } catch { g = null; }
  if (!object(g) || !GROUP_KEY.test(g.key) || typeof g.heading !== 'string' || !g.heading || g.heading.length > 100 || !(g.sub == null || (typeof g.sub === 'string' && g.sub.length <= 60))) {
    const p = Organise.projectOf({ cwd: typeof row.cwd === 'string' ? row.cwd : null });
    return { group: { key: p.key, heading: p.heading, sub: p.sub ?? null }, ...(fn ? { groupPending: true } : {}) };
  }
  return { group: { key: g.key, heading: g.heading, sub: g.sub ?? null }, ...(g.pending === true ? { groupPending: true } : {}) };
}
// The policy pack the row's repo is under and its latest refusal (src/policy.js rowInfo).
function policyOf(fn, row) {
  try {
    const p = fn ? fn(row) : null;
    if (!object(p)) return {};
    const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    return { policy: { name: text(p.name, 80), source: p.source === 'repo' || p.source === 'default' ? p.source : null, warning: text(p.warning, 300), blocked: object(p.blocked) && text(p.blocked.text, 400) ? { text: text(p.blocked.text, 400), tool: text(p.blocked.tool, 80), at: Number.isFinite(p.blocked.at) ? p.blocked.at : null } : null } };
  } catch { return {}; }
}
function snapshot({ sessions = [], activity = {}, available = true, now = Date.now(), enrich = null, handover = null, info = null, sharedTrees = null, collisions = null, policy = null, group = null, tags = null } = {}) {
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
    const children = Array.isArray(rawChildren) ? rawChildren.filter(child => object(child) && typeof child.status === 'string' && Object.hasOwn(CHILD_SIGNALS, child.status)).slice(0, CHILD_LIMIT).map((child, index) => ({
      label: `${lifecycle ? 'Codex subagent' : 'Agent'} ${index + 1}`, status: lifecycle && row.codexClosedTurn === false && child.status !== 'done' && Machine.codexInputPending({ source: 'codex', codexLifecycle: 1, codexTurnId: child.turnId, codexClosedTurn: false, codexInputRequests: child.codexInputRequests }, time) ? bucketed('needs').status : bucketed(CHILD_SIGNALS[child.status]).status,
    })) : [];
    const stuck = object(row.stuck) && Number.isFinite(row.stuck.sinceMs) ? row.stuck : null;
    const more = extras(enrich, row);
    const tree = trees.find(t => t.ids.has(row.sessionId));
    rows.push({
      // Claude Code's own hook (set-status.js) writes no source field.
      provider: providerLabel(row),
      project: projectName(row.cwd),
      ...(tags && tags.get(row.sessionId) ? { tag: tags.get(row.sessionId) } : {}),
      ...groupOf(group, row),
      ...sessionStatus(row, presented, stuck, time),
      ...(stuck ? { stuck: { tool: stuck.tool || null, since_ms: stuck.sinceMs } } : {}),
      freshness: available === false || age === null ? 'unknown' : age <= RECENT_MS ? 'recent' : 'stale', age_ms: age, lifecycle, children,
      ...more,
      ...sessionTools(row, more),
      ...(tree && !more.burst?.coordination ? { sharedTree: tree.project } : {}),
      ...handoverOf(handover, row),
      ...actionsOf(info, row),
      ...collisionsOf(collisions, row),
      ...policyOf(policy, row),
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
module.exports = { snapshot, providerLabel, RECENT_MS, LIMIT, CHILD_LIMIT };
