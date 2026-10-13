// Liveness: the green predicate (design §5.1), every timer as a named
// constant (§4.1, §5.2), the hub reaper's timer → event mapping, and the
// runner-local offline gate G (§5.3 offline rules, amended by the Phase 0
// spikes: sleep is detected by tick gaps, not Δwall − Δmono).
//
// Every input is an AGE in ms measured on ONE clock (the hub's monotonic
// clock at receive time, or the runner's own clocks). Nothing here compares
// wall-clock instants taken on different machines.
//
// Browser-safe, dependency-free.

// Test-only time compression: BOARD_TEST_TIME_SCALE (0 < x ≤ 1, Node env only)
// multiplies every timer below, so their ratios (G < T_orphan, TTL = 3 × HB…)
// hold. Browsers never see it (no process.env): the web keeps real timers.
export const TIME_SCALE = (() => {
  const v = Number(globalThis.process?.env?.BOARD_TEST_TIME_SCALE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
})();

const S = 1000 * TIME_SCALE;
const MIN = 60 * S;
const H = 60 * MIN;

export const HB_MS = 15 * S;                 // supervisor heartbeat cadence
export const TTL_MS = 45 * S;                // lease TTL: unresponsive at TTL
export const T_QUIET_MS = 6 * MIN;           // running → quiet without activity
export const T_ORPHAN_MS = 5 * MIN;          // unresponsive → orphaned (silence)
export const GATE_G_MS = T_ORPHAN_MS - 60 * S; // runner offline gate: 4 min since last fence-confirming ack
export const T_PARK_MS = 30 * MIN;           // blocked → parked
export const T_SUSPEND_MS = 8 * H;           // suspended → orphaned
export const T_CLAIM_MS = 120 * S;           // claimed → running budget; unresponsive(claimed) → queued
export const RECONNECT_CAP_MS = 30 * S;      // runner reconnect backoff cap
export const RECONNECT_BASE_MS = S / 2;      // runner reconnect backoff base (500 ms)
export const T_HANDOVER_MS = 3 * MIN;        // handing_over → handed_over cap (#27b)
export const HANDOVER_WAIT_MS = 90 * S;      // runner waits this long for board_write_handover (#27a)
export const ORPHAN_NOTIFY_MS = 10 * MIN;    // N-rules: notify after ≥ 10 min orphaned
export const QUEUE_NUDGE_MS = 10 * MIN;      // #1a: nudge dispatcher when no runner online
export const SHORT_WAKE_WAIT_MS = 20 * S;    // offline rule 5: wait for a round-trip after a short wake
export const STOP_GRACE_MS = 10 * S;         // SIGINT → SIGKILL on gate close / fenced
export const INTERRUPT_WAIT_MS = 5 * S;      // stop recipe: interrupt → wait ≤ 5 s → end stdin → SIGTERM
export const BASH_DEFAULT_TIMEOUT_MS = 2 * MIN;
export const BASH_MAX_TIMEOUT_MS = 10 * MIN;
export const BASH_GRACE_MS = 30 * S;
export const OTHER_TOOL_BOUND_MS = 10 * MIN;
export const SLEEP_TICK_MS = 1 * S;          // runner tick-gap detector cadence
// A tick late by more than this = the host slept. Floored at 1 s under a test
// time scale: event-loop jitter must never look like a sleep.
export const SLEEP_GAP_THRESHOLD_MS = Math.max(5 * S, 1000);
export const TICK_MAX_RATE_MS = 1 * S;       // lease.tick to browsers: ≤ 1/s/card
export const REAPER_MS = 1 * S;              // hub reaper cadence
export const OVERLAP_DEBOUNCE_MS = 10 * S;
export const NARRATIVE_NUDGE_MS = 10 * MIN;  // handover narrative staleness nudge
export const NARRATIVE_NUDGE_CALLS = 25;
export const DEGRADED_NO_SESSIONSTART_MS = 30 * S;
export const PRESENCE_MIN_MS = 5 * S;        // D37b: runner sends a changed presence at most this often
export const PRESENCE_KEEPALIVE_MS = 60 * S; // D37b: runner re-sends an unchanged presence
export const PRESENCE_TTL_MS = 90 * S;       // D37b: hub forgets a device's presence this long after its last frame
export const T_STOP_CONFIRM_MS = 30 * S;     // a stopped run whose CLI is still reported alive this long: stop unconfirmed
export const PRESENCE_PUSH_MS = 1 * S;       // D37b: team.presence to a board's browsers at most this often (trailing edge)

// bound(Bash) = its timeout (default 2 min, max 10 min) + 30 s; bound(other) = 10 min.
export function toolBound(tool) {
  if (!tool) return 0;
  if (tool.name === 'Bash') {
    const t = Number.isFinite(tool.bash_timeout_ms) && tool.bash_timeout_ms > 0
      ? Math.min(tool.bash_timeout_ms, BASH_MAX_TIMEOUT_MS)
      : BASH_DEFAULT_TIMEOUT_MS;
    return t + BASH_GRACE_MS;
  }
  return OTHER_TOOL_BOUND_MS;
}

// Progress, independent of run_state: recent activity, or a tool still
// inside its bound.
export function hasProgress(v) {
  if (v.activity_age_ms != null && v.activity_age_ms <= T_QUIET_MS) return true;
  const t = v.tool_in_flight;
  return !!t && t.age_ms != null && t.age_ms <= toolBound(t);
}

// "No wake since last activity ∨ post_wake_activity". A wake is "since last
// activity" when it is younger than the last activity.
export function wakeSatisfied(v) {
  if (v.wake_age_ms == null) return true;
  if (v.post_wake_activity) return true;
  return v.activity_age_ms != null && v.activity_age_ms < v.wake_age_ms;
}

/**
 * The green predicate (§5.1). `v` is a lease view:
 * { run_state, hb_age_ms, child_alive, activity_age_ms,
 *   tool_in_flight: {name, age_ms, bash_timeout_ms?} | null,
 *   wake_age_ms: number | null, post_wake_activity: boolean }
 * All ages on one clock. A missing HB (hb_age_ms null) is never green.
 */
export function isGreen(v) {
  return v.run_state === 'running'
    && v.hb_age_ms != null && v.hb_age_ms <= TTL_MS
    && v.child_alive === true
    && hasProgress(v)
    && wakeSatisfied(v);
}

// Ages advance on the client between hub pushes: the hub sends age_ms at send
// time, the browser adds performance.now() elapsed since receipt (§5.1).
export function advanceView(v, elapsedMs) {
  const add = (a) => (a == null ? a : a + elapsedMs);
  return {
    ...v,
    hb_age_ms: add(v.hb_age_ms),
    activity_age_ms: add(v.activity_age_ms),
    wake_age_ms: add(v.wake_age_ms),
    tool_in_flight: v.tool_in_flight ? { ...v.tool_in_flight, age_ms: add(v.tool_in_flight.age_ms) } : null,
  };
}

/**
 * Hub reaper: which timer event (states.js event type) is due for a card,
 * or null. `s` fields (ages on the hub monotonic clock unless noted):
 *   run_state, resume_to, pre_reconnect_state
 *   hb_age_ms            since the last HB for this run (null: none this hub boot)
 *   state_age_ms         since entering run_state (persisted wall time on the hub; same machine)
 *   claim_age_ms         since the claim (for #5b)
 *   ask_age_ms           since the oldest still-open ask/permission request (for #10)
 *   hub_uptime_ms        since this hub process booted
 *   tunnel_ok_ms         how long the tunnel self-probe has been continuously healthy
 *   runner_online        some eligible runner is connected (for #1a)
 *   nudged               #1a nudge already sent for this queue entry
 *   + the lease view fields used by isGreen (for #6)
 */
export function timerEvent(s) {
  const silence = s.hb_age_ms == null ? s.hub_uptime_ms : s.hb_age_ms;
  switch (s.run_state) {
    case 'queued':
      if (!s.runner_online && !s.nudged && s.state_age_ms >= QUEUE_NUDGE_MS) return { type: 'queue_nudge' };
      return null;
    case 'claimed':
    case 'running':
    case 'quiet':
    case 'blocked':
    case 'handing_over':
      if (s.hub_uptime_ms >= TTL_MS && silence > TTL_MS) return { type: 'hb_timeout' };
      if (s.run_state === 'handing_over' && s.state_age_ms >= T_HANDOVER_MS) return { type: 'handover_timeout' };
      if (s.run_state === 'blocked' && s.ask_age_ms != null && s.ask_age_ms >= T_PARK_MS) return { type: 'park_timeout' };
      if (s.run_state === 'running' && !hasProgress(s)) return { type: 'quiet_timeout' };
      return null;
    case 'unresponsive':
      if (s.resume_to === 'claimed' && s.claim_age_ms != null && s.claim_age_ms >= T_CLAIM_MS) return { type: 'claim_timeout' };
      // "Silence ≥ T_orphan, hub uptime ≥ T_orphan and tunnel self-probe
      // healthy throughout": silence only counts while runners could reach us.
      if (Math.min(silence, s.hub_uptime_ms, s.tunnel_ok_ms ?? 0) >= T_ORPHAN_MS) return { type: 'orphan_timeout' };
      return null;
    case 'suspended':
      if (s.state_age_ms >= T_SUSPEND_MS) return { type: 'suspend_timeout' };
      return null;
    case 'reconnecting':
      if (s.hub_uptime_ms >= TTL_MS && s.hb_age_ms == null) return { type: 'reconnect_timeout' };
      return null;
    default:
      return null;
  }
}

// ── Stalled (derived, never stored) ────────────────────────────────────────

export const STALL_REASONS = Object.freeze(['runner_offline', 'process_gone', 'claim_not_started', 'no_activity', 'stop_unconfirmed']);

/**
 * A run the card still shows as in progress while nothing is working on it.
 * `v` is the CardView fields the hub and the web both hold: { run_state,
 * state_age_ms, fail_kind, live: LeaseView|null, run: {child_alive}|null }.
 * Pure over ages, so the web re-evaluates it on advanced ages every second.
 * Returns { reason, since_ms } or null. blocked (waiting for a person) and
 * handing_over (its own 3-minute timer) are never stalled by silence alone.
 */
export function deriveStalled(v) {
  const state = v.run_state;
  const live = v.live;
  const age = v.state_age_ms ?? 0;
  if (state === 'failed') {
    return v.fail_kind === 'stopped' && v.run?.child_alive === true && age >= T_STOP_CONFIRM_MS
      ? { reason: 'stop_unconfirmed', since_ms: age } : null;
  }
  if (!live) return null;
  const hb = live.hb_age_ms;
  switch (state) {
    case 'unresponsive':
    case 'orphaned':
      return { reason: 'runner_offline', since_ms: hb ?? age };
    case 'suspended':
    case 'reconnecting':
      return age >= TTL_MS ? { reason: 'runner_offline', since_ms: hb ?? age } : null;
    case 'claimed':
    case 'running':
    case 'quiet':
      if (hb == null || hb > TTL_MS) return { reason: 'runner_offline', since_ms: hb ?? age };
      if (state === 'claimed') return age >= T_CLAIM_MS ? { reason: 'claim_not_started', since_ms: age } : null;
      if (live.child_alive === false && (live.activity_age_ms == null || live.activity_age_ms > TTL_MS)) return { reason: 'process_gone', since_ms: live.activity_age_ms ?? age };
      if (!hasProgress(live)) return { reason: 'no_activity', since_ms: live.activity_age_ms ?? age };
      return null;
    default:
      return null;
  }
}

// ── Runner side ────────────────────────────────────────────────────────────

// Tick-gap sleep detector (spike 8: process.hrtime includes sleep on macOS,
// CLOCK_MONOTONIC excludes it on Linux, so take the larger of the two
// deltas). Returns the estimated sleep in ms, 0 when the tick was on time.
export function sleptEstimate({ mono_delta_ms, wall_delta_ms, interval_ms = SLEEP_TICK_MS }) {
  const gap = Math.max(mono_delta_ms ?? 0, wall_delta_ms ?? 0) - interval_ms;
  return gap > SLEEP_GAP_THRESHOLD_MS ? gap : 0;
}

// Age of the last fence-confirming hub ack. The larger of the two clocks: a
// wall-clock jump can only make the gate close early (the safe direction).
export function ackAge({ mono_since_ack_ms, wall_since_ack_ms }) {
  if (mono_since_ack_ms == null) return null;
  return Math.max(mono_since_ack_ms, wall_since_ack_ms ?? 0, 0);
}

/**
 * Offline gate G (§5.3 offline rules 1–5). Input:
 *   ack_age_ms   from ackAge(); null = no fence-confirming ack yet for this run
 *   fenced       the hub said FENCED
 *   wake         {slept_ms, age_ms} of the latest wake AFTER the last ack, or null
 *   origin_down  the edge answered 530/1033 or hub 5xx (informational: never reopens)
 * Returns {open, reason, wait_ms?}. PreToolUse denies unless open; for
 * reason 'await_ack' it may wait up to wait_ms for a round-trip first.
 */
export function gate({ ack_age_ms, fenced = false, wake = null }) {
  if (fenced) return { open: false, reason: 'fenced' };
  if (ack_age_ms == null) return { open: false, reason: 'no_ack' };
  if (ack_age_ms >= GATE_G_MS) return { open: false, reason: 'ack_stale' };
  if (wake && wake.slept_ms >= GATE_G_MS) return { open: false, reason: 'long_sleep' };
  if (wake && wake.age_ms < SHORT_WAKE_WAIT_MS) return { open: false, reason: 'await_ack', wait_ms: SHORT_WAKE_WAIT_MS - wake.age_ms };
  return { open: true, reason: 'ok' };
}

// Exponential backoff with full jitter, capped at RECONNECT_CAP_MS. `rand`
// in [0,1) is injected so tests are deterministic.
export function reconnectDelay(attempt, rand = Math.random()) {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(ceiling / 2 + rand * (ceiling / 2));
}

// "12m", "50s", "3h", "2h 5m", "1d 3h".
export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
