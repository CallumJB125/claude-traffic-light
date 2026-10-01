// Wire protocol constants and message shapes (CONTRACT.md §4–§7 is the prose
// law; this file is its machine-readable half — keep them in sync, a test
// checks every type named here appears in CONTRACT.md).
//
// Browser-safe, dependency-free.

import { AI_IDS, aiListError } from './ai.js';
export { AI_IDS, AI_LABELS, BUDGET_MAX_USD } from './ai.js';
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = 'Board-Protocol';

// code → HTTP status. Runner-local codes (status 0) never cross the wire
// from the hub; the runner/board-mcp return them to the CLI.
export const ERRORS = Object.freeze({
  VALIDATION: 400,
  INVALID_TOKEN: 400,       // accounts: sign-in code/flow wrong, used, expired or dead (one generic code; D53)
  UNAUTHENTICATED: 401,
  STEP_UP_REQUIRED: 401,    // accounts: needs a fresh email code first (D56)
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  QUOTA_EXCEEDED: 403,      // accounts: a free-plan limit (extra: resource, limit; D62)
  EMAIL_UNVERIFIED: 403,    // accounts: team create / invite needs a verified email
  WRONG_ACCOUNT: 403,       // accounts: a valid invite for another address (names no address; D64)
  SIGNUP_CLOSED: 403,       // accounts: a new account this hub's sign-up control does not allow (names the mode only; D104)
  NOT_FOUND: 404,
  METHOD_DISABLED: 404,     // accounts: that sign-in method is not configured on this hub (D66)
  ILLEGAL_TRANSITION: 409,
  FENCED: 409,
  CONFLICT: 409,
  ALREADY_MEMBER: 409,      // accounts: inviting / accepting for someone already in the team (extra: team)
  VERSION_CONFLICT: 409,
  ALREADY_ANSWERED: 409,
  CLAIM_LOST: 409,
  ONE_OPEN_ASK: 409,
  RUN_ENDED: 410,
  TIMEOUT: 408,             // a request body not received in time (D105; the webhook ingress's 408 too)
  PAYLOAD_TOO_LARGE: 413,
  EVIDENCE_MISSING: 422,
  NO_REPO: 422,
  REPO_NOT_ADVERTISED: 422,
  BUDGET_EXCEEDED: 422,
  PROTOCOL_UNSUPPORTED: 426,
  CONFIRM_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  ACCESS_UNAVAILABLE: 503,  // Access signing keys unreachable: retry, the credential may be fine
  PROVIDER_ERROR: 502,      // accounts: the OAuth provider refused the sign-in code (D77)
  PROVIDER_UNAVAILABLE: 503, // accounts: the OAuth provider (or its signing keys) could not be reached (D77)
  // hub-internal guard outcomes (reaper retries later; never sent to clients)
  BOOT_GRACE: 503,
  TUNNEL_DOWN: 503,
  // runner-local
  OUT_OF_SCOPE: 0,
  GATE_CLOSED: 0,
  HUB_UNREACHABLE: 0,
  BAD_RUN_TOKEN: 0,
});

export function httpStatus(code) {
  const s = ERRORS[code];
  return s ? s : 500;
}

export const WS_CLOSE = Object.freeze({
  NORMAL: 1000,
  HUB_SHUTDOWN: 4000,
  UNAUTHENTICATED: 4401,
  REVOKED: 4403,
  REPLACED: 4409,            // same device connected again; newest connection wins
  RATE_LIMITED: 4429,        // runner over its frame cap: reconnect with backoff, replay the outbox
  PROTOCOL_UNSUPPORTED: 4426,
  UNAVAILABLE: 4503,         // hub cannot verify credentials right now (JWKS down): reconnect with backoff
});

export const WS_PATHS = Object.freeze({ browser: '/ws/board', runner: '/ws/runner' });

// Runner→hub outbox kinds: durable, carry a per-device seq, replayed on reconnect.
export const OUTBOX_KINDS = Object.freeze([
  'activity', 'facts', 'run.failed', 'prep.failed', 'handover.complete', 'snapshot',
  'handover.write', 'progress.append', 'status.update', 'comment.create', 'comment.delivered',
]);

// Runner→hub RPC methods (need the hub now; fail with HUB_UNREACHABLE offline).
export const RPC_METHODS = Object.freeze([
  'board_get_card', 'board_list_cards', 'board_ask_human', 'board_attach_evidence', 'board_complete',
  'board_release', 'board_declare_plan', 'board_check_overlap', 'board_recall', 'approval', 'team_context',
  'approval_cancel', 'board_create_card', 'board_add_lesson',
]);
// RPC methods that are runner plumbing, not board-mcp tools.
export const RUNNER_ONLY_RPC = Object.freeze(['team_context', 'approval_cancel']);

// board-mcp tools (Phase 1). `approval` is the --permission-prompt-tool target (mcp__board__approval).
export const MCP_TOOLS = Object.freeze([
  'board_get_card', 'board_list_cards', 'board_update_status', 'board_append_progress', 'board_write_handover',
  'board_ask_human', 'board_comment', 'board_attach_evidence', 'board_complete', 'board_release',
  'board_declare_plan', 'board_check_overlap', 'board_recall', 'approval', 'board_create_card', 'board_add_lesson',
]);

// Least-privilege scope of each board-mcp tool (CONTRACT §7.3). Every tool is
// also inside the run's repo scope: the hub verifies run token, fence and
// repo_id before any method runs, and a run exists only for an opted-in repo.
export const TOOL_SCOPES = Object.freeze({
  'card:read': "read this run's card, its parent and its children",
  'repo:read': "read titles, overlaps and notes of this board's cards in this run's repo",
  'card:write': "write to this run's own card only",
  'card:create_child': "create a todo child card of this run's card on the same board and repo; never dispatched, assigned or budgeted",
  'lesson:suggest': "append a lesson suggestion for this run's repo in the board's org; never read back to agents",
  'permission:ask': "ask this card's approvers for a tool permission; cannot grant one",
});
export const MCP_TOOL_SCOPES = Object.freeze({
  board_get_card: 'card:read',
  board_list_cards: 'repo:read',
  board_update_status: 'card:write',
  board_append_progress: 'card:write',
  board_write_handover: 'card:write',
  board_ask_human: 'card:write',
  board_comment: 'card:write',
  board_attach_evidence: 'card:write',
  board_complete: 'card:write',
  board_release: 'card:write',
  board_declare_plan: 'card:write',
  board_check_overlap: 'repo:read',
  board_recall: 'repo:read',
  board_create_card: 'card:create_child',
  board_add_lesson: 'lesson:suggest',
  approval: 'permission:ask',
});
// Tools whose hub effect goes through the durable outbox (return {queued:true} offline).
export const MCP_OUTBOX_TOOLS = Object.freeze({
  board_update_status: 'status.update',
  board_append_progress: 'progress.append',
  board_write_handover: 'handover.write',
  board_comment: 'comment.create',
});

// FeedEvent.kind values the hub sends to browsers (§5.3): states.js feed
// effects, hub-recorded lines, and the displayed fact kinds. Every other
// events row (activity, facts, tool_start/_end, raw outbox kinds…) is internal.
export const FEED_KINDS = Object.freeze([
  // states.js feed effects
  'dispatched', 'claimed', 'started', 'cancelled', 'declined', 'blocked', 'answered', 'withdrawn', 'parked',
  'requeued_answered', 'suspended', 'unresponsive', 'orphaned', 'recovered', 'reconnecting', 'failed', 'stopped',
  'released', 'retried', 'taken_over', 'handing_over', 'handed_over', 'human_on_it', 'in_review', 'changes_requested',
  'pr_closed_unmerged', 'merged', 'approved_done', 'prep_failed', 'requeued_claim_timeout',
  // hub-recorded
  'created', 'comment', 'progress', 'evidence', 'plan_declared', 'handover_frozen', 'salvage',
  // facts shown in the feed
  'file', 'git', 'command', 'plan', 'error', 'subagent', 'message', 'compacted', 'cost', 'session', 'degraded',
]);

// Hook-shim events (CLI hook → shim → runner IPC `hook` method).
export const HOOK_EVENTS = Object.freeze(['start', 'prompt', 'pre', 'post', 'postfail', 'precompact', 'stop', 'stopfail', 'substop']);

export const RUNNER_COMMANDS = Object.freeze(['stop', 'park', 'handover_begin', 'interrupt']);

// Team presence (D37b): the desktop app's local agent sessions, reduced by the
// runner to board-linked repos. Never a path: repo_id + branch only.
export const PRESENCE_AGENTS = Object.freeze(['claude', 'codex', 'cursor', 'gemini', 'hermes']);
export const PRESENCE_STATES = Object.freeze(['working', 'waiting', 'idle']);
export const PRESENCE_MAX_SESSIONS = 50;
export const PRESENCE_SUMMARY_MAX = 120;
export const PRESENCE_SINCE_MAX = 40;
export const PRESENCE_SESSION = Object.freeze({ session_id: 'string', agent: 'string', repo_id: 'string', branch: 'string?', state: 'string', since: 'string', summary: 'string?' });

// `since`: an ISO-8601 date-time with a zone (Z or ±hh:mm), ≤ 40 chars.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
export function isPresenceSince(v) {
  return typeof v === 'string' && v.length <= PRESENCE_SINCE_MAX && ISO_DATE_TIME.test(v) && Number.isFinite(Date.parse(v));
}

function presenceItemError(s) {
  const e = checkShape(PRESENCE_SESSION, s);
  if (e) return e.message;
  if (!PRESENCE_AGENTS.includes(s.agent)) return `agent ${s.agent} unknown`;
  if (!PRESENCE_STATES.includes(s.state)) return `state ${s.state} unknown`;
  if (!isPresenceSince(s.since)) return `since must be an ISO-8601 date-time ≤ ${PRESENCE_SINCE_MAX} chars`;
  if (s.session_id.length > 64 || (s.branch != null && s.branch.length > 200)) return 'session_id or branch too long';
  if (s.summary != null && s.summary.length > PRESENCE_SUMMARY_MAX) return `summary over ${PRESENCE_SUMMARY_MAX}`;
  return null;
}

// ── shapes ─────────────────────────────────────────────────────────────────
// 'T' required, 'T?' optional (may be null). T ∈ string|int|number|bool|object|array|any.
// The colour tokens of label registry entries and card covers (D91, D93):
// the web maps each to a CSS class, never an inline style (CSP).
export const LABEL_COLORS = Object.freeze(['grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown']);

const run3 = { run_id: 'string', card_id: 'string', fence: 'int' };

export const SHAPES = Object.freeze({
  // browser → hub
  'browser→hub': {
    hello: { protocol: 'int' },
    subscribe: { board_id: 'string' },
    unsubscribe: { board_id: 'string' },
    ping: {},
  },
  // hub → browser
  'hub→browser': {
    welcome: { protocol: 'int', hub_epoch: 'string', member: 'object?', user: 'object?' },
    'session.revoked': {},
    snapshot: { board_id: 'string', board: 'object', cards: 'array', members: 'array' },
    'card.upsert': { board_id: 'string', card: 'object' },
    'card.remove': { board_id: 'string', card_id: 'string' },
    'board.labels': { board_id: 'string', labels: 'array' },
    'team.boards': { org_id: 'string', boards: 'array' },
    'lease.tick': { card_id: 'string', live: 'object', state_age_ms: 'int' },
    'event.append': { card_id: 'string', event: 'object' },
    'team.presence': { members: 'array' },
    pong: {},
    error: { code: 'string', message: 'string' },
  },
  // runner → hub
  'runner→hub': {
    hello: { protocol: 'int', device_id: 'string', runner_version: 'string', outbox_head_seq: 'int', runs: 'array', form_factor: 'string?', outbox_id: 'string?', outbox_acked_seq: 'int?', ai: 'array?' },
    advertise: { repos: 'array', ai: 'array?' },
    claim: { id: 'string', card_id: 'string', request_id: 'string', expected_fence: 'int' },
    decline: { card_id: 'string', request_id: 'string', reason: 'string?' },
    hb: { seq_hb: 'int', mono_ms: 'int', wall_ms: 'int', slept_ms: 'int', runs: 'array' },
    'host.suspending': { runs: 'array' },
    out: { seq: 'int', delayed: 'bool', msg: 'object' },
    rpc: { id: 'string', method: 'string', ...run3, repo_id: 'string', run_token: 'string', params: 'object' },
    salvage: { ...run3, repo_id: 'string', kind: 'string', payload: 'object' },
    presence: { sessions: 'array' },
  },
  // hub → runner
  'hub→runner': {
    welcome: { protocol: 'int', hub_epoch: 'string', device_id: 'string', member_id: 'string', last_seq_acked: 'int', allowlist: 'array' },
    ack: { seq: 'int', versions: 'array?' },
    offer: { card_id: 'string', key: 'string', title: 'string', body: 'string', repo_id: 'string', base_ref: 'string', fence: 'int', request_id: 'string', dispatched_by: 'object', needs_confirm: 'bool', labels: 'array', budget_usd: 'number?', max_turns: 'int?', require_plan_approval: 'bool', seed: 'object' },
    'offer.withdrawn': { card_id: 'string', request_id: 'string', reason: 'string' },
    'claim.result': { re: 'string', ok: 'bool' },
    'hb.ack': { seq_hb: 'int', hub_epoch: 'string', runs: 'array' },
    cmd: { cmd_id: 'string', ...run3, cmd: 'string' },
    answer: { ...run3, answered_by: 'object' },
    'comment.deliver': { ...run3, comments: 'array' },
    'context.update': { ...run3, team_context: 'object' },
    fenced: { run_id: 'string', card_id: 'string', held_fence: 'int', current_fence: 'int' },
    'rpc.result': { re: 'string', ok: 'bool' },
    error: { code: 'string', message: 'string' },
  },
  // board-mcp / hook shim → runner (local IPC, NDJSON)
  'ipc→runner': {
    hello: { id: 'string', token: 'string' },
    tool: { id: 'string', token: 'string', name: 'string', args: 'object' },
    hook: { id: 'string', token: 'string', event: 'string', payload: 'object' },
    cancel: { id: 'string', token: 'string', re: 'string' },
  },
});

// Outbox msg bodies (inside `out.msg`): every one is repo-scoped.
export const OUTBOX_SHAPES = Object.freeze({
  activity: { kind: 'string', ...run3, repo_id: 'string', source: 'string' },
  facts: { kind: 'string', ...run3, repo_id: 'string', items: 'array' },
  'run.failed': { kind: 'string', ...run3, repo_id: 'string', fail_kind: 'string', reason: 'string?', resets_in_ms: 'int?' },
  'prep.failed': { kind: 'string', ...run3, repo_id: 'string', cause: 'string' },
  'handover.complete': { kind: 'string', ...run3, repo_id: 'string' },
  snapshot: { kind: 'string', ...run3, repo_id: 'string', status: 'string', sha: 'string?', ref: 'string?', reason: 'string?' },
  'handover.write': { kind: 'string', ...run3, repo_id: 'string', patch: 'object' },
  'progress.append': { kind: 'string', ...run3, repo_id: 'string', text: 'string' },
  'status.update': { kind: 'string', ...run3, repo_id: 'string', summary: 'string' },
  'comment.create': { kind: 'string', ...run3, repo_id: 'string', text: 'string', reply_to: 'string?' },
  'comment.delivered': { kind: 'string', ...run3, repo_id: 'string', comment_ids: 'array', via: 'string' },
});

// Fact items inside a `facts` message (repo-relative paths only).
export const FACT_KINDS = Object.freeze({
  tool_start: { name: 'string', summary: 'string?', bash_timeout_ms: 'int?' },
  tool_end: { name: 'string', ok: 'bool', duration_ms: 'int?' },
  file: { path: 'string', op: 'string' },
  command: { cmd: 'string', exit: 'int?', duration_ms: 'int?', tail: 'string?' },
  error: { first_line: 'string' },
  git: { branch: 'string?', head_sha: 'string?', commits_ahead: 'int?', commits_behind: 'int?' },
  plan: { items: 'array' },
  subagent: { summary: 'string' },
  message: { text: 'string' },
  compacted: {},
  cost: { cost_usd: 'number', num_turns: 'int?' },
  session: { session_id: 'string', event: 'string' },
  degraded: { reason: 'string' },
});

function typeOk(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'int': return Number.isSafeInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'bool': return typeof v === 'boolean';
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'any': return v !== undefined;
    default: return false;
  }
}

export function checkShape(shape, msg) {
  if (!msg || typeof msg !== 'object') return { code: 'VALIDATION', message: 'message must be an object' };
  for (const [k, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?');
    const t = optional ? spec.slice(0, -1) : spec;
    const v = msg[k];
    if (v === undefined || v === null) {
      if (optional) continue;
      return { code: 'VALIDATION', message: `missing ${k}` };
    }
    if (!typeOk(t, v)) return { code: 'VALIDATION', message: `${k} must be ${t}` };
  }
  return null;
}

/** Validate a WS/IPC message on a channel. null = ok. Unknown types → VALIDATION. */
export function validate(channel, msg) {
  const table = SHAPES[channel];
  if (!table) return { code: 'VALIDATION', message: `unknown channel ${channel}` };
  if (!msg || typeof msg.type !== 'string' || !(msg.type in table)) return { code: 'VALIDATION', message: `unknown type ${msg?.type}` };
  const e = checkShape(table[msg.type], msg);
  if (e) return e;
  if (channel === 'runner→hub' && ['hello', 'advertise'].includes(msg.type) && Object.hasOwn(msg, 'ai')) {
    const error = aiListError(msg.ai);
    if (error) return { code: 'VALIDATION', message: error };
  }
  if (channel === 'hub→runner' && msg.type === 'offer' && msg.ai != null && !AI_IDS.includes(msg.ai)) return { code: 'VALIDATION', message: 'unknown offer AI' };
  if (channel === 'runner→hub' && msg.type === 'presence') {
    if (msg.sessions.length > PRESENCE_MAX_SESSIONS) return { code: 'VALIDATION', message: `presence: over ${PRESENCE_MAX_SESSIONS} sessions` };
    for (const s of msg.sessions) {
      const pe = presenceItemError(s);
      if (pe) return { code: 'VALIDATION', message: `presence: ${pe}` };
    }
  }
  if (channel === 'runner→hub' && msg.type === 'out') {
    const body = msg.msg;
    if (!(body.kind in OUTBOX_SHAPES)) return { code: 'VALIDATION', message: `unknown outbox kind ${body.kind}` };
    const be = checkShape(OUTBOX_SHAPES[body.kind], body);
    if (be) return { ...be, message: `out.msg: ${be.message}` };
    if (body.kind === 'facts') {
      for (const f of body.items) {
        if (!f || !(f.kind in FACT_KINDS)) return { code: 'VALIDATION', message: `unknown fact kind ${f?.kind}` };
        const fe = checkShape(FACT_KINDS[f.kind], f);
        if (fe) return { ...fe, message: `fact ${f.kind}: ${fe.message}` };
      }
    }
  }
  return null;
}

// Semver-ish compatibility: same major integer = compatible. Additive fields
// never bump; removing/renaming a field or changing semantics bumps.
export function compatible(theirs) {
  return Number.isSafeInteger(theirs) && theirs === PROTOCOL_VERSION;
}
