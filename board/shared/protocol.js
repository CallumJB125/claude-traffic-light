// Wire protocol constants and message shapes (CONTRACT.md §4–§7 is the prose
// law; this file is its machine-readable half — keep them in sync, a test
// checks every type named here appears in CONTRACT.md).
//
// Browser-safe, dependency-free.

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = 'Board-Protocol';

// code → HTTP status. Runner-local codes (status 0) never cross the wire
// from the hub; the runner/board-mcp return them to the CLI.
export const ERRORS = Object.freeze({
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  FENCED: 409,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  ALREADY_ANSWERED: 409,
  CLAIM_LOST: 409,
  ONE_OPEN_ASK: 409,
  RUN_ENDED: 410,
  PAYLOAD_TOO_LARGE: 413,
  EVIDENCE_MISSING: 422,
  NO_REPO: 422,
  REPO_NOT_ADVERTISED: 422,
  BUDGET_EXCEEDED: 422,
  PROTOCOL_UNSUPPORTED: 426,
  CONFIRM_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL: 500,
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
  'approval_cancel',
]);
// RPC methods that are runner plumbing, not board-mcp tools.
export const RUNNER_ONLY_RPC = Object.freeze(['team_context', 'approval_cancel']);

// board-mcp tools (Phase 1). `approval` is the --permission-prompt-tool target (mcp__board__approval).
export const MCP_TOOLS = Object.freeze([
  'board_get_card', 'board_list_cards', 'board_update_status', 'board_append_progress', 'board_write_handover',
  'board_ask_human', 'board_comment', 'board_attach_evidence', 'board_complete', 'board_release',
  'board_declare_plan', 'board_check_overlap', 'board_recall', 'approval',
]);
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

// ── shapes ─────────────────────────────────────────────────────────────────
// 'T' required, 'T?' optional (may be null). T ∈ string|int|number|bool|object|array|any.
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
    welcome: { protocol: 'int', hub_epoch: 'string', member: 'object' },
    snapshot: { board_id: 'string', board: 'object', cards: 'array', members: 'array' },
    'card.upsert': { board_id: 'string', card: 'object' },
    'card.remove': { board_id: 'string', card_id: 'string' },
    'lease.tick': { card_id: 'string', live: 'object', state_age_ms: 'int' },
    'event.append': { card_id: 'string', event: 'object' },
    pong: {},
    error: { code: 'string', message: 'string' },
  },
  // runner → hub
  'runner→hub': {
    hello: { protocol: 'int', device_id: 'string', runner_version: 'string', outbox_head_seq: 'int', runs: 'array', form_factor: 'string?', outbox_id: 'string?', outbox_acked_seq: 'int?' },
    advertise: { repos: 'array' },
    claim: { id: 'string', card_id: 'string', request_id: 'string', expected_fence: 'int' },
    decline: { card_id: 'string', request_id: 'string', reason: 'string?' },
    hb: { seq_hb: 'int', mono_ms: 'int', wall_ms: 'int', slept_ms: 'int', runs: 'array' },
    'host.suspending': { runs: 'array' },
    out: { seq: 'int', delayed: 'bool', msg: 'object' },
    rpc: { id: 'string', method: 'string', ...run3, repo_id: 'string', run_token: 'string', params: 'object' },
    salvage: { ...run3, repo_id: 'string', kind: 'string', payload: 'object' },
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
