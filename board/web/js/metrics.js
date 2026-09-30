// Dashboard metrics: pure functions over the board journal (CONTRACT §15) and
// the snapshot's CardViews. No DOM and no clocks: `now` (wall ms, the same
// clock as the journal's at_hub) comes in from the caller.
import { STATES } from '../../shared/states.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
export const WINDOW_MS = 28 * DAY;
export const WEEKS = 8;

// Ordered buckets for the cycle-time distribution.
export const CYCLE_BUCKETS = [
  { id: 'lt1h', label: '< 1h', max: HOUR },
  { id: '1-4h', label: '1–4h', max: 4 * HOUR },
  { id: '4-24h', label: '4–24h', max: DAY },
  { id: '1-3d', label: '1–3d', max: 3 * DAY },
  { id: '3-7d', label: '3–7d', max: 7 * DAY },
  { id: 'gt7d', label: '7d+', max: Infinity },
];

// Where cards wait on someone else, in the order the panel lists them.
export const WAIT_STAGES = [
  { id: 'queued', label: 'Waiting for a runner', states: ['queued'] },
  { id: 'blocked', label: 'Waiting on an answer', states: ['blocked', 'parked'] },
  { id: 'in_review', label: 'Waiting for review', states: ['in_review'] },
];

const KNOWN = new Set(STATES);

/** Linear-interpolated percentile (p in 0..1) of numbers; null when empty. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (xs.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}

export const median = (values) => percentile(values, 0.5);

const timeOf = (row) => (typeof row.at_hub === 'number' ? row.at_hub : Date.parse(row.at_hub));

/**
 * Card rows in journal order: deduped by seq, sorted by seq (the hub's commit
 * order), falling back to time. Rows without a card or a readable time drop.
 */
export function normalizeJournal(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows ?? []) {
    if (!r || r.card_id == null) continue;
    const t = timeOf(r);
    if (!Number.isFinite(t)) continue;
    if (r.seq != null) {
      if (seen.has(r.seq)) continue;
      seen.add(r.seq);
    }
    out.push({ ...r, t });
  }
  return out.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || a.t - b.t);
}

const columnChange = (fields) => {
  const c = fields?.column_name ?? fields?.column;
  return Array.isArray(c) && c.length === 2 ? c : null;
};

/**
 * One card's history from its journal rows (already in order):
 * segments [{state, kind, from, to}] (the last open-ended: to = null),
 * created_at, first_start (first claimed/running), done_at + done_by
 * ('claude' | 'human') when the card's latest word is "done".
 */
export function cardHistory(rows) {
  const h = { card_id: rows[0]?.card_id ?? null, key: null, title: null, created_at: null, first_start: null, done_at: null, done_by: null, state: null, segments: [] };
  let open = null;
  const enter = (state, kind, t) => {
    if (open) open.to = Math.max(open.from, t);
    open = { state, kind: kind ?? null, from: t, to: null };
    h.segments.push(open);
    h.state = state;
  };
  for (const r of rows) {
    const p = r.payload ?? {};
    if (r.kind === 'card.create') {
      h.created_at = h.created_at == null ? r.t : Math.min(h.created_at, r.t);
      h.key = p.key ?? h.key;
      h.title = p.title ?? h.title;
      if (!open) enter('todo', null, r.t);
      if (p.column_name === 'done') { h.done_at = r.t; h.done_by = 'human'; }
    } else if (r.kind === 'card.update') {
      if (Array.isArray(p.fields?.title)) h.title = p.fields.title[1] ?? h.title;
      const col = columnChange(p.fields);
      // Human column moves only happen with no run state (§5.2 PATCH).
      if (col && (h.state == null || h.state === 'todo')) {
        if (col[1] === 'done') { h.done_at = r.t; h.done_by = 'human'; } else if (col[0] === 'done') { h.done_at = null; h.done_by = null; }
      }
    } else if (r.kind === 'card.transition') {
      const to = typeof p.to === 'string' ? p.to : null;
      if (!to) continue;
      const state = KNOWN.has(to) ? to : 'unknown';
      enter(state, p.state?.blocked_kind ?? null, r.t);
      if ((state === 'claimed' || state === 'running') && h.first_start == null) h.first_start = r.t;
      // Any move out of done (a dispatch from a human-done card, say) reopens it.
      if (state === 'done') { h.done_at = r.t; h.done_by = 'claude'; } else { h.done_at = null; h.done_by = null; }
    }
  }
  return h;
}

/** Map card_id → cardHistory over normalized rows. */
export function histories(rows) {
  const by = new Map();
  for (const r of normalizeJournal(rows)) {
    if (!by.has(r.card_id)) by.set(r.card_id, []);
    by.get(r.card_id).push(r);
  }
  const out = new Map();
  for (const [id, rs] of by) out.set(id, cardHistory(rs));
  return out;
}

/** Time a segment overlaps [lo, hi]; open segments run to `hi`. */
function overlap(seg, lo, hi) {
  const a = Math.max(seg.from, lo);
  const b = Math.min(seg.to ?? hi, hi);
  return Math.max(0, b - a);
}

/** Cycle time of a finished card: first start (else creation) → done. */
export function cycleTime(h) {
  if (h.done_at == null) return null;
  const start = h.first_start ?? h.created_at;
  if (start == null || start > h.done_at) return null;
  return h.done_at - start;
}

function cardRef(id, cardsById, h) {
  const v = cardsById.get(id);
  return { card_id: id, key: v?.key ?? h?.key ?? null, title: v?.title ?? h?.title ?? null, on_board: !!v };
}

function waitedOn(cards) {
  const people = new Map();
  for (const v of cards) {
    if (!v.ask || !['blocked', 'parked'].includes(v.run_state)) continue;
    const ids = v.ask.kind === 'permission'
      ? (v.approvers ?? [])
      : [...(v.assignee_ids ?? []), v.run?.owner?.member_id, v.run?.dispatched_by?.member_id];
    const names = new Map([[v.run?.owner?.member_id, v.run?.owner?.name], [v.run?.dispatched_by?.member_id, v.run?.dispatched_by?.name]]);
    for (const id of new Set(ids.filter(Boolean))) {
      const p = people.get(id) ?? { member_id: id, name: names.get(id) ?? null, cards: 0, asks: 0, permissions: 0, oldest_ms: 0 };
      p.cards += 1;
      if (v.ask.kind === 'permission') p.permissions += v.ask.count ?? 1; else p.asks += v.ask.count ?? 1;
      p.oldest_ms = Math.max(p.oldest_ms, v.state_age_ms ?? 0);
      people.set(id, p);
    }
  }
  return [...people.values()].sort((a, b) => b.cards - a.cards || b.oldest_ms - a.oldest_ms || String(a.member_id).localeCompare(String(b.member_id)));
}

const top = (list, n = 5) => list.slice().sort((a, b) => b.value - a.value || String(a.key ?? '').localeCompare(String(b.key ?? ''), undefined, { numeric: true })).slice(0, n);

/**
 * Everything the Dashboard shows. `rows` = journal rows as the hub sends them,
 * `cards` = CardViews (state_age_ms already aged), `now` = wall ms.
 */
export function dashboardMetrics({ rows = [], cards = [], now, windowMs = WINDOW_MS, weeks = WEEKS } = {}) {
  const hist = histories(rows);
  const cardsById = new Map(cards.map((v) => [v.id, v]));
  const lo = now - windowMs;

  // Cycle time and share: cards finished inside the window.
  const finished = [];
  for (const h of hist.values()) {
    if (h.done_at == null || h.done_at <= lo || h.done_at > now) continue;
    finished.push({ ...cardRef(h.card_id, cardsById, h), done_at: h.done_at, by: h.done_by, ms: cycleTime(h) });
  }
  const cycles = finished.filter((f) => f.ms != null);
  const cycleMs = cycles.map((f) => f.ms);
  const buckets = CYCLE_BUCKETS.map((b) => ({ id: b.id, label: b.label, count: 0 }));
  for (const ms of cycleMs) buckets[CYCLE_BUCKETS.findIndex((b) => ms < b.max)].count += 1;

  // Throughput: rolling 7-day buckets ending now, oldest first.
  const tp = Array.from({ length: weeks }, (_, i) => {
    const end = now - (weeks - 1 - i) * WEEK;
    return { start_ms: end - WEEK, end_ms: end, count: 0, claude: 0, human: 0 };
  });
  for (const h of hist.values()) {
    if (h.done_at == null) continue;
    const w = tp.find((b) => h.done_at > b.start_ms && h.done_at <= b.end_ms);
    if (!w) continue;
    w.count += 1;
    w[h.done_by] += 1;
  }

  const claude = finished.filter((f) => f.by === 'claude').length;
  const human = finished.length - claude;

  // Blocked time and the wait stages: segments clipped to the window.
  const blockedByCard = new Map();
  const blockedByKind = new Map();
  const stageByCard = new Map(WAIT_STAGES.map((s) => [s.id, new Map()]));
  const stageOf = new Map(WAIT_STAGES.flatMap((s) => s.states.map((st) => [st, s.id])));
  for (const h of hist.values()) {
    for (const seg of h.segments) {
      const ms = overlap(seg, lo, now);
      if (!ms) continue;
      if (seg.state === 'blocked' || seg.state === 'parked') {
        blockedByCard.set(h.card_id, (blockedByCard.get(h.card_id) ?? 0) + ms);
        const k = seg.kind ?? 'unknown';
        blockedByKind.set(k, (blockedByKind.get(k) ?? 0) + ms);
      }
      const stage = stageOf.get(seg.state);
      if (stage) {
        const m = stageByCard.get(stage);
        m.set(h.card_id, (m.get(h.card_id) ?? 0) + ms);
      }
    }
  }
  const blockedTotal = [...blockedByCard.values()].reduce((s, x) => s + x, 0);

  const stages = WAIT_STAGES.map((s) => {
    const per = [...stageByCard.get(s.id).values()];
    const current = cards.filter((v) => s.states.includes(v.run_state));
    return {
      id: s.id, label: s.label,
      total_ms: per.reduce((a, b) => a + b, 0), cards: per.length, median_ms: median(per),
      now_count: current.length, now_oldest_ms: current.length ? Math.max(...current.map((v) => v.state_age_ms ?? 0)) : null,
    };
  });
  const slowest = stages.reduce((best, s) => (s.median_ms != null && (best == null || s.median_ms > best.median_ms) ? s : best), null);

  // Cost: the snapshot's cumulative spend per card (not windowed).
  const spent = cards.filter((v) => Number(v.budget?.spent_usd) > 0).map((v) => ({ ...cardRef(v.id, cardsById, hist.get(v.id)), value: Number(v.budget.spent_usd) }));

  const thisWeek = tp[tp.length - 1];
  const lastWeek = tp[tp.length - 2] ?? null;
  return {
    now, window_ms: windowMs,
    has_history: hist.size > 0,
    cycle: { count: cycles.length, median_ms: median(cycleMs), p85_ms: percentile(cycleMs, 0.85), buckets, items: cycles },
    throughput: { weeks: tp, total: tp.reduce((s, w) => s + w.count, 0), this_week: thisWeek?.count ?? 0, last_week: lastWeek?.count ?? null },
    share: { claude, human, total: finished.length, claude_pct: finished.length ? claude / finished.length : null },
    blocked: {
      total_ms: blockedTotal, cards: blockedByCard.size,
      top: top([...blockedByCard].map(([id, ms]) => ({ ...cardRef(id, cardsById, hist.get(id)), value: ms }))),
      by_kind: [...blockedByKind].map(([kind, ms]) => ({ kind, value: ms })).sort((a, b) => b.value - a.value || a.kind.localeCompare(b.kind)),
    },
    cost: { total_usd: spent.reduce((s, x) => s + x.value, 0), median_usd: median(spent.map((x) => x.value)), cards: spent.length, top: top(spent) },
    bottleneck: { stages, slowest: slowest?.id ?? null, people: waitedOn(cards) },
  };
}
