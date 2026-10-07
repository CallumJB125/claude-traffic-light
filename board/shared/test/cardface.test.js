import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFace, sponsorLine, alertsFor, agentName, PILLS } from '../cardface.js';
import { STATES } from '../states.js';

const MIN = 60_000;
const callum = { member_id: 'm-c', name: 'Callum' };
const james = { member_id: 'm-j', name: 'James' };
const liveOk = { hb_age_ms: 3000, child_alive: true, activity_age_ms: 20_000, tool_in_flight: null, wake_age_ms: null, post_wake_activity: false };
const view = (run_state, over = {}) => ({
  id: 'c1', key: 'BDL-142', title: 't', run_state, repo: { short_name: 'bondly' },
  run: { id: 'r1', backend: 'claude_cli', owner: callum, dispatched_by: callum, device_name: 'MacBook' },
  live: liveOk, state_age_ms: 12 * MIN, ...over,
});

test('every state has a pill', () => {
  for (const s of STATES) assert.ok(PILLS[s], s);
});

test('design §4.2 examples', () => {
  assert.equal(cardFace(view('blocked', { blocked_kind: 'permission', ask: { summary: 'npm run migrate', count: 1 } })).text, 'Needs you · approval waiting · `npm run migrate`');
  assert.equal(cardFace(view('blocked', { blocked_kind: 'permission', ask: { count: 2 } })).text, 'Needs you · approval waiting · 2 req');
  assert.equal(cardFace(view('running')).text, "Running · Callum's Claude");
  assert.equal(cardFace(view('suspended', { resume_to: 'quiet' })).text, 'Stalled · laptop asleep 12m');
  assert.equal(cardFace(view('orphaned', { resume_to: 'quiet' })).text, 'Stalled · runner offline · last seen 3s ago');
  assert.equal(cardFace(view('handing_over', { state_age_ms: 40_000 })).text, 'Moving to another AI · waiting for checkpoint · 40s');
  assert.equal(cardFace(view('running', { live: { ...liveOk, tool_in_flight: { name: 'Edit', summary: 'apps/x/submit.ts', age_ms: 1000 } } })).reason, "Callum's Claude · editing submit.ts");
  assert.equal(cardFace(view('running', { live: { ...liveOk, tool_in_flight: { name: 'Bash', summary: 'npm test', age_ms: 2 * MIN } } })).reason, "Callum's Claude · `npm test` 2m");
  assert.equal(cardFace(view('quiet', { live: { ...liveOk, activity_age_ms: 20 * MIN, tool_in_flight: { name: 'Bash', summary: 'npm test', age_ms: 14 * MIN } } })).reason, '`npm test` 14m, no output');
  assert.equal(cardFace(view('quiet', { live: { ...liveOk, activity_age_ms: 8 * MIN } })).reason, 'no activity 8m');
  assert.equal(cardFace(view('failed', { fail_kind: 'limit', limit_resets_in_ms: 42 * MIN })).text, "Plan limit reached · usage limit on Callum's account · resets in 42m");
  assert.equal(cardFace(view('failed', { fail_kind: 'budget', budget: { spent_usd: 5.01, cap_usd: 5 } })).reason, 'budget $5 reached');
  assert.equal(cardFace(view('failed', { fail_kind: 'stopped', stopped_by_name: 'Callum' })).reason, 'stopped by Callum');
  assert.equal(cardFace(view('failed', { fail_kind: 'released', fail_reason: 'needs product decision' })).reason, 'released by Claude: needs product decision');
  assert.equal(cardFace(view('failed', { fail_kind: 'error' })).reason, 'CLI exited');
  assert.equal(cardFace(view('in_review', { pr: { number: 1042 }, evidence: { tests: 'pass', verification: 'hub_verified' } })).reason, 'PR #1042 · tests ✓ · hub-verified');
  assert.equal(cardFace(view('in_review', { evidence: { tests: 'none' } })).reason, 'no tests · self-reported');
  assert.equal(cardFace(view('done', { pr: { merged_age_ms: 3 * 60 * MIN, merged_by: 'James' } })).reason, 'merged 3h ago by James');
  assert.equal(cardFace(view('handed_over', { handover_target_name: 'Sam', handover: { version: 8 } })).reason, 'to Sam · handover v8');
  assert.equal(cardFace(view('reconnecting')).reason, "board restarted · waiting for Callum's runner");
  assert.equal(cardFace(view('parked')).reason, 'waiting for your answer · no agent running');
  assert.equal(cardFace(view('claimed', { state_age_ms: 20_000 })).text, "Starting · Callum's Claude · preparing worktree");
});

test('queued reasons: self, teammate awaiting confirm, no runner online', () => {
  assert.equal(cardFace(view('queued', { run: null, live: null, target: { ...callum, is_viewer: true } })).reason, 'for your Claude');
  assert.equal(cardFace(view('queued', { run: null, live: null, target: { ...james, awaiting_confirm: true } })).reason, "for James's Claude · awaiting James");
  assert.equal(cardFace(view('queued', { run: null, live: null, target: callum, queue: { runner_online: false, offline_age_ms: 12 * MIN } })).reason, 'no runner online for bondly · 12m');
});

test('P1: green only when the predicate holds, including after client-side ageing', () => {
  const f = cardFace(view('running'));
  assert.equal(f.tone, 'green');
  assert.equal(f.green, true);
  const aged = cardFace(view('running'), { elapsed_ms: 60_000 });
  assert.equal(aged.green, false, 'hb is now 63 s old');
  assert.equal(aged.label, 'Stalled');
  assert.notEqual(aged.tone, 'green');
  const stale = cardFace(view('running', { live: { ...liveOk, activity_age_ms: 7 * MIN } }));
  assert.equal(stale.label, 'Stalled');
  assert.equal(stale.stalled.reason, 'no_activity');
  const dead = cardFace(view('running', { live: { ...liveOk, child_alive: false } }));
  assert.equal(dead.green, false);
  for (const s of STATES.filter((x) => x !== 'running')) assert.notEqual(cardFace(view(s, { resume_to: 'quiet', blocked_kind: 'question', fail_kind: 'error' })).tone, 'green', s);
});

test('exit (c): woken card stays grey until fresh activity', () => {
  const woke = cardFace(view('quiet', { live: { ...liveOk, wake_age_ms: 5000, activity_age_ms: 9 * 60 * MIN } }));
  assert.notEqual(woke.tone, 'green');
  const suspended = cardFace(view('suspended', { resume_to: 'blocked', blocked_kind: 'permission' }));
  assert.equal(suspended.reason, 'laptop asleep 12m · approval still waiting');
  assert.notEqual(suspended.tone, 'green');
});

test('connection lost dims every live chip to unknown', () => {
  for (const s of ['running', 'quiet', 'blocked', 'suspended', 'orphaned']) {
    const f = cardFace(view(s, { resume_to: 'quiet', blocked_kind: 'question' }), { connection_lost: true });
    assert.equal(f.tone, 'unknown', s);
    assert.equal(f.green, false);
  }
  assert.equal(cardFace(view('done'), { connection_lost: true }).tone, 'done');
});

test('primary actions per §4.2', () => {
  const a = (s, over) => cardFace(view(s, over)).actions;
  assert.deepEqual(a('queued'), ['cancel']);
  assert.deepEqual(a('running'), ['watch', 'stop', 'switch_ai']);
  assert.deepEqual(a('blocked', { blocked_kind: 'permission' }), ['allow', 'deny', 'switch_ai']);
  assert.deepEqual(a('blocked', { blocked_kind: 'permission', viewer_can_approve: false }), []);
  assert.deepEqual(a('blocked', { blocked_kind: 'decision' }), ['answer', 'switch_ai']);
  assert.deepEqual(a('blocked', { blocked_kind: 'plan' }), ['approve_plan', 'switch_ai']);
  assert.deepEqual(a('blocked', { blocked_kind: 'loop' }), ['continue', 'stop', 'switch_ai']);
  assert.deepEqual(a('orphaned', { resume_to: 'quiet' }), ['resume', 'handover_ai', 'stop', 'take_over']);
  assert.deepEqual(a('suspended', { resume_to: 'quiet' }), ['resume', 'handover_ai', 'stop', 'take_over_confirm']);
  assert.deepEqual(a('handed_over'), ['take_over_with_claude', 'take_over_myself']);
  assert.deepEqual(a('failed', { fail_kind: 'limit' }), ['continue_with_another_ai', 'take_over', 'retry']);
  assert.deepEqual(a('failed', { fail_kind: 'network' }), ['retry', 'take_over']);
  assert.deepEqual(a('in_review'), ['open_pr', 'request_changes']);
  assert.deepEqual(a('todo', { run: null, live: null }), ['give_to_claude']);
  assert.deepEqual(a('handing_over'), []);
});

test('sponsor: whose machine + whose account, never the auth type', () => {
  assert.equal(sponsorLine(view('running')), "Runs on Callum's MacBook · Callum's claude account");
  assert.equal(sponsorLine({ target: { ...callum, is_viewer: true } }), 'on your account');
  assert.equal(sponsorLine({ target: { ...james, device_name: 'MBP' } }), "Runs on James's MBP · James's claude account · uses James's account — James must confirm");
  assert.equal(sponsorLine({}), null);
  const f = cardFace(view('running', { run: { ...view('running').run, backend: 'codex_cli' } }));
  assert.equal(f.runner_line, 'codex · Callum');
  assert.equal(agentName(view('running', { run: { backend: 'codex_cli', owner: callum } })), "Callum's Codex");
  assert.doesNotMatch(JSON.stringify(cardFace(view('running'))), /subscription|api key/i);
});

test('overlap chip, activity line, budget bar', () => {
  const f = cardFace(view('running', { overlaps: [{ other_key: 'BDL-139', paths: ['src/api/deals.ts'] }], budget: { spent_usd: 1.2, cap_usd: 5 } }));
  assert.equal(f.overlap_chip, '⚠ overlaps BDL-139 · deals.ts');
  assert.equal(f.activity_line, "Callum's Claude · 20s ago");
  assert.deepEqual(f.budget, { text: '$1.20 / $5', ratio: 0.24 });
});

test('alerts strip: per viewer, N-rules for orphans, newest first, max 5 + more', () => {
  const cards = [
    view('blocked', { id: 'b', key: 'BDL-142', blocked_kind: 'permission', ask: { count: 2 }, state_age_ms: 1000, approvers: ['m-c'] }),
    view('running', { id: 'o', key: 'BDL-142', state_age_ms: 5000, overlaps: [{ other_key: 'BDL-139', other_owner: "James's Claude", paths: ['src/api/deals.ts'], age_ms: 2000 }] }),
    view('orphaned', { id: 'x', key: 'BDL-137', resume_to: 'quiet', state_age_ms: 11 * MIN }),
    view('orphaned', { id: 'y', key: 'BDL-136', resume_to: 'quiet', state_age_ms: 9 * MIN }),
    view('failed', { id: 'f', key: 'BDL-140', fail_kind: 'limit', state_age_ms: 3000 }),
  ];
  const { items, more } = alertsFor('m-c', cards);
  assert.deepEqual(items.map((i) => i.text), [
    '✋ BDL-142 needs you · approval waiting (2 req)',
    '⚠ BDL-142 overlaps BDL-139 (James\'s Claude) · deals.ts',
    '✖ BDL-140 stopped · usage limit on your account',
    '✖ BDL-137 orphaned · take over',
  ]);
  assert.equal(more, 0);
  assert.equal(alertsFor('m-j', cards).items.length, 1, 'James sees only the orphan');
  const lots = Array.from({ length: 8 }, (_, i) => view('orphaned', { id: `o${i}`, key: `K-${i}`, resume_to: 'quiet', state_age_ms: 20 * MIN + i }));
  const capped = alertsFor('m-c', lots);
  assert.equal(capped.items.length, 5);
  assert.equal(capped.more, 3);
});

test('stalled: derived from the aged view, with a reason, Resume / Hand over / Stop, never green', () => {
  const dead = cardFace(view('running', { live: { ...liveOk, hb_age_ms: 90_000 } }));
  assert.equal(dead.label, 'Stalled');
  assert.equal(dead.stalled.reason, 'runner_offline');
  assert.equal(dead.reason, 'runner offline · last seen 1m ago');
  assert.equal(dead.tone, 'red');
  assert.equal(dead.green, false);
  assert.deepEqual(dead.actions, ['resume', 'handover_ai', 'stop']);
  const silent = cardFace(view('quiet', { live: { ...liveOk, activity_age_ms: 8 * MIN } }));
  assert.equal(silent.stalled.reason, 'no_activity');
  assert.deepEqual(silent.actions, ['resume', 'switch_ai', 'stop'], 'a reachable runner can take the strict handover');
  const gone = cardFace(view('running', { live: { ...liveOk, child_alive: false, activity_age_ms: 2 * MIN } }));
  assert.equal(gone.reason, 'AI process exited · no activity 2m');
  const unstarted = cardFace(view('claimed', { state_age_ms: 3 * MIN }));
  assert.equal(unstarted.stalled.reason, 'claim_not_started');
  assert.equal(cardFace(view('claimed', { state_age_ms: 20_000 })).stalled, null);
  const unconfirmed = cardFace(view('failed', { fail_kind: 'stopped', live: null, state_age_ms: MIN, run: { ...view('failed').run, child_alive: true } }));
  assert.equal(unconfirmed.stalled.reason, 'stop_unconfirmed');
  assert.deepEqual(unconfirmed.actions, ['view_handover']);
  assert.equal(cardFace(view('blocked', { blocked_kind: 'question', live: { ...liveOk, activity_age_ms: 30 * MIN } })).stalled, null, 'waiting for a person is not stalled');
  assert.equal(cardFace(dead.stalled ? view('running', { live: { ...liveOk, hb_age_ms: 90_000 } }) : null, { connection_lost: true }).stalled, null, 'a lost board connection says nothing about the run');
});

test('plan limit reads "Plan limit reached" with continue_with_another_ai; no new state', () => {
  const f = cardFace(view('failed', { fail_kind: 'limit', limit_resets_in_ms: 5 * MIN }));
  assert.equal(f.label, 'Plan limit reached');
  assert.equal(f.state, 'failed');
  assert.equal(f.actions[0], 'continue_with_another_ai');
  assert.ok(!STATES.includes('paused'));
  assert.equal(cardFace(view('failed', { fail_kind: 'network' })).label, 'Waiting for network');
});

test('a run served by Burst\'s secondary keeps running and carries a "via secondary" badge', () => {
  const f = cardFace(view('running', { live: { ...liveOk, via_secondary: true } }));
  assert.equal(f.state, 'running');
  assert.equal(f.badge, 'via secondary');
  assert.equal(cardFace(view('running')).badge, null);
  assert.equal(cardFace(view('failed', { fail_kind: 'limit', live: { ...liveOk, via_secondary: true } })).badge, null);
});
