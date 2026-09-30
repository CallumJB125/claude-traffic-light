import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  step, TRANSITIONS, STATES, ACTIVE, DARK, columnOf, fromDb, toDb, EVENTS, rowsFor,
} from '../states.js';
import { ORPHAN_NOTIFY_MS, HANDOVER_WAIT_MS } from '../liveness.js';

const F = 5;
const card = (run_state, extra = {}) => ({
  id: 'c1', run_state, fence: F, blocked_kind: null, fail_kind: null, resume_to: null,
  pre_reconnect_state: null, handover_target: null, handover_provenance: null, ...extra,
});
// Every guard satisfied; individual tests take keys away.
const OK = {
  has_repo: true, can_write: true, policy_ok: true, can_cancel: true, is_target_member: true,
  repo_advertised: true, runner_accepts: true, no_active_run: true, can_answer: true, can_stop: true,
  policy_allows_requeue: true, can_hand_over: true, confirmed: true, evidence_ok: true,
  require_plan_approval: true, hub_uptime_ms: 3_600_000, tunnel_ok: true,
};
const types = (r) => r.effects.map((e) => e.type);
const eff = (r, type) => r.effects.find((e) => e.type === type);

// One case per TRANSITIONS row (design §4.1), keyed by rule id.
const CASES = [
  { rule: '1', card: card('todo'), ev: { type: 'dispatch', request_id: 'rq1' }, to: 'queued', has: ['dispatch_create', 'offer_to_runners'] },
  { rule: '1a', card: card('queued'), ev: { type: 'queue_nudge' }, to: 'queued', has: ['notify', 'mark_nudged'] },
  { rule: '2', card: card('queued'), ev: { type: 'cancel' }, to: 'todo', has: ['dispatch_cancel'] },
  { rule: '2b', card: card('queued'), ev: { type: 'decline' }, to: 'todo', has: ['dispatch_cancel'] },
  { rule: '3', card: card('queued'), ev: { type: 'claim', expected_fence: F }, to: 'claimed', bump: true, has: ['run_create', 'lease_create'] },
  { rule: '4', card: card('claimed'), ev: { type: 'activity', fence: F }, to: 'running' },
  { rule: '5', card: card('claimed'), ev: { type: 'prep_failed', fence: F, cause: 'disk' }, to: 'queued', bump: true, has: ['lease_release', 'run_end', 'offer_to_runners'] },
  { rule: '5a', card: card('claimed'), ev: { type: 'hb_timeout' }, to: 'unresponsive', resume_to: 'claimed' },
  { rule: '5b', card: card('unresponsive', { resume_to: 'claimed' }), ev: { type: 'claim_timeout' }, to: 'queued', bump: true, resume_to: null, has: ['run_end', 'offer_to_runners'] },
  { rule: '6', card: card('running'), ev: { type: 'quiet_timeout' }, to: 'quiet' },
  { rule: '7', card: card('quiet'), ev: { type: 'activity', fence: F }, to: 'running' },
  { rule: '8', card: card('running'), ev: { type: 'block', fence: F, kind: 'permission' }, to: 'blocked', has: ['notify'] },
  { rule: '9', card: card('blocked', { blocked_kind: 'permission' }), ev: { type: 'answer', by: 'm1' }, to: 'running', has: ['deliver_answer'] },
  { rule: '9b', card: card('blocked', { blocked_kind: 'permission' }), ev: { type: 'answer' }, ctx: { open_asks_remaining: 1 }, to: 'blocked', has: ['deliver_answer'] },
  { rule: '9d', card: card('suspended', { resume_to: 'blocked', blocked_kind: 'question' }), ev: { type: 'answer' }, to: 'suspended', resume_to: 'quiet', has: ['deliver_answer'] },
  { rule: '9w', card: card('blocked', { blocked_kind: 'permission' }), ev: { type: 'withdraw', fence: F }, to: 'running', has: ['feed'] },
  { rule: '9wb', card: card('blocked', { blocked_kind: 'permission' }), ev: { type: 'withdraw', fence: F }, ctx: { open_asks_remaining: 1 }, to: 'blocked', has: ['feed'] },
  { rule: '9wd', card: card('unresponsive', { resume_to: 'blocked', blocked_kind: 'permission' }), ev: { type: 'withdraw', fence: F }, to: 'unresponsive', resume_to: 'quiet', has: ['feed'] },
  { rule: '10', card: card('blocked', { blocked_kind: 'question' }), ev: { type: 'park_timeout' }, to: 'parked', bump: true, has: ['runner_command', 'lease_release', 'notify'] },
  { rule: '11', card: card('parked', { blocked_kind: 'question' }), ev: { type: 'answer' }, to: 'queued', bump: true, has: ['seed', 'offer_to_runners'] },
  { rule: '12', card: card('running'), ev: { type: 'host_suspending', fence: F }, to: 'suspended', resume_to: 'quiet' },
  { rule: '13', card: card('suspended', { resume_to: 'quiet' }), ev: { type: 'hb', fence: F }, to: 'quiet', resume_to: null, has: ['lease_mark_wake'] },
  { rule: '14', card: card('quiet'), ev: { type: 'hb_timeout' }, to: 'unresponsive', resume_to: 'quiet' },
  { rule: '15', card: card('unresponsive', { resume_to: 'quiet' }), ev: { type: 'hb', fence: F }, to: 'quiet', has: ['lease_mark_wake'] },
  { rule: '16', card: card('unresponsive', { resume_to: 'quiet' }), ev: { type: 'orphan_timeout' }, to: 'orphaned', resume_to: 'quiet', has: ['notify_after', 'handover_freeze'] },
  { rule: '17', card: card('suspended', { resume_to: 'blocked', blocked_kind: 'permission' }), ev: { type: 'suspend_timeout' }, to: 'orphaned', resume_to: 'blocked', has: ['notify_after'] },
  { rule: '18', card: card('orphaned', { resume_to: 'quiet' }), ev: { type: 'hb', fence: F }, to: 'quiet', has: ['relabel_orphan', 'notify_cancel', 'lease_mark_wake'] },
  { rule: '19', card: card('blocked', { blocked_kind: 'permission' }), ev: { type: 'hub_boot' }, to: 'reconnecting', resume_to: 'blocked', pre: 'blocked' },
  { rule: '19r', card: card('reconnecting', { resume_to: 'quiet', pre_reconnect_state: 'suspended' }), ev: { type: 'hub_boot' }, to: 'reconnecting', pre: 'suspended' },
  { rule: '19h', card: card('handing_over'), ev: { type: 'hub_boot' }, to: 'handing_over', has: ['restart_state_timer'] },
  { rule: '20', card: card('reconnecting', { resume_to: 'blocked', blocked_kind: 'permission', pre_reconnect_state: 'blocked' }), ev: { type: 'hb', fence: F }, to: 'blocked', pre: null, has: ['lease_mark_wake'] },
  { rule: '21', card: card('reconnecting', { resume_to: 'quiet', pre_reconnect_state: 'suspended' }), ev: { type: 'reconnect_timeout' }, to: 'suspended', resume_to: 'quiet', pre: null },
  { rule: '22', card: card('running'), ev: { type: 'run_failed', fence: F, fail_kind: 'error' }, to: 'failed', has: ['lease_release', 'run_end', 'notify', 'handover_freeze'] },
  { rule: '23', card: card('running'), ev: { type: 'stop', by: 'm1' }, to: 'failed', bump: true, has: ['runner_command', 'lease_release', 'notify'] },
  { rule: '24', card: card('running'), ev: { type: 'release', fence: F, requeue: true, reason: 'x' }, to: 'queued', bump: true, has: ['seed', 'offer_to_runners', 'run_end'] },
  { rule: '25', card: card('quiet'), ev: { type: 'release', fence: F, requeue: false, reason: 'needs product decision' }, to: 'failed', has: ['run_end', 'notify'] },
  { rule: '26', card: card('failed', { fail_kind: 'error' }), ev: { type: 'retry', request_id: 'rq2' }, to: 'queued', bump: true, has: ['dispatch_create', 'seed'] },
  { rule: '27', card: card('orphaned', { resume_to: 'quiet' }), ev: { type: 'take_over', by: 'sam' }, to: 'handed_over', bump: true, has: ['runner_command', 'memory_write', 'lease_release'] },
  { rule: '27a', card: card('running'), ev: { type: 'hand_over', target: { kind: 'queue' }, by: 'callum' }, to: 'handing_over', has: ['runner_command'] },
  { rule: '27b', card: card('handing_over', { handover_target: { kind: 'queue' } }), ev: { type: 'handover_complete', fence: F }, to: 'handed_over', bump: true, has: ['memory_write', 'lease_release', 'follow_up'] },
  { rule: '27c', card: card('handing_over', { handover_target: { kind: 'self' } }), ev: { type: 'handover_timeout' }, to: 'handed_over', bump: true, has: ['memory_write', 'follow_up'] },
  { rule: '27d', card: card('handing_over', { handover_target: { kind: 'member', member_id: 'sam' } }), ev: { type: 'hb_timeout' }, to: 'handed_over', bump: true, has: ['memory_write', 'follow_up'] },
  { rule: '28', card: card('suspended', { resume_to: 'quiet' }), ev: { type: 'take_over', by: 'sam' }, to: 'handed_over', bump: true, has: ['runner_command', 'lease_release', 'memory_write'] },
  { rule: '29', card: card('handed_over'), ev: { type: 'redispatch', request_id: 'rq3' }, to: 'queued', has: ['dispatch_create', 'seed'] },
  { rule: '30', card: card('handed_over'), ev: { type: 'take_myself', by: 'sam' }, to: 'todo', has: ['assign'] },
  { rule: '31', card: card('running'), ev: { type: 'complete', fence: F }, to: 'in_review', has: ['lease_release', 'run_end'] },
  { rule: '32', card: card('in_review'), ev: { type: 'request_changes', request_id: 'rq4' }, to: 'queued', bump: true, has: ['seed', 'dispatch_create'] },
  { rule: '33', card: card('in_review'), ev: { type: 'pr_closed', pr: 1042 }, to: 'todo' },
  { rule: '34', card: card('in_review'), ev: { type: 'pr_merged', pr: 1042 }, to: 'done' },
  { rule: '34b', card: card('in_review'), ev: { type: 'approve_done', by: 'james' }, to: 'done' },
  { rule: 'n-hb', card: card('running'), ev: { type: 'hb', fence: F }, to: 'running', none: true },
  { rule: 'n-activity', card: card('suspended', { resume_to: 'quiet' }), ev: { type: 'activity', fence: F }, to: 'suspended', none: true },
  { rule: 'n-activity-delayed', card: card('quiet'), ev: { type: 'activity', fence: F, delayed: true }, to: 'quiet', none: true },
  { rule: 'n-suspend-claimed', card: card('claimed'), ev: { type: 'host_suspending', fence: F }, to: 'claimed', none: true },
];

for (const c of CASES) {
  test(`§4.1 #${c.rule}: ${c.card.run_state} --${c.ev.type}--> ${c.to}`, () => {
    const r = step(c.card, c.ev, { ...OK, ...(c.ctx ?? {}) });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.rule, c.rule);
    assert.equal(r.card.run_state, c.to);
    assert.equal(r.card.fence, c.bump ? F + 1 : F);
    if (c.bump) {
      assert.deepEqual(eff(r, 'fence_bump'), { type: 'fence_bump', from: F, to: F + 1 });
      assert.ok(types(r).includes('release_path_locks'), 'lease-bound path locks drop on a fence bump');
    } else assert.ok(!types(r).includes('fence_bump'));
    if ('resume_to' in c) assert.equal(r.card.resume_to, c.resume_to);
    if ('pre' in c) assert.equal(r.card.pre_reconnect_state, c.pre);
    for (const t of c.has ?? []) assert.ok(types(r).includes(t), `missing effect ${t}: ${types(r)}`);
    if (c.none) assert.deepEqual(r.effects, []);
    assert.notEqual(r.card, c.card, 'step never mutates its input');
  });
}

test('every TRANSITIONS row has a case, and every case names a real row', () => {
  const ids = new Set(TRANSITIONS.map((r) => r.id));
  const covered = new Set(CASES.map((c) => c.rule));
  assert.deepEqual([...ids].filter((i) => !covered.has(i)), []);
  assert.deepEqual([...covered].filter((i) => !ids.has(i)), []);
  assert.equal(ids.size, TRANSITIONS.length, 'row ids are unique');
});

test('every row names known states and events; selectors never overlap', () => {
  for (const r of TRANSITIONS) {
    for (const f of r.from) assert.ok(STATES.includes(f), `${r.id}: bad from ${f}`);
    assert.ok(r.on in EVENTS, `${r.id}: bad event ${r.on}`);
    if (typeof r.to === 'string' && !['SAME', 'RECOVER'].includes(r.to)) assert.ok(STATES.includes(r.to), `${r.id}: bad to`);
  }
  // Rows sharing from+on must all have `when` selectors (else the first shadows the rest).
  for (const s of STATES) for (const e of Object.keys(EVENTS)) {
    const rows = rowsFor(s, e);
    if (rows.length > 1) for (const r of rows) assert.ok(r.when, `${s}|${e}: row ${r.id} needs a when selector`);
  }
});

// ── resume_to: set on EVERY entry into a dark state, restored on every recovery ──

test('DARK: resume_to per the §4 table', () => {
  const into = (from, ev, extra = {}) => step(card(from, extra), ev, OK).card.resume_to;
  assert.equal(into('blocked', { type: 'host_suspending', fence: F }, { blocked_kind: 'permission' }), 'blocked');
  assert.equal(into('running', { type: 'host_suspending', fence: F }), 'quiet');
  assert.equal(into('quiet', { type: 'hb_timeout' }), 'quiet');
  assert.equal(into('blocked', { type: 'hb_timeout' }, { blocked_kind: 'permission' }), 'blocked');
  assert.equal(into('claimed', { type: 'hb_timeout' }), 'claimed');
  assert.equal(into('claimed', { type: 'hub_boot' }), 'claimed');
  // already dark → kept
  assert.equal(into('suspended', { type: 'hub_boot' }, { resume_to: 'blocked', blocked_kind: 'permission' }), 'blocked');
  assert.equal(into('unresponsive', { type: 'orphan_timeout' }, { resume_to: 'claimed' }), 'claimed');
  assert.equal(into('orphaned', { type: 'hub_boot' }, { resume_to: 'blocked', blocked_kind: 'question' }), 'blocked');
});

test('every successful step leaves resume_to set iff dark, pre_reconnect_state iff reconnecting', () => {
  for (const c of CASES) {
    const r = step(c.card, c.ev, { ...OK, ...(c.ctx ?? {}) });
    const s = r.card.run_state;
    assert.equal(r.card.resume_to != null, DARK.has(s), `rule ${c.rule}: resume_to=${r.card.resume_to} in ${s}`);
    if (s !== 'reconnecting') assert.equal(r.card.pre_reconnect_state, null, `rule ${c.rule}`);
    if (s !== 'failed') assert.equal(r.card.fail_kind, null, `rule ${c.rule}`);
  }
});

test('RECOVER never goes straight to running (Power Nap guard)', () => {
  for (const r of TRANSITIONS.filter((x) => x.to === 'RECOVER')) {
    for (const from of r.from) {
      for (const rt of ['quiet', 'blocked', 'claimed']) {
        const out = step(card(from, { resume_to: rt, blocked_kind: rt === 'blocked' ? 'permission' : null, pre_reconnect_state: from === 'reconnecting' ? 'running' : null }), { type: 'hb', fence: F }, OK);
        assert.equal(out.ok, true);
        assert.notEqual(out.card.run_state, 'running');
        assert.equal(out.card.run_state, rt);
      }
    }
  }
});

test('exit (i): a blocked card keeps "Needs you" through sleep, partition and hub restart', () => {
  let c = card('blocked', { blocked_kind: 'permission' });
  // sleep
  c = step(c, { type: 'host_suspending', fence: F }, OK).card;
  assert.equal(c.run_state, 'suspended');
  assert.equal(c.blocked_kind, 'permission');
  // hub restart while asleep
  c = step(c, { type: 'hub_boot' }, OK).card;
  assert.equal(c.pre_reconnect_state, 'suspended');
  // no HB by TTL: back to suspended, 8 h grace kept
  c = step(c, { type: 'reconnect_timeout' }, OK).card;
  assert.equal(c.run_state, 'suspended');
  assert.equal(c.resume_to, 'blocked');
  // wake
  c = step(c, { type: 'hb', fence: F }, OK).card;
  assert.equal(c.run_state, 'blocked');
  assert.equal(c.blocked_kind, 'permission');
  // partition → unresponsive → orphaned → back
  c = step(c, { type: 'hb_timeout' }, OK).card;
  c = step(c, { type: 'orphan_timeout' }, OK).card;
  assert.equal(c.run_state, 'orphaned');
  assert.equal(c.blocked_kind, 'permission');
  const back = step(c, { type: 'hb', fence: F }, OK);
  assert.equal(back.card.run_state, 'blocked');
  assert.ok(types(back).includes('relabel_orphan'));
});

test('#21: reconnect timeout without prior suspension → unresponsive, then orphaned at T_orphan', () => {
  let c = step(card('running'), { type: 'hub_boot' }, OK).card;
  c = step(c, { type: 'reconnect_timeout' }, OK).card;
  assert.equal(c.run_state, 'unresponsive');
  assert.equal(c.resume_to, 'quiet');
  c = step(c, { type: 'orphan_timeout' }, OK).card;
  assert.equal(c.run_state, 'orphaned');
});

test('#20: recovery of a card orphaned before the hub restart relabels the orphan', () => {
  const boot = step(card('orphaned', { resume_to: 'quiet' }), { type: 'hub_boot' }, OK);
  assert.ok(types(boot).includes('notify_cancel'), 'leaving orphaned cancels the pending orphan notification');
  const r = step(boot.card, { type: 'hb', fence: F }, OK);
  assert.equal(r.card.run_state, 'quiet');
  assert.ok(types(r).includes('relabel_orphan'));
});

// ── fencing ────────────────────────────────────────────────────────────────

test('any runner event with a stale fence → FENCED (zombie)', () => {
  const runnerEvents = [
    ['claimed', { type: 'activity' }], ['quiet', { type: 'activity' }], ['running', { type: 'block', kind: 'permission' }],
    ['running', { type: 'host_suspending' }], ['suspended', { type: 'hb' }], ['unresponsive', { type: 'hb' }],
    ['orphaned', { type: 'hb' }], ['reconnecting', { type: 'hb' }], ['running', { type: 'hb' }],
    ['running', { type: 'run_failed', fail_kind: 'error' }], ['running', { type: 'release', requeue: false }],
    ['running', { type: 'complete' }], ['handing_over', { type: 'handover_complete' }], ['claimed', { type: 'prep_failed' }],
  ];
  for (const [s, ev] of runnerEvents) {
    const r = step(card(s, DARK.has(s) ? { resume_to: 'quiet' } : {}), { ...ev, fence: F - 1 }, OK);
    assert.equal(r.ok, false, `${s} ${ev.type}`);
    assert.equal(r.error.code, 'FENCED', `${s} ${ev.type}`);
  }
});

test('claim CAS: expected fence must match; a second claim on a claimed card is illegal', () => {
  assert.equal(step(card('queued'), { type: 'claim', expected_fence: F - 1 }, OK).error.code, 'FENCED');
  assert.equal(step(card('claimed'), { type: 'claim', expected_fence: F }, OK).error.code, 'ILLEGAL_TRANSITION');
});

test('exit (e) / (h): after take over, the old run is fenced everywhere', () => {
  const taken = step(card('orphaned', { resume_to: 'quiet' }), { type: 'take_over', by: 'sam' }, OK).card;
  assert.equal(taken.fence, F + 1);
  for (const ev of [{ type: 'hb', fence: F }, { type: 'activity', fence: F }, { type: 'run_failed', fence: F, fail_kind: 'error' }]) {
    const r = step(taken, ev, OK);
    assert.equal(r.ok, false);
  }
  const cmd = eff(step(card('orphaned', { resume_to: 'quiet' }), { type: 'take_over', by: 'sam' }, OK), 'runner_command');
  assert.equal(cmd.cmd, 'stop');
  assert.equal(cmd.fence, F, 'the command names the fence the zombie holds');
});

test('fence bumps on claim, requeue, takeover, stop and park (§5.3)', () => {
  const bumping = TRANSITIONS.filter((r) => r.bump).map((r) => r.id).sort();
  assert.deepEqual(bumping, ['10', '11', '23', '24', '26', '27', '27b', '27c', '27d', '28', '3', '32', '5', '5b'].sort());
});

// ── critic-driven edges ────────────────────────────────────────────────────

test('#22: failure from every active state, including unresponsive/orphaned after a supervisor restart', () => {
  for (const s of ACTIVE) {
    const r = step(card(s, DARK.has(s) ? { resume_to: 'quiet', pre_reconnect_state: s === 'reconnecting' ? 'running' : null } : {}), { type: 'run_failed', fence: F, fail_kind: 'error', reason: 'supervisor crash' }, OK);
    assert.equal(r.ok, true, s);
    assert.equal(r.card.run_state, 'failed');
    assert.equal(r.card.fail_kind, 'error');
    assert.equal(r.card.resume_to, null);
    assert.ok(r.effects.some((e) => e.type === 'notify' && e.rule === 'failed'), 'failed notifies immediately');
  }
});

test('#22: runners cannot report stopped/released through run_failed', () => {
  for (const k of ['stopped', 'released', 'bogus']) {
    assert.equal(step(card('running'), { type: 'run_failed', fence: F, fail_kind: k }, OK).error.code, 'VALIDATION');
  }
  for (const k of ['network', 'limit', 'error', 'budget']) assert.equal(step(card('running'), { type: 'run_failed', fence: F, fail_kind: k }, OK).card.fail_kind, k);
});

test('#23: Stop works from every active state and parked', () => {
  for (const s of [...ACTIVE, 'parked']) {
    const r = step(card(s, DARK.has(s) ? { resume_to: 'quiet', pre_reconnect_state: s === 'reconnecting' ? 'running' : null } : {}), { type: 'stop', by: 'callum' }, OK);
    assert.equal(r.ok, true, s);
    assert.equal(r.card.run_state, 'failed');
    assert.equal(r.card.fail_kind, 'stopped');
    assert.equal(r.card.fence, F + 1);
    assert.equal(types(r).includes('runner_command'), s !== 'parked', `${s}: a parked card has no process to stop`);
  }
  assert.equal(step(card('running'), { type: 'stop' }, { ...OK, can_stop: false }).error.code, 'FORBIDDEN');
});

test('#24: requeue refused by policy → POLICY_DENIED (the agent gets an error, state unchanged)', () => {
  const r = step(card('running'), { type: 'release', fence: F, requeue: true }, { ...OK, policy_allows_requeue: false });
  assert.equal(r.error.code, 'POLICY_DENIED');
});

test('#28: take over of a suspended/unresponsive card needs confirm', () => {
  for (const s of ['suspended', 'unresponsive']) {
    assert.equal(step(card(s, { resume_to: 'quiet' }), { type: 'take_over' }, { ...OK, confirmed: false }).error.code, 'CONFIRM_REQUIRED');
  }
  assert.equal(step(card('reconnecting', { resume_to: 'quiet', pre_reconnect_state: 'running' }), { type: 'take_over' }, OK).error.code, 'ILLEGAL_TRANSITION');
});

test('#16: no orphaning in hub boot grace or while the tunnel probe is unhealthy', () => {
  const c = card('unresponsive', { resume_to: 'quiet' });
  assert.equal(step(c, { type: 'orphan_timeout' }, { ...OK, hub_uptime_ms: 60_000 }).error.code, 'BOOT_GRACE');
  assert.equal(step(c, { type: 'orphan_timeout' }, { ...OK, tunnel_ok: false }).error.code, 'TUNNEL_DOWN');
});

test('N-rules: orphaned notifies only after ORPHAN_NOTIFY_MS; suspended/unresponsive/reconnecting/quiet never notify', () => {
  const o = step(card('unresponsive', { resume_to: 'quiet' }), { type: 'orphan_timeout' }, OK);
  assert.deepEqual(eff(o, 'notify_after'), { type: 'notify_after', rule: 'orphaned', after_ms: ORPHAN_NOTIFY_MS });
  assert.ok(!types(o).includes('notify'));
  for (const c of CASES) {
    const r = step(c.card, c.ev, { ...OK, ...(c.ctx ?? {}) });
    if (['suspended', 'unresponsive', 'reconnecting', 'quiet'].includes(r.card.run_state)) {
      assert.ok(!types(r).includes('notify'), `rule ${c.rule} must not push a notification`);
    }
  }
  assert.ok(step(card('blocked', { blocked_kind: 'question' }), { type: 'park_timeout' }, OK).effects.some((e) => e.type === 'notify' && e.rule === 'parked'));
});

test('#8: blocked kinds, plan needs require_plan_approval, extra requests keep blocked', () => {
  for (const k of ['permission', 'question', 'clarify', 'decision', 'conflict', 'loop']) {
    assert.equal(step(card('quiet'), { type: 'block', fence: F, kind: k }, { ...OK, require_plan_approval: false }).card.blocked_kind, k);
  }
  assert.equal(step(card('running'), { type: 'block', fence: F, kind: 'plan' }, { ...OK, require_plan_approval: false }).error.code, 'POLICY_DENIED');
  assert.equal(step(card('running'), { type: 'block', fence: F, kind: 'nope' }, OK).error.code, 'VALIDATION');
  const again = step(card('blocked', { blocked_kind: 'permission' }), { type: 'block', fence: F, kind: 'permission' }, OK);
  assert.equal(again.card.run_state, 'blocked');
  assert.ok(types(again).includes('notify'));
});

test('9d: answering while dark with more asks open keeps resume_to=blocked', () => {
  const r = step(card('unresponsive', { resume_to: 'blocked', blocked_kind: 'permission' }), { type: 'answer' }, { ...OK, open_asks_remaining: 1 });
  assert.equal(r.card.resume_to, 'blocked');
  assert.equal(r.card.blocked_kind, 'permission');
  const cleared = step(card('orphaned', { resume_to: 'blocked', blocked_kind: 'permission' }), { type: 'answer' }, OK);
  assert.equal(cleared.card.resume_to, 'quiet');
  assert.equal(cleared.card.blocked_kind, null);
  assert.equal(step(card('suspended', { resume_to: 'quiet' }), { type: 'answer' }, OK).error.code, 'ILLEGAL_TRANSITION');
});

test('#27a/b: hand over → handing_over waits HANDOVER_WAIT_MS; target drives the follow-up', () => {
  const r = step(card('blocked', { blocked_kind: 'question' }), { type: 'hand_over', target: { kind: 'member', member_id: 'sam' } }, OK);
  assert.deepEqual(eff(r, 'runner_command'), { type: 'runner_command', cmd: 'handover_begin', fence: F, wait_ms: HANDOVER_WAIT_MS });
  assert.deepEqual(r.card.handover_target, { kind: 'member', member_id: 'sam' });
  const done = step(r.card, { type: 'handover_complete', fence: F }, OK);
  assert.equal(done.card.handover_provenance, 'checkpoint_complete');
  assert.deepEqual(eff(done, 'follow_up').event, { type: 'redispatch', target_member_id: 'sam' });
  const self = step({ ...r.card, handover_target: { kind: 'self' } }, { type: 'handover_timeout' }, OK);
  assert.equal(self.card.handover_provenance, 'checkpoint_incomplete');
  assert.deepEqual(eff(self, 'follow_up').event, { type: 'take_myself' });
  assert.equal(step(card('running'), { type: 'hand_over', target: { kind: 'x' } }, OK).error.code, 'VALIDATION');
  // Stop and failure still apply while handing over.
  assert.equal(step(r.card, { type: 'stop' }, OK).card.run_state, 'failed');
  assert.equal(step(r.card, { type: 'run_failed', fence: F, fail_kind: 'error' }, OK).card.run_state, 'failed');
});

test('#31: complete needs evidence; an agent cannot approve done', () => {
  assert.equal(step(card('running'), { type: 'complete', fence: F }, { ...OK, evidence_ok: false }).error.code, 'EVIDENCE_MISSING');
  assert.equal(step(card('blocked', { blocked_kind: 'question' }), { type: 'complete', fence: F }, OK).error.code, 'ILLEGAL_TRANSITION');
  assert.equal(step(card('in_review'), { type: 'approve_done', by_run: 'r1' }, OK).error.code, 'FORBIDDEN');
});

test('#1: guards and idempotency', () => {
  assert.equal(step(card('todo'), { type: 'dispatch', request_id: 'x' }, { ...OK, has_repo: false }).error.code, 'NO_REPO');
  assert.equal(step(card('todo'), { type: 'dispatch', request_id: 'x' }, { ...OK, policy_ok: false }).error.code, 'POLICY_DENIED');
  assert.equal(step(card('todo'), { type: 'dispatch' }, OK).error.code, 'VALIDATION');
  const dup = step(card('queued'), { type: 'dispatch', request_id: 'x' }, { ...OK, duplicate_request: true });
  assert.equal(dup.ok, true);
  assert.deepEqual(dup.effects, [{ type: 'return_existing' }]);
  assert.equal(step(card('todo'), { type: 'dispatch', request_id: 'x' }, { ...OK, needs_confirm: true }).effects[0].needs_confirm, true);
});

test('unknown states/events and illegal edges are rejected, never thrown', () => {
  assert.equal(step(card('nope'), { type: 'hb' }, OK).error.code, 'VALIDATION');
  assert.equal(step(card('running'), { type: 'nope' }, OK).error.code, 'VALIDATION');
  assert.equal(step(card('done'), { type: 'dispatch', request_id: 'x' }, OK).error.code, 'ILLEGAL_TRANSITION');
  assert.equal(step(card('todo'), { type: 'hb', fence: F }, OK).error.code, 'ILLEGAL_TRANSITION');
});

test('columns derive from run state (§4)', () => {
  assert.equal(columnOf('todo'), 'todo');
  assert.equal(columnOf('queued'), 'todo');
  for (const s of ['claimed', 'running', 'quiet', 'blocked', 'parked', 'suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over', 'failed', 'handed_over']) assert.equal(columnOf(s), 'in_progress', s);
  assert.equal(columnOf('in_review'), 'in_review');
  assert.equal(columnOf('done'), 'done');
});

test('DB mapping: todo ⇄ NULL, handover_target JSON', () => {
  assert.equal(toDb(card('todo')).run_state, null);
  assert.equal(fromDb({ run_state: null }).run_state, 'todo');
  const row = toDb(card('handing_over', { handover_target: { kind: 'queue' } }));
  assert.equal(row.handover_target, '{"kind":"queue"}');
  assert.equal(row.column_name, 'in_progress');
  assert.deepEqual(fromDb(row).handover_target, { kind: 'queue' });
});
