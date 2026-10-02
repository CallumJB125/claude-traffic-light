'use strict';

// Local session metadata only. Never forward a session object to this page:
// it may also contain tool, task, prompt, host or credential information.
const LIMIT = 100;
const CHILD_LIMIT = 64;
const Machine = require('../hooks/session-machine');
const RECENT_MS = 90_000;
const PROVIDERS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', 'claude-code': 'Claude Code', cursor: 'Cursor', gemini: 'Gemini', opencode: 'OpenCode', copilot: 'Copilot' });
const STATUSES = Object.freeze({
  'session-start': 'Ready', 'prompt-submit': 'Working', 'tool-use': 'Working', 'tool-done': 'Working',
  'permission-ask': 'Waiting on you', 'user-question': 'Waiting on you', 'question-ask': 'Waiting on you',
  'subagent-start': 'Working', 'subagent-done': 'Ready', 'stop': 'Turn stopped', 'idle': 'Idle',
  'idle-nudge': 'Idle', 'turn-failed': 'Turn failed', 'limit-hit': 'Limit reached', 'session-end': 'Ended',
});
const CHILD_STATUSES = Object.freeze({ working: 'Working', waiting: 'Waiting on you', done: 'Stopped' });
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
function snapshot({ sessions = [], activity = {}, available = true, now = Date.now() } = {}) {
  const time = Number.isFinite(now) && now >= 0 ? now : Date.now();
  let latest = null, omitted = 0;
  const rows = [];
  const input = Array.isArray(sessions) ? sessions : [];
  // The app's bounded session store is the source; no provider chats or
  // private provider state is consulted here, including for freshness.
  for (const row of input) {
    if (!isLocal(row)) continue;
    const lifecycle = row.source === 'codex' && row.codexLifecycle === 1;
    const age = elapsed(lifecycle ? row.codexHookAt : row.updatedAt, time);
    if (lifecycle && age !== null && (latest === null || age < latest)) latest = age;
    if (rows.length >= LIMIT) { omitted++; continue; }
    const rawChildren = lifecycle ? row.codexAgents : row.agents;
    const children = Array.isArray(rawChildren) ? rawChildren.filter(child => object(child) && typeof child.status === 'string' && Object.hasOwn(CHILD_STATUSES, child.status)).slice(0, CHILD_LIMIT).map((child, index) => ({
      label: `${lifecycle ? 'Codex subagent' : 'Agent'} ${index + 1}`, status: lifecycle && row.codexClosedTurn === false && child.status !== 'done' && Machine.codexInputPending({ source: 'codex', codexLifecycle: 1, codexTurnId: child.turnId, codexClosedTurn: false, codexInputRequests: child.codexInputRequests }, time) ? 'Waiting on you' : CHILD_STATUSES[child.status],
    })) : [];
    rows.push({
      // Claude Code's own hook (set-status.js) writes no source field.
      provider: row.source == null ? PROVIDERS.claude : typeof row.source === 'string' && Object.hasOwn(PROVIDERS, row.source) ? PROVIDERS[row.source] : 'Local AI',
      project: projectLeaf(row.cwd),
      status: lifecycle && row.codexClosedTurn === true ? 'Turn stopped' : Machine.codexInputPending(row, time) ? 'Waiting on you' : typeof row.signal === 'string' && Object.hasOwn(STATUSES, row.signal) ? STATUSES[row.signal] : 'Unknown',
      freshness: age === null ? 'unknown' : age <= RECENT_MS ? 'recent' : 'stale', age_ms: age, lifecycle, children,
    });
  }
  rows.sort((a, b) => (a.age_ms ?? Infinity) - (b.age_ms ?? Infinity));
  return {
    observed_at: time,
    status: available === false || !Array.isArray(sessions) ? 'unavailable' : omitted ? 'partial' : 'complete', omitted,
    activity: { configured: activity.available === false ? null : typeof activity.configured === 'boolean' ? activity.configured : null,
      observed: latest !== null, latest_age_ms: latest }, sessions: rows,
  };
}
module.exports = { snapshot, RECENT_MS, LIMIT, CHILD_LIMIT };
