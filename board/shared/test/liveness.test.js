import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../liveness.js';

const { isGreen, toolBound, timerEvent, gate, sleptEstimate, ackAge, advanceView, reconnectDelay, formatAge } = L;
const MIN = 60_000;

const green = (over = {}) => ({
  run_state: 'running', hb_age_ms: 5000, child_alive: true, activity_age_ms: 10_000,
  tool_in_flight: null, wake_age_ms: null, post_wake_activity: false, ...over,
});

test('timer constants match design §4.1/§5.2', () => {
  assert.equal(L.HB_MS, 15_000);
  assert.equal(L.TTL_MS, 45_000);
  assert.equal(L.T_QUIET_MS, 6 * MIN);
  assert.equal(L.T_ORPHAN_MS, 5 * MIN);
  assert.equal(L.GATE_G_MS, 4 * MIN);
  assert.equal(L.T_PARK_MS, 30 * MIN);
  assert.equal(L.T_SUSPEND_MS, 8 * 60 * MIN);
  assert.equal(L.T_CLAIM_MS, 120_000);
  assert.equal(L.RECONNECT_CAP_MS, 30_000);
  assert.equal(L.T_HANDOVER_MS, 3 * MIN);
  assert.equal(L.HANDOVER_WAIT_MS, 90_000);
  assert.equal(L.ORPHAN_NOTIFY_MS, 10 * MIN);
  assert.ok(L.GATE_G_MS < L.T_ORPHAN_MS, 'the runner stops before the hub can declare it orphaned');
});

test('green predicate: every conjunct matters', () => {
  assert.equal(isGreen(green()), true);
  assert.equal(isGreen(green({ run_state: 'quiet' })), false);
  assert.equal(isGreen(green({ hb_age_ms: 45_001 })), false);
  assert.equal(isGreen(green({ hb_age_ms: 45_000 })), true);
  assert.equal(isGreen(green({ hb_age_ms: null })), false);
  assert.equal(isGreen(green({ child_alive: false })), false);
  assert.equal(isGreen(green({ child_alive: undefined })), false);
  assert.equal(isGreen(green({ activity_age_ms: 6 * MIN + 1 })), false);
  assert.equal(isGreen(green({ activity_age_ms: 6 * MIN })), true);
});

test('bounded tool_in_flight: Bash timeout + 30 s (default 2 min, max 10 min), others 10 min', () => {
  assert.equal(toolBound({ name: 'Bash' }), 150_000);
  assert.equal(toolBound({ name: 'Bash', bash_timeout_ms: 300_000 }), 330_000);
  assert.equal(toolBound({ name: 'Bash', bash_timeout_ms: 3_600_000 }), 630_000);
  assert.equal(toolBound({ name: 'Read' }), 600_000);
  const stale = { activity_age_ms: 20 * MIN };
  assert.equal(isGreen(green({ ...stale, tool_in_flight: { name: 'Bash', age_ms: 149_000 } })), true);
  assert.equal(isGreen(green({ ...stale, tool_in_flight: { name: 'Bash', age_ms: 151_000 } })), false, '`npm test` 14 min, no output is never green');
  assert.equal(isGreen(green({ ...stale, tool_in_flight: { name: 'Task', age_ms: 9 * MIN } })), true);
});

test('fresh activity after wake (Power Nap guard)', () => {
  assert.equal(isGreen(green({ wake_age_ms: 30_000, activity_age_ms: 60_000 })), false, 'last activity was before the wake');
  assert.equal(isGreen(green({ wake_age_ms: 30_000, activity_age_ms: 10_000 })), true);
  assert.equal(isGreen(green({ wake_age_ms: 30_000, activity_age_ms: 60_000, post_wake_activity: true })), true);
});

test('advanceView ages every clock; green decays on the client without a push', () => {
  const v = green({ activity_age_ms: 5 * MIN, tool_in_flight: null });
  assert.equal(isGreen(v), true);
  const later = advanceView(v, 70_000);
  assert.equal(later.hb_age_ms, 75_000);
  assert.equal(isGreen(later), false);
  assert.equal(advanceView({ ...v, tool_in_flight: { name: 'Bash', age_ms: 1 } }, 10).tool_in_flight.age_ms, 11);
});

const snap = (over = {}) => ({
  run_state: 'running', hb_age_ms: 1000, state_age_ms: 0, hub_uptime_ms: 3_600_000, tunnel_ok_ms: 3_600_000,
  child_alive: true, activity_age_ms: 1000, tool_in_flight: null, wake_age_ms: null, runner_online: true, ...over,
});

test('reaper: hb_timeout at TTL for live states (not during the first TTL of hub uptime)', () => {
  for (const s of ['claimed', 'running', 'quiet', 'blocked', 'handing_over']) {
    assert.deepEqual(timerEvent(snap({ run_state: s, hb_age_ms: 45_001 })), { type: 'hb_timeout' }, s);
    assert.equal(timerEvent(snap({ run_state: s, hb_age_ms: 44_000 }))?.type === 'hb_timeout', false);
  }
  assert.equal(timerEvent(snap({ hb_age_ms: 50_000, hub_uptime_ms: 30_000 })), null);
});

test('reaper: quiet, park, handover, claim, orphan, suspend, reconnect, nudge', () => {
  assert.deepEqual(timerEvent(snap({ activity_age_ms: 7 * MIN })), { type: 'quiet_timeout' });
  assert.equal(timerEvent(snap({ activity_age_ms: 7 * MIN, tool_in_flight: { name: 'Bash', age_ms: 60_000 } })), null);
  assert.deepEqual(timerEvent(snap({ run_state: 'blocked', ask_age_ms: 30 * MIN })), { type: 'park_timeout' });
  assert.equal(timerEvent(snap({ run_state: 'blocked', ask_age_ms: 29 * MIN })), null);
  assert.deepEqual(timerEvent(snap({ run_state: 'handing_over', state_age_ms: 3 * MIN })), { type: 'handover_timeout' });
  assert.deepEqual(timerEvent(snap({ run_state: 'unresponsive', resume_to: 'claimed', claim_age_ms: 120_000, hb_age_ms: 60_000 })), { type: 'claim_timeout' });
  assert.deepEqual(timerEvent(snap({ run_state: 'unresponsive', resume_to: 'quiet', hb_age_ms: 5 * MIN })), { type: 'orphan_timeout' });
  assert.equal(timerEvent(snap({ run_state: 'unresponsive', resume_to: 'quiet', hb_age_ms: 5 * MIN - 1 })), null);
  assert.deepEqual(timerEvent(snap({ run_state: 'suspended', state_age_ms: 8 * 60 * MIN })), { type: 'suspend_timeout' });
  assert.deepEqual(timerEvent(snap({ run_state: 'reconnecting', hb_age_ms: null, hub_uptime_ms: 45_000 })), { type: 'reconnect_timeout' });
  assert.equal(timerEvent(snap({ run_state: 'reconnecting', hb_age_ms: null, hub_uptime_ms: 44_000 })), null);
  assert.deepEqual(timerEvent(snap({ run_state: 'queued', runner_online: false, state_age_ms: 10 * MIN })), { type: 'queue_nudge' });
  assert.equal(timerEvent(snap({ run_state: 'queued', runner_online: false, state_age_ms: 10 * MIN, nudged: true })), null);
  assert.equal(timerEvent(snap({ run_state: 'queued', runner_online: true, state_age_ms: 60 * MIN })), null);
  for (const s of ['todo', 'parked', 'failed', 'in_review', 'done', 'handed_over', 'orphaned']) assert.equal(timerEvent(snap({ run_state: s, hb_age_ms: 99 * MIN })), null, s);
});

test('exit (g): a Pi reboot < 4 min orphans nothing (boot grace + tunnel probe)', () => {
  // Hub back after 3 min: silence counts only since boot / tunnel health.
  const s = snap({ run_state: 'unresponsive', resume_to: 'quiet', hb_age_ms: null, hub_uptime_ms: 4 * MIN, tunnel_ok_ms: 4 * MIN });
  assert.equal(timerEvent(s), null);
  // Tunnel was down 2 min ago: orphan clock restarts from tunnel recovery.
  assert.equal(timerEvent(snap({ run_state: 'unresponsive', resume_to: 'quiet', hb_age_ms: 20 * MIN, tunnel_ok_ms: 2 * MIN })), null);
});

test('tick-gap sleep detection (spike 8): larger of the two clock deltas', () => {
  assert.equal(sleptEstimate({ mono_delta_ms: 1000, wall_delta_ms: 1003 }), 0);
  assert.equal(sleptEstimate({ mono_delta_ms: 8995, wall_delta_ms: 8995 }), 7995, 'SIGSTOP 8 s → 7995');
  // Linux CLOCK_MONOTONIC excludes suspend; wall doesn't.
  assert.equal(sleptEstimate({ mono_delta_ms: 1000, wall_delta_ms: 601_000 }), 600_000);
  assert.equal(sleptEstimate({ mono_delta_ms: 6000, wall_delta_ms: 0 }), 0, 'gap of exactly the threshold is not sleep');
});

test('ackAge: larger clock wins; a backwards wall clock is ignored', () => {
  assert.equal(ackAge({ mono_since_ack_ms: 1000, wall_since_ack_ms: 5000 }), 5000);
  assert.equal(ackAge({ mono_since_ack_ms: 1000, wall_since_ack_ms: -90_000 }), 1000);
  assert.equal(ackAge({ mono_since_ack_ms: null, wall_since_ack_ms: 1 }), null);
});

test('offline gate G (§5.3 rules 1–5)', () => {
  assert.deepEqual(gate({ ack_age_ms: 1000 }), { open: true, reason: 'ok' });
  assert.equal(gate({ ack_age_ms: null }).reason, 'no_ack');
  assert.equal(gate({ ack_age_ms: 4 * MIN }).reason, 'ack_stale', 'rule 3: closes at G');
  assert.equal(gate({ ack_age_ms: 4 * MIN - 1 }).open, true);
  assert.equal(gate({ ack_age_ms: 1000, fenced: true }).reason, 'fenced');
  assert.equal(gate({ ack_age_ms: 1000, wake: { slept_ms: 4 * MIN, age_ms: 60_000 } }).reason, 'long_sleep');
  assert.deepEqual(gate({ ack_age_ms: 1000, wake: { slept_ms: 30_000, age_ms: 5000 } }), { open: false, reason: 'await_ack', wait_ms: 15_000 });
  assert.equal(gate({ ack_age_ms: 1000, wake: { slept_ms: 30_000, age_ms: 20_000 } }).open, true, 'rule 5: proceed after 20 s under rule 1');
});

test('exit (h): origin-down never reopens a stale gate', () => {
  // A runner that slept 30 min wakes during a Pi outage: 530 answers, but its last ack is 30 min old.
  assert.equal(gate({ ack_age_ms: 30 * MIN, origin_down: true }).open, false);
});

test('reconnect backoff: exponential, jittered, capped at 30 s', () => {
  assert.equal(reconnectDelay(0, 0), 250);
  assert.equal(reconnectDelay(0, 0.999), 499);
  for (let a = 0; a < 40; a++) for (const r of [0, 0.5, 0.9999]) assert.ok(reconnectDelay(a, r) <= L.RECONNECT_CAP_MS);
  assert.ok(reconnectDelay(20, 0) >= L.RECONNECT_CAP_MS / 2);
});

test('formatAge', () => {
  assert.equal(formatAge(50_000), '50s');
  assert.equal(formatAge(12 * MIN), '12m');
  assert.equal(formatAge(3 * 60 * MIN), '3h');
  assert.equal(formatAge(125 * MIN), '2h 5m');
  assert.equal(formatAge(27 * 60 * MIN), '1d 3h');
  assert.equal(formatAge(null), '?');
  assert.equal(formatAge(-5), '0s');
});
