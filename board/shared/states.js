// The card/run lifecycle (design §4, §4.1) as data plus one pure function:
//
//   step(card, event, ctx) → { ok: true,  card, effects, rule, from, to }
//                          | { ok: false, error: { code, message }, rule? }
//
// `card` is the hub's authoritative state record (see CARD_FIELDS); step()
// never mutates it. `event` is {type, ...payload}; `ctx` carries everything a
// guard needs that is not on the card (permissions, policy, timers). Effects
// are instructions for the hub to carry out in the SAME transaction as the
// state write (fence bump, lease release, runner commands, notifications per
// the §5.2 N-rules, feed lines, memories).
//
// Browser-safe, dependency-free. The hub owns persistence; the web imports
// STATES/columnOf for display; tests walk every TRANSITIONS row.

import { T_ORPHAN_MS, HANDOVER_WAIT_MS, ORPHAN_NOTIFY_MS } from './liveness.js';

export const STATES = Object.freeze([
  'todo', 'queued', 'claimed', 'running', 'quiet', 'blocked', 'parked',
  'suspended', 'reconnecting', 'unresponsive', 'orphaned',
  'handing_over', 'handed_over', 'in_review', 'done', 'failed',
]);

// A run exists and a lease is held or frozen (§4).
export const ACTIVE = new Set(['claimed', 'running', 'quiet', 'blocked', 'suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over']);
// The card went dark: resume_to is set on every entry (§4 resume_to).
export const DARK = new Set(['suspended', 'reconnecting', 'unresponsive', 'orphaned']);
export const LIVE = new Set(['running', 'quiet', 'blocked']);

// The card label that turns on plan approval (ctx.require_plan_approval, offer.require_plan_approval).
export const PLAN_APPROVAL_LABEL = 'plan-approval';
// Labels that restrict what runs may do on a card; a child an agent creates inherits them (D31).
export const POLICY_LABELS = Object.freeze(['never_auto', PLAN_APPROVAL_LABEL]);
// Labels nobody may colour, rename or delete in the board registry (D91): a
// policy label changes run policy and via:<provider> marks an integration's card.
export const isReservedLabel = (name) => typeof name === 'string'
  && (/^via:/i.test(name.trim()) || POLICY_LABELS.includes(name.trim().toLowerCase()));
export const BLOCKED_KINDS = Object.freeze(['permission', 'question', 'clarify', 'decision', 'plan', 'conflict', 'loop']);
export const FAIL_KINDS = Object.freeze(['network', 'limit', 'error', 'budget', 'stopped', 'released']);
// What a runner may report through run_failed; stopped/released have their own events.
export const RUNNER_FAIL_KINDS = Object.freeze(['network', 'limit', 'error', 'budget']);
export const RESUME_TO = Object.freeze(['quiet', 'blocked', 'claimed']);

export const COLUMNS = Object.freeze(['todo', 'in_progress', 'in_review', 'done']);

export function columnOf(state) {
  if (state === 'todo' || state === 'queued' || state == null) return 'todo';
  if (state === 'in_review') return 'in_review';
  if (state === 'done') return 'done';
  return 'in_progress';
}

// The fields step() reads and writes. Everything else on the object is
// carried through untouched.
export const CARD_FIELDS = Object.freeze(['run_state', 'blocked_kind', 'fail_kind', 'resume_to', 'pre_reconnect_state', 'fence', 'handover_target', 'handover_provenance']);

// DB ⇄ machine: the DB stores run_state NULL for a card with no run (the
// cards CHECK forbids a run_state on a card without a repo); the machine
// calls that state 'todo'.
export function fromDb(row) {
  return { ...row, run_state: row.run_state ?? 'todo', handover_target: parseJson(row.handover_target) };
}
export function toDb(card) {
  return {
    ...card,
    run_state: card.run_state === 'todo' ? null : card.run_state,
    column_name: columnOf(card.run_state),
    handover_target: card.handover_target == null ? null : JSON.stringify(card.handover_target),
  };
}
function parseJson(v) {
  if (v == null || typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
}

// Where each event comes from. Runner events carry the runner's `fence` and
// are rejected with FENCED when it is not the card's current fence.
export const EVENTS = Object.freeze({
  // human (HTTP action routes)
  dispatch: 'human', cancel: 'human', decline: 'human', answer: 'human', stop: 'human',
  retry: 'human', take_over: 'human', hand_over: 'human', redispatch: 'human',
  take_myself: 'human', request_changes: 'human', approve_done: 'human',
  // runner (WS, fenced)
  claim: 'runner', activity: 'runner', prep_failed: 'runner', block: 'runner',
  host_suspending: 'runner', hb: 'runner', run_failed: 'runner', release: 'runner',
  complete: 'runner', handover_complete: 'runner', withdraw: 'runner',
  // hub timers (liveness.timerEvent)
  queue_nudge: 'timer', hb_timeout: 'timer', claim_timeout: 'timer', quiet_timeout: 'timer',
  park_timeout: 'timer', orphan_timeout: 'timer', suspend_timeout: 'timer',
  reconnect_timeout: 'timer', handover_timeout: 'timer',
  // hub system
  hub_boot: 'system', pr_closed: 'system', pr_merged: 'system',
});

// ── helpers used by rows ────────────────────────────────────────────────────

const NOTIFY_TO = ['dispatcher', 'assignees'];
const notify = (rule) => ({ type: 'notify', rule, to: NOTIFY_TO });
const feed = (kind, data = {}) => ({ type: 'feed', kind, ...data });
const runnerCmd = (card, cmd, extra = {}) => ({ type: 'runner_command', cmd, fence: card.fence, ...extra });
const endRun = (reason) => [{ type: 'lease_release' }, { type: 'run_end', reason }];
const offer = { type: 'offer_to_runners' };
const handoffMemory = (provenance) => ({ type: 'memory_write', kind: 'handoff', provenance });
const orphanEffects = [{ type: 'notify_after', rule: 'orphaned', after_ms: ORPHAN_NOTIFY_MS }, { type: 'handover_freeze' }, feed('orphaned')];

// resume_to on entry to a dark state (§4): kept when already dark.
function darkResume(card) {
  if (DARK.has(card.run_state)) return card.resume_to ?? 'quiet';
  if (card.run_state === 'blocked') return 'blocked';
  if (card.run_state === 'claimed') return 'claimed';
  return 'quiet';
}
const recoverTo = (card) => card.resume_to ?? 'quiet';
const recoverEffects = (extra = []) => [{ type: 'lease_mark_wake' }, feed('recovered'), ...extra];

const has = (ctx, k) => ctx[k] === true;
const guardAll = (...checks) => (card, ev, ctx) => {
  for (const [key, code] of checks) if (!has(ctx, key)) return { code, message: `guard ${key} failed` };
  return null;
};
const canWrite = guardAll(['can_write', 'FORBIDDEN']);
const needsRequestId = (card, ev) => (ev.request_id ? null : { code: 'VALIDATION', message: 'request_id required' });
const both = (...gs) => (card, ev, ctx) => {
  for (const g of gs) { const e = g(card, ev, ctx); if (e) return e; }
  return null;
};

const L = ['running', 'quiet', 'blocked'];
const ACTIVE_LIST = [...ACTIVE];

/**
 * TRANSITIONS: one entry per row of design §4.1 (ids match the design; a
 * trailing letter marks a sub-case the design folds into one row, "n" marks a
 * documented no-op). Fields:
 *   id, from[], on, to (state | 'RECOVER' | 'SAME' | fn(card, ev, ctx))
 *   when(card, ev, ctx)   extra selector between rows sharing from+on
 *   fenced                'event' (ev.fence must equal card.fence) | 'expected' (ev.expected_fence)
 *   guard(card, ev, ctx)  → null | {code, message}
 *   bump                  fence+1 in the same transaction
 *   dark                  set resume_to per §4 before moving
 *   patch(card, ev, ctx)  extra field writes
 *   effects(card, ev, ctx) → effect[]
 */
export const TRANSITIONS = Object.freeze([
  { id: '1', from: ['todo'], on: 'dispatch', to: 'queued',
    guard: both(needsRequestId, guardAll(['has_repo', 'NO_REPO'], ['can_write', 'FORBIDDEN'], ['policy_ok', 'POLICY_DENIED'])),
    effects: (c, ev, ctx) => [{ type: 'dispatch_create', request_id: ev.request_id, target_member_id: ev.target_member_id ?? null, needs_confirm: !!ctx.needs_confirm }, offer, feed('dispatched', { needs_confirm: !!ctx.needs_confirm })] },
  { id: '1a', from: ['queued'], on: 'queue_nudge', to: 'SAME',
    effects: () => [{ type: 'notify', rule: 'queued_no_runner', to: ['dispatcher'] }, { type: 'mark_nudged' }] },
  { id: '2', from: ['queued'], on: 'cancel', to: 'todo', guard: guardAll(['can_cancel', 'FORBIDDEN']),
    effects: () => [{ type: 'dispatch_cancel', reason: 'cancelled' }, feed('cancelled')] },
  { id: '2b', from: ['queued'], on: 'decline', to: 'todo', guard: guardAll(['is_target_member', 'FORBIDDEN']),
    effects: () => [{ type: 'dispatch_cancel', reason: 'declined' }, feed('declined')] },
  { id: '3', from: ['queued'], on: 'claim', to: 'claimed', fenced: 'expected', bump: true,
    guard: guardAll(['repo_advertised', 'REPO_NOT_ADVERTISED'], ['runner_accepts', 'POLICY_DENIED'], ['no_active_run', 'CONFLICT']),
    effects: () => [{ type: 'run_create' }, { type: 'lease_create' }, feed('claimed')] },
  { id: '4', from: ['claimed'], on: 'activity', to: 'running', fenced: 'event', when: (c, ev) => !ev.delayed, effects: () => [feed('started')] },
  { id: '5', from: ['claimed'], on: 'prep_failed', to: 'queued', fenced: 'event', bump: true,
    effects: (c, ev) => [...endRun('prep_failed'), offer, feed('prep_failed', { cause: ev.cause ?? null })] },
  { id: '5a', from: ['claimed'], on: 'hb_timeout', to: 'unresponsive', dark: true, effects: () => [feed('unresponsive')] },
  { id: '5b', from: ['unresponsive'], on: 'claim_timeout', to: 'queued', bump: true, when: (c) => c.resume_to === 'claimed',
    effects: () => [...endRun('claim_timeout'), offer, feed('requeued_claim_timeout')] },
  { id: '6', from: ['running'], on: 'quiet_timeout', to: 'quiet' },
  { id: '7', from: ['quiet'], on: 'activity', to: 'running', fenced: 'event', when: (c, ev) => !ev.delayed },
  { id: '8', from: ['running', 'quiet', 'blocked'], on: 'block', to: 'blocked', fenced: 'event',
    guard: (c, ev, ctx) => (!BLOCKED_KINDS.includes(ev.kind) ? { code: 'VALIDATION', message: `bad blocked kind ${ev.kind}` }
      : ev.kind === 'plan' && !has(ctx, 'require_plan_approval') ? { code: 'POLICY_DENIED', message: 'plan approval not required for this card' } : null),
    patch: (c, ev) => ({ blocked_kind: ev.kind }),
    effects: (c, ev) => [notify('blocked'), feed('blocked', { kind: ev.kind })] },
  { id: '9', from: ['blocked'], on: 'answer', to: 'running', when: (c, ev, ctx) => !(ctx.open_asks_remaining > 0),
    guard: guardAll(['can_answer', 'FORBIDDEN']),
    effects: (c, ev) => [{ type: 'deliver_answer' }, feed('answered', { by: ev.by ?? null })] },
  { id: '9b', from: ['blocked'], on: 'answer', to: 'SAME', when: (c, ev, ctx) => ctx.open_asks_remaining > 0,
    guard: guardAll(['can_answer', 'FORBIDDEN']),
    effects: (c, ev) => [{ type: 'deliver_answer' }, feed('answered', { by: ev.by ?? null })] },
  // Decision D6: an answer given while the card is dark is stored and
  // delivered on recovery; resume_to drops to quiet when nothing is left
  // open, so a recovered card doesn't show a "Needs you" that was answered.
  { id: '9d', from: ['suspended', 'reconnecting', 'unresponsive', 'orphaned'], on: 'answer', to: 'SAME',
    when: (c) => c.resume_to === 'blocked', guard: guardAll(['can_answer', 'FORBIDDEN']),
    patch: (c, ev, ctx) => (ctx.open_asks_remaining > 0 ? {} : { resume_to: 'quiet' }),
    effects: (c, ev) => [{ type: 'deliver_answer' }, feed('answered', { by: ev.by ?? null })] },
  // The CLI cancelled a held permission prompt (approval_cancel rpc): the
  // request is withdrawn, like an answer that delivers nothing.
  { id: '9w', from: ['blocked'], on: 'withdraw', to: 'running', fenced: 'event', when: (c, ev, ctx) => !(ctx.open_asks_remaining > 0),
    effects: () => [feed('withdrawn')] },
  { id: '9wb', from: ['blocked'], on: 'withdraw', to: 'SAME', fenced: 'event', when: (c, ev, ctx) => ctx.open_asks_remaining > 0,
    effects: () => [feed('withdrawn')] },
  { id: '9wd', from: ['suspended', 'reconnecting', 'unresponsive', 'orphaned'], on: 'withdraw', to: 'SAME', fenced: 'event',
    when: (c) => c.resume_to === 'blocked',
    patch: (c, ev, ctx) => (ctx.open_asks_remaining > 0 ? {} : { resume_to: 'quiet' }),
    effects: () => [feed('withdrawn')] },
  { id: '10', from: ['blocked'], on: 'park_timeout', to: 'parked', bump: true,
    effects: (c) => [runnerCmd(c, 'park'), ...endRun('parked'), notify('parked'), feed('parked')] },
  { id: '11', from: ['parked'], on: 'answer', to: 'queued', bump: true, guard: guardAll(['can_answer', 'FORBIDDEN']),
    effects: () => [{ type: 'deliver_answer' }, { type: 'seed', from: ['handover', 'answer'] }, offer, feed('requeued_answered')] },
  { id: '12', from: ['running', 'quiet', 'blocked'], on: 'host_suspending', to: 'suspended', fenced: 'event', dark: true,
    effects: () => [feed('suspended')] },
  { id: '13', from: ['suspended'], on: 'hb', to: 'RECOVER', fenced: 'event', effects: () => recoverEffects() },
  { id: '14', from: ['running', 'quiet', 'blocked'], on: 'hb_timeout', to: 'unresponsive', dark: true,
    effects: () => [feed('unresponsive')] },
  { id: '15', from: ['unresponsive'], on: 'hb', to: 'RECOVER', fenced: 'event', effects: () => recoverEffects() },
  { id: '16', from: ['unresponsive'], on: 'orphan_timeout', to: 'orphaned',
    guard: (c, ev, ctx) => (ctx.hub_uptime_ms != null && ctx.hub_uptime_ms < T_ORPHAN_MS ? { code: 'BOOT_GRACE', message: 'no orphaning before hub uptime ≥ T_orphan' }
      : ctx.tunnel_ok === false ? { code: 'TUNNEL_DOWN', message: 'tunnel self-probe unhealthy: orphaning suspended' } : null),
    effects: () => orphanEffects },
  { id: '17', from: ['suspended'], on: 'suspend_timeout', to: 'orphaned', effects: () => orphanEffects },
  { id: '18', from: ['orphaned'], on: 'hb', to: 'RECOVER', fenced: 'event',
    effects: () => recoverEffects([{ type: 'relabel_orphan' }]) },
  { id: '19', from: ['running', 'quiet', 'blocked', 'claimed', 'suspended', 'unresponsive', 'orphaned'], on: 'hub_boot', to: 'reconnecting', dark: true,
    patch: (c) => ({ pre_reconnect_state: c.run_state }), effects: () => [feed('reconnecting')] },
  // Decision D5: a second boot while still reconnecting keeps the original
  // pre_reconnect_state; handing_over rides through a boot (its 3-min timer
  // restarts from the new boot).
  { id: '19r', from: ['reconnecting'], on: 'hub_boot', to: 'SAME' },
  { id: '19h', from: ['handing_over'], on: 'hub_boot', to: 'SAME', effects: () => [{ type: 'restart_state_timer' }] },
  { id: '20', from: ['reconnecting'], on: 'hb', to: 'RECOVER', fenced: 'event',
    effects: (c) => recoverEffects(c.pre_reconnect_state === 'orphaned' ? [{ type: 'relabel_orphan' }] : []) },
  { id: '21', from: ['reconnecting'], on: 'reconnect_timeout',
    to: (c) => (c.pre_reconnect_state === 'suspended' ? 'suspended' : 'unresponsive') },
  { id: '22', from: ACTIVE_LIST, on: 'run_failed', to: 'failed', fenced: 'event',
    guard: (c, ev) => (RUNNER_FAIL_KINDS.includes(ev.fail_kind) ? null : { code: 'VALIDATION', message: `bad fail_kind ${ev.fail_kind}` }),
    patch: (c, ev) => ({ fail_kind: ev.fail_kind }),
    effects: (c, ev) => [...endRun(`failed:${ev.fail_kind}`), { type: 'handover_freeze' }, notify('failed'), feed('failed', { fail_kind: ev.fail_kind, reason: ev.reason ?? null })] },
  { id: '23', from: [...ACTIVE_LIST, 'parked'], on: 'stop', to: 'failed', bump: true, guard: guardAll(['can_stop', 'FORBIDDEN']),
    patch: () => ({ fail_kind: 'stopped' }),
    effects: (c, ev) => [...(c.run_state === 'parked' ? [] : [runnerCmd(c, 'stop'), ...endRun('stopped')]), { type: 'handover_freeze' }, notify('failed'), feed('stopped', { by: ev.by ?? null })] },
  { id: '24', from: L, on: 'release', to: 'queued', fenced: 'event', bump: true, when: (c, ev) => ev.requeue === true,
    guard: guardAll(['policy_allows_requeue', 'POLICY_DENIED']),
    effects: (c, ev) => [...endRun('released_requeue'), { type: 'seed', from: ['handover'] }, offer, feed('released', { requeue: true, reason: ev.reason ?? null })] },
  { id: '25', from: L, on: 'release', to: 'failed', fenced: 'event', when: (c, ev) => ev.requeue !== true,
    patch: () => ({ fail_kind: 'released' }),
    effects: (c, ev) => [...endRun('released'), { type: 'handover_freeze' }, notify('failed'), feed('released', { requeue: false, reason: ev.reason ?? null })] },
  { id: '26', from: ['failed'], on: 'retry', to: 'queued', bump: true, guard: both(needsRequestId, canWrite),
    effects: (c, ev) => [{ type: 'dispatch_create', request_id: ev.request_id, target_member_id: ev.target_member_id ?? null, needs_confirm: false }, { type: 'seed', from: ['handover'] }, offer, feed('retried')] },
  { id: '27', from: ['failed', 'orphaned', 'parked'], on: 'take_over', to: 'handed_over', bump: true, guard: canWrite,
    patch: (c, ev) => ({ handover_target: { kind: 'member', member_id: ev.by ?? null }, handover_provenance: 'takeover' }),
    effects: (c, ev) => [...(c.run_state === 'orphaned' ? [runnerCmd(c, 'stop'), ...endRun('taken_over')] : []), handoffMemory('takeover'), feed('taken_over', { by: ev.by ?? null })] },
  { id: '27a', from: L, on: 'hand_over', to: 'handing_over', guard: both(guardAll(['can_hand_over', 'FORBIDDEN']),
    (c, ev) => (['queue', 'member', 'self'].includes(ev.target?.kind) ? null : { code: 'VALIDATION', message: 'target.kind must be queue|member|self' })),
    patch: (c, ev) => ({ handover_target: ev.target }),
    effects: (c, ev) => [runnerCmd(c, 'handover_begin', { wait_ms: HANDOVER_WAIT_MS }), feed('handing_over', { by: ev.by ?? null })] },
  { id: '27b', from: ['handing_over'], on: 'handover_complete', to: 'handed_over', fenced: 'event', bump: true,
    patch: () => ({ handover_provenance: 'checkpoint_complete' }), effects: (c) => handedOverEffects(c, 'checkpoint_complete') },
  { id: '27c', from: ['handing_over'], on: 'handover_timeout', to: 'handed_over', bump: true,
    patch: () => ({ handover_provenance: 'checkpoint_incomplete' }), effects: (c) => handedOverEffects(c, 'checkpoint_incomplete') },
  { id: '27d', from: ['handing_over'], on: 'hb_timeout', to: 'handed_over', bump: true,
    patch: () => ({ handover_provenance: 'checkpoint_incomplete' }), effects: (c) => handedOverEffects(c, 'checkpoint_incomplete') },
  { id: '28', from: ['unresponsive', 'suspended'], on: 'take_over', to: 'handed_over', bump: true,
    guard: both(canWrite, guardAll(['confirmed', 'CONFIRM_REQUIRED'])),
    patch: (c, ev) => ({ handover_target: { kind: 'member', member_id: ev.by ?? null }, handover_provenance: 'takeover' }),
    effects: (c, ev) => [runnerCmd(c, 'stop'), ...endRun('taken_over'), handoffMemory('takeover'), feed('taken_over', { by: ev.by ?? null })] },
  { id: '29', from: ['handed_over'], on: 'redispatch', to: 'queued', guard: both(needsRequestId, canWrite),
    patch: () => ({ handover_target: null }),
    effects: (c, ev, ctx) => [{ type: 'dispatch_create', request_id: ev.request_id, target_member_id: ev.target_member_id ?? null, needs_confirm: !!ctx.needs_confirm }, { type: 'seed', from: ['handover'] }, offer, feed('dispatched', { needs_confirm: !!ctx.needs_confirm })] },
  { id: '30', from: ['handed_over'], on: 'take_myself', to: 'todo', guard: canWrite,
    patch: () => ({ handover_target: null }),
    effects: (c, ev) => [{ type: 'assign', member_id: ev.by ?? null, role: 'owner' }, feed('human_on_it', { by: ev.by ?? null })] },
  // Decision D7: board_complete is itself activity, so quiet → in_review is allowed too.
  { id: '31', from: ['running', 'quiet'], on: 'complete', to: 'in_review', fenced: 'event', guard: guardAll(['evidence_ok', 'EVIDENCE_MISSING']),
    effects: () => [...endRun('complete'), feed('in_review')] },
  { id: '32', from: ['in_review'], on: 'request_changes', to: 'queued', bump: true, guard: both(needsRequestId, canWrite),
    effects: (c, ev) => [{ type: 'dispatch_create', request_id: ev.request_id, target_member_id: ev.target_member_id ?? null, needs_confirm: false }, { type: 'seed', from: ['handover', 'review'] }, offer, feed('changes_requested', { by: ev.by ?? null })] },
  { id: '33', from: ['in_review'], on: 'pr_closed', to: 'todo', effects: (c, ev) => [feed('pr_closed_unmerged', { pr: ev.pr ?? null, by: ev.by ?? null })] },
  { id: '34', from: ['in_review'], on: 'pr_merged', to: 'done', effects: (c, ev) => [feed('merged', { pr: ev.pr ?? null, by: ev.by ?? null })] },
  { id: '34b', from: ['in_review'], on: 'approve_done', to: 'done',
    guard: (c, ev, ctx) => (ev.by_run ? { code: 'FORBIDDEN', message: 'an agent cannot approve done' } : canWrite(c, ev, ctx)),
    effects: (c, ev) => [feed('approved_done', { by: ev.by ?? null })] },

  // ── documented no-ops (fenced ones still reject a stale fence) ───────────
  { id: 'n-hb', from: ['claimed', 'running', 'quiet', 'blocked', 'handing_over'], on: 'hb', to: 'SAME', fenced: 'event' },
  { id: 'n-activity', from: ['running', 'blocked', 'handing_over', 'suspended', 'reconnecting', 'unresponsive', 'orphaned'], on: 'activity', to: 'SAME', fenced: 'event' },
  { id: 'n-activity-delayed', from: ['claimed', 'quiet'], on: 'activity', to: 'SAME', fenced: 'event', when: (c, ev) => !!ev.delayed },
  // #5a note: lid-close during claimed is intentionally not suspended.
  { id: 'n-suspend-claimed', from: ['claimed', 'handing_over', 'suspended'], on: 'host_suspending', to: 'SAME', fenced: 'event' },
]);

function handedOverEffects(card, provenance) {
  const t = card.handover_target;
  const follow = t?.kind === 'queue' ? [{ type: 'follow_up', event: { type: 'redispatch', target_member_id: null } }]
    : t?.kind === 'member' ? [{ type: 'follow_up', event: { type: 'redispatch', target_member_id: t.member_id } }]
      : t?.kind === 'self' ? [{ type: 'follow_up', event: { type: 'take_myself' } }] : [];
  return [...endRun('handed_over'), handoffMemory(provenance), feed('handed_over', { provenance }), ...follow];
}

const BY_KEY = new Map();
for (const row of TRANSITIONS) {
  for (const f of row.from) {
    const k = `${f}|${row.on}`;
    if (!BY_KEY.has(k)) BY_KEY.set(k, []);
    BY_KEY.get(k).push(row);
  }
}

export function rowsFor(state, eventType) {
  return BY_KEY.get(`${state}|${eventType}`) ?? [];
}

function err(code, message, rule) {
  return { ok: false, error: { code, message }, ...(rule ? { rule } : {}) };
}

/** See the file header. */
export function step(card, event, ctx = {}) {
  const from = card.run_state ?? 'todo';
  if (!STATES.includes(from)) return err('VALIDATION', `unknown state ${from}`);
  if (!event || !(event.type in EVENTS)) return err('VALIDATION', `unknown event ${event?.type}`);

  // Idempotent dispatch (#1): a duplicate request id returns the existing run.
  if (ctx.duplicate_request) return { ok: true, card, effects: [{ type: 'return_existing' }], rule: 'dup', from, to: from };

  const row = rowsFor(from, event.type).find((r) => !r.when || r.when(card, event, ctx));
  if (!row) return err('ILLEGAL_TRANSITION', `${event.type} is not allowed from ${from}`);

  if (row.fenced === 'event' && event.fence !== card.fence) return err('FENCED', `fence ${event.fence} is not current (${card.fence})`, row.id);
  if (row.fenced === 'expected' && event.expected_fence !== card.fence) return err('FENCED', `expected fence ${event.expected_fence} is not current (${card.fence})`, row.id);

  const g = row.guard?.(card, event, ctx);
  if (g) return err(g.code, g.message, row.id);

  let to = row.to;
  if (to === 'SAME') to = from;
  else if (to === 'RECOVER') to = recoverTo(card);
  else if (typeof to === 'function') to = to(card, event, ctx);

  const next = { ...card, run_state: to };
  if (row.dark) next.resume_to = darkResume(card);
  Object.assign(next, row.patch?.(card, event, ctx) ?? {});

  // Field hygiene, so no stale value outlives the state it belongs to.
  if (!DARK.has(to)) next.resume_to = null;
  if (to !== 'reconnecting') next.pre_reconnect_state = null;
  if (to !== 'blocked' && to !== 'parked' && !(DARK.has(to) && next.resume_to === 'blocked')) next.blocked_kind = null;
  if (to !== 'failed') next.fail_kind = null;
  if (to !== 'handing_over' && to !== 'handed_over') { next.handover_target = null; next.handover_provenance = null; }

  const effects = [];
  if (row.bump) {
    next.fence = card.fence + 1;
    effects.push({ type: 'fence_bump', from: card.fence, to: next.fence }, { type: 'release_path_locks' });
  }
  effects.push(...(row.effects?.(card, event, ctx) ?? []));
  if (from === 'orphaned' && to !== 'orphaned') effects.push({ type: 'notify_cancel', rule: 'orphaned' });
  if (to !== from || row.bump) effects.push({ type: 'state_changed', from, to, column: columnOf(to) });

  return { ok: true, card: next, effects, rule: row.id, from, to };
}
