// Mock journal (CONTRACT §15) for the fixture board: rows the real hub would
// have written for each fixture card's history, plus (with `history`) a month
// of finished cards so the Dashboard has something to chart. Transitions go
// through the real shared step(), so every row is one the hub could write.
import { step, EVENTS, columnOf } from '../../shared/states.js';
import { CARD_STATE } from '../../shared/journal.js';

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

// Every guard passes: these histories already happened.
const CTX = {
  has_repo: true, can_write: true, policy_ok: true, can_cancel: true, is_target_member: true, repo_advertised: true, runner_accepts: true,
  no_active_run: true, can_answer: true, open_asks_remaining: 0, require_plan_approval: true, can_stop: true, policy_allows_requeue: true,
  can_hand_over: true, confirmed: true, evidence_ok: true, hub_uptime_ms: 10 * D, tunnel_ok: true,
};

const device = (memberId) => (memberId ? `dev-${memberId.slice(2)}` : null);

/** An append-only journal with the hub's row shape and paging. */
export function createJournal({ boardId, epoch }) {
  let rows = [];
  let seq = 0;
  const machines = new Map();

  function append({ card_id = null, run_id = null, at, actor_kind = 'system', actor_id = null, kind, payload = {} }) {
    const row = { seq: ++seq, board_id: boardId, card_id, run_id, at_hub: new Date(at).toISOString(), hub_epoch: epoch, actor_kind, actor_id, kind, payload };
    rows.push(row);
    return row;
  }

  /** The card.transition row for an applied step() result. */
  function transition(cardId, r, event, at, { by = null, runOwner = null, runId = null } = {}) {
    const src = EVENTS[event.type];
    const state = {};
    for (const f of CARD_STATE) state[f] = f === 'column_name' ? columnOf(r.to) : f === 'run_state' ? (r.to === 'todo' ? null : r.to) : r.card[f] ?? null;
    return append({
      card_id: cardId, run_id: runId, at,
      actor_kind: src === 'human' ? 'member' : src === 'runner' ? 'runner' : 'system',
      actor_id: src === 'human' ? by : src === 'runner' ? device(runOwner) : null,
      kind: 'card.transition',
      payload: { rule: r.rule, event: event.type, from: r.from, to: r.to, state, effects: r.effects.map((e) => e.type) },
    });
  }

  /**
   * Replay one card's story through step(): steps are [at, event, extra] with
   * event a states.js event type, or 'column' for a human column move.
   */
  function story(card, steps) {
    let m = { run_state: 'todo', blocked_kind: null, fail_kind: null, resume_to: null, pre_reconnect_state: null, fence: 0, handover_target: null, handover_provenance: null };
    let column = 'todo';
    let runId = null;
    const owner = card.run?.owner_id ?? card.assignee_ids?.[0] ?? null;
    const by = card.run?.dispatched_by_id ?? card.dispatched_by_id ?? owner;
    for (const [at, type, extra = {}] of steps) {
      if (type === 'create') {
        append({ card_id: card.id, at, actor_kind: 'member', actor_id: by, kind: 'card.create', payload: {
          key: card.key, title: card.title, body: card.body ?? '', acceptance: card.acceptance ?? '', repo_id: card.repo_id ?? null, base_ref: card.base_ref ?? null,
          labels: card.labels ?? [], budget_cents: card.budget?.cap_usd ? Math.round(card.budget.cap_usd * 100) : null, column_name: 'todo', assignees: card.assignee_ids ?? [], request_id: null,
        } });
        continue;
      }
      if (type === 'column') {
        append({ card_id: card.id, at, actor_kind: 'member', actor_id: extra.by ?? owner, kind: 'card.update', payload: { fields: { column_name: [column, extra.to] }, request_id: null } });
        column = extra.to;
        continue;
      }
      const ev = { type, fence: m.fence, expected_fence: m.fence, request_id: `req-${card.id}-${at}`, by: extra.by ?? by, ...extra };
      const r = step(m, ev, { ...CTX, ...(extra.ctx ?? {}) });
      if (!r.ok) throw new Error(`mock journal: ${card.key} ${type} from ${m.run_state}: ${r.error.message}`);
      if (type === 'block') {
        const perm = extra.kind === 'permission';
        append({ card_id: card.id, run_id: runId, at, actor_kind: 'runner', actor_id: device(owner), kind: perm ? 'permission.create' : 'ask.create',
          payload: perm ? { permission_request_id: `pr-${card.id}-${at}`, tool: 'Bash' } : { ask_id: `ask-${card.id}-${at}`, kind: extra.kind } });
      }
      if (type === 'answer') {
        const perm = m.blocked_kind === 'permission';
        append({ card_id: card.id, run_id: runId, at, actor_kind: 'member', actor_id: ev.by, kind: perm ? 'permission.answer' : 'ask.answer',
          payload: perm ? { permission_request_id: `pr-${card.id}`, decision: 'allow', scope: 'once' } : { ask_id: `ask-${card.id}`, by: ev.by } });
      }
      if (r.effects.some((e) => e.type === 'run_create')) {
        runId = `run-${card.id}-${r.card.fence}`;
        append({ card_id: card.id, run_id: runId, at, actor_kind: 'runner', actor_id: device(owner), kind: 'run.create', payload: { fence: r.card.fence, device_id: device(owner), branch: `board/${card.key}-r${r.card.fence}`, snapshot_ref: `refs/board/${card.key}/r${r.card.fence}`, dispatch_request_id: null } });
      }
      transition(card.id, r, ev, at, { by: ev.by, runOwner: owner, runId });
      if (r.to === 'todo') runId = null;
      m = r.card;
    }
    machines.set(card.id, m);
  }

  return {
    append, transition, story,
    /** Stories may be written out of time order; the hub commits in time order. */
    settle() {
      rows.sort((a, b) => Date.parse(a.at_hub) - Date.parse(b.at_hub) || a.seq - b.seq);
      rows.forEach((r, i) => { r.seq = i + 1; });
      seq = rows.length;
    },
    page(afterSeq, limit) {
      const after = Number.isSafeInteger(Number(afterSeq)) ? Number(afterSeq) : 0;
      const n = Math.min(Math.max(Number.isSafeInteger(Number(limit)) ? Number(limit) : 200, 1), 1000);
      const out = rows.filter((r) => r.seq > after).slice(0, n);
      return { rows: out, next_after_seq: out.length ? out.at(-1).seq : after };
    },
    rows: () => rows,
  };
}

// ── fixture histories ────────────────────────────────────────────────────────

// The events that lead to each state, in order, and the time before each one.
const RUN = [['dispatch', 0], ['claim', 3 * M], ['activity', M]];
const PATH = {
  queued: [['dispatch', 0]],
  claimed: [['dispatch', 0], ['claim', 3 * M]],
  running: RUN,
  quiet: [...RUN, ['quiet_timeout', 25 * M]],
  blocked: [...RUN, ['block', 30 * M]],
  suspended: [...RUN, ['block', 30 * M], ['host_suspending', 2 * M]],
  orphaned: [...RUN, ['quiet_timeout', 25 * M], ['hb_timeout', 6 * M], ['orphan_timeout', 5 * M]],
  failed: [...RUN, ['run_failed', 40 * M]],
  handing_over: [...RUN, ['hand_over', 35 * M]],
  handed_over: [...RUN, ['hand_over', 35 * M], ['handover_complete', 2 * M]],
  in_review: [...RUN, ['complete', 50 * M]],
  done: [...RUN, ['complete', 50 * M], ['pr_merged', 20 * H]],
};

function fixtureSteps(c, i, now) {
  const since = c.state_since ?? now - (6 + i) * H;
  const created = since - (1 + (i % 4)) * D - (i % 3) * 5 * H;
  if (!c.run_state || c.run_state === 'todo') {
    const steps = [[created, 'create']];
    if (c.column && c.column !== 'todo') steps.push([Math.min(now - H, created + 3 * H), 'column', { to: c.column }]);
    return steps;
  }
  const path = PATH[c.run_state] ?? [];
  // Walk back from state_since: the last event lands exactly when the snapshot says the state began.
  const times = [];
  let t = c.state_since;
  for (let k = path.length - 1; k >= 0; k--) { times[k] = t; t -= path[k][1] || 10 * M; }
  const extra = (type) => {
    if (type === 'block') return { kind: c.blocked_kind ?? 'question' };
    if (type === 'run_failed') return { fail_kind: c.fail_kind ?? 'error' };
    if (type === 'hand_over') return { target: { kind: 'self' } };
    if (type === 'pr_merged') return { pr: c.pr?.number ?? 1 };
    return {};
  };
  return [[Math.min(created, times[0] - H), 'create'], ...path.map(([type], k) => [times[k], type, extra(type)])];
}

// ── a month of finished cards (history: true) ───────────────────────────────

const HISTORY_TITLES = [
  'Bond Desk: CSV export of the deal queue', 'Normalise bank names in the offers table', 'Fix double-submit on the income step',
  'Add a retry to the statement upload', 'Show the rate-lock expiry on the offer card', 'Move affordability thresholds to config',
  'Magic-link emails land in spam for Outlook', 'Drop the unused /v1/quotes route', 'Paginate the admin members list',
  'Consumer app: skeletons while offers load', 'Log bank webhook failures with the payload hash', 'Rename “switch” to “move” in the UI copy',
  'Cache bank logos behind the CDN', 'Validate SA ID numbers on the client', 'Bond Desk: keyboard shortcuts for approve / decline',
  'Seed script for the demo board', 'Fix timezone drift in the daily digest', 'Add Playwright smoke test for sign-up',
  'Tighten CSP on the consumer app', 'Remove the legacy PDF renderer', 'Show bond balance history as a chart',
  'Split finance.js into modules', 'Handle a declined offer in the switch tracker', 'Rate-limit the quote endpoint',
  'Audit log for bank user actions', 'Dark mode for Bond Desk',
];
const LABELS = [['bug'], ['bond-desk'], ['api'], ['perf'], ['copy'], [], ['security'], ['kyc']];
const MEMBER_IDS = ['m-alice', 'm-bob', 'm-james', 'm-sam'];

// Deterministic: the same board every run, so screenshots compare.
function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** Finished cards over the last four weeks: [{card, steps}] (steps in relative time). */
export function historyCards(now) {
  const rand = rng(20260930);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const between = (a, b) => a + rand() * (b - a);
  const out = [];
  HISTORY_TITLES.forEach((title, i) => {
    const n = 100 + i;
    const owner = pick(MEMBER_IDS);
    const human = rand() < 0.28;
    // Spread finishes over the last 4 weeks.
    const doneAt = now - Math.floor(rand() * 27 * D + 2 * H);
    const steps = [];
    let t = 0;
    const at = (gap) => { t += Math.round(gap); return t; };
    steps.push([at(0), 'create']);
    if (human) {
      steps.push([at(between(2 * H, 3 * D)), 'column', { to: 'in_progress', by: owner }]);
      steps.push([at(between(3 * H, 4 * D)), 'column', { to: 'done', by: owner }]);
    } else {
      steps.push([at(between(20 * M, 2 * D)), 'dispatch']);
      const runOnce = () => {
        steps.push([at(rand() < 0.2 ? between(1 * H, 9 * H) : between(1 * M, 25 * M)), 'claim']);
        steps.push([at(between(20 * S, 2 * M)), 'activity']);
        if (rand() < 0.45) {
          const kind = pick(['permission', 'permission', 'question', 'decision', 'plan', 'clarify']);
          steps.push([at(between(10 * M, 90 * M)), 'block', { kind }]);
          steps.push([at(kind === 'permission' ? between(2 * M, 3 * H) : between(20 * M, 20 * H)), 'answer', { by: pick(MEMBER_IDS) }]);
        }
        steps.push([at(between(25 * M, 5 * H)), 'complete']);
      };
      runOnce();
      if (rand() < 0.2) {
        steps.push([at(between(1 * H, 20 * H)), 'request_changes', { by: pick(MEMBER_IDS) }]);
        runOnce();
      }
      steps.push([at(between(40 * M, 2.5 * D)), rand() < 0.7 ? 'pr_merged' : 'approve_done', { pr: 900 + i, by: pick(MEMBER_IDS) }]);
    }
    const shift = doneAt - t;
    const card = {
      id: `c-${n}`, key: `BDL-${n}`, title, labels: pick(LABELS), assignee_ids: [owner], overlaps: [], version: 4, fence: human ? 0 : 1,
      base_ref: 'dev', repo_id: 'repo-bondly', body: '', acceptance: '', live: null, state_since: doneAt, detail: { feed: [] },
      ...(human
        ? { run_state: 'todo', column: 'done', run: null, budget: null }
        : {
          run_state: 'done', column: null, branch: `board/BDL-${n}-r1`,
          run: { id: `run-${n}`, backend: 'claude_cli', owner_id: owner, dispatched_by_id: owner },
          budget: { spent_usd: Math.round(between(0.3, rand() < 0.15 ? 7.5 : 3.2) * 100) / 100, cap_usd: 8 },
          pr: { number: 900 + i, url: `https://github.com/pistorventures/bondly/pull/${900 + i}`, state: 'merged', merged_by: 'Alice', merged_at: doneAt },
        }),
    };
    out.push({ card, steps: steps.map(([rel, type, extra]) => [rel + shift, type, extra]) });
  });
  return out;
}

/** The journal for a set of fixture card records (+ history stories). */
export function buildJournal({ boardId, epoch, cards, history = [], now }) {
  const j = createJournal({ boardId, epoch });
  cards.forEach((c, i) => j.story(c, fixtureSteps(c, i, now)));
  for (const { card, steps } of history) j.story(card, steps);
  j.settle();
  return j;
}
