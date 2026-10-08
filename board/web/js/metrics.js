// Dashboard metrics: pure functions over the board journal (CONTRACT §15) and
// the snapshot's CardViews. No DOM and no clocks: `now` (hub wall ms, the same
// clock as the journal's at_hub) comes in from the caller.
//
// Journal rows are folded into per-card histories as pages arrive (foldRows)
// and never kept, so the browser holds a few numbers per card instead of the
// whole journal. windowMetrics reads the histories (once a minute or on new
// rows); cardMetrics joins them with the live cards (on every card change).
import { STATES } from '../../shared/states.js';
import { hasLiveCapture } from './view.js';

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
const KEPT = new Set(['card.create', 'card.update', 'card.transition']);
// Only these stretches are ever summed, so only these are remembered.
const WAIT_STATES = new Set(WAIT_STAGES.flatMap((s) => s.states));
const STARTED_COLUMNS = new Set(['in_progress', 'in_review']);

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

/**
 * Hub clock minus this browser's clock, from a response's Date header (whole
 * seconds, so +500 ms is its expected truncation) against the request's
 * midpoint. null when the header is missing or unreadable.
 */
export function clockOffset(dateHeader, sentAt, receivedAt) {
  const hub = Date.parse(dateHeader ?? '');
  if (!Number.isFinite(hub) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return null;
  return hub + 500 - (sentAt + receivedAt) / 2;
}

// ── fold ─────────────────────────────────────────────────────────────────────

export const emptyFold = () => ({ cards: new Map(), lastSeq: 0, version: 0 });

function newHistory(id) {
  return { card_id: id, key: null, title: null, first_start: null, done_at: null, done_by: null, state: null, open: null, waits: [] };
}

function enter(h, state, kind, t) {
  const o = h.open;
  if (o && WAIT_STATES.has(o.state)) h.waits.push({ state: o.state, kind: o.kind, from: o.from, to: Math.max(o.from, t) });
  h.open = { state, kind: kind ?? null, from: t };
  h.state = state;
}

const columnChange = (fields) => {
  const c = fields?.column_name ?? fields?.column;
  return Array.isArray(c) && c.length === 2 ? c : null;
};

function apply(h, r, t) {
  const p = r.payload ?? {};
  if (r.kind === 'card.create') {
    h.key = p.key ?? h.key;
    h.title = p.title ?? h.title;
    if (!h.open) enter(h, 'todo', null, t);
    if (p.column_name === 'done') { h.done_at = t; h.done_by = 'human'; }
  } else if (r.kind === 'card.update') {
    if (Array.isArray(p.fields?.title)) h.title = p.fields.title[1] ?? h.title;
    const col = columnChange(p.fields);
    // Human column moves only happen with no run state (§5.2 PATCH).
    if (col && (h.state == null || h.state === 'todo')) {
      if (STARTED_COLUMNS.has(col[1]) && h.first_start == null) h.first_start = t;
      if (col[1] === 'done') { h.done_at = t; h.done_by = 'human'; } else if (col[0] === 'done') { h.done_at = null; h.done_by = null; }
    }
  } else if (r.kind === 'card.transition') {
    const to = typeof p.to === 'string' ? p.to : null;
    if (!to) return;
    const state = KNOWN.has(to) ? to : 'unknown';
    enter(h, state, p.state?.blocked_kind, t);
    if ((state === 'claimed' || state === 'running') && h.first_start == null) h.first_start = t;
    // Any move out of done (a dispatch from a human-done card, say) reopens it.
    if (state === 'done') { h.done_at = t; h.done_by = 'claude'; } else { h.done_at = null; h.done_by = null; }
  }
}

/**
 * Fold journal rows into `fold` (mutated and returned). Rows at or below the
 * last folded seq are skipped (already folded, or a duplicate); a batch is
 * applied in seq order whatever order it came in.
 */
export function foldRows(fold, rows) {
  const batch = [];
  for (const r of rows ?? []) {
    if (!r) continue;
    if (r.seq != null && r.seq <= fold.lastSeq) continue;
    batch.push(r);
  }
  batch.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  let prev = null;
  for (const r of batch) {
    if (r.seq != null && r.seq === prev) continue;
    prev = r.seq ?? prev;
    if (r.seq != null) fold.lastSeq = Math.max(fold.lastSeq, r.seq);
    if (r.card_id == null || !KEPT.has(r.kind)) continue;
    const t = typeof r.at_hub === 'number' ? r.at_hub : Date.parse(r.at_hub);
    if (!Number.isFinite(t)) continue;
    if (!fold.cards.has(r.card_id)) fold.cards.set(r.card_id, newHistory(r.card_id));
    apply(fold.cards.get(r.card_id), r, t);
  }
  if (batch.length) fold.version += 1;
  return fold;
}

/** Map card_id → history for a set of rows. */
export const histories = (rows) => foldRows(emptyFold(), rows).cards;

/**
 * Read the journal from the fold's last seq to the end, a page at a time.
 * fetchPage(afterSeq, limit) → {rows, next_after_seq, offset_ms?}. A hub
 * restart or restore is the caller's to catch (the WS welcome's hub_epoch):
 * rows carry a new epoch after every boot, so it says nothing here.
 */
export async function pullJournal(fold, fetchPage, { pageSize = 1000, maxPages = 1000 } = {}) {
  let offset = null;
  for (let i = 0; i < maxPages; i++) {
    const after = fold.lastSeq;
    const page = await fetchPage(after, pageSize);
    if (page?.offset_ms != null) offset = page.offset_ms;
    const rows = page?.rows ?? [];
    foldRows(fold, rows);
    if (Number.isSafeInteger(page?.next_after_seq)) fold.lastSeq = Math.max(fold.lastSeq, page.next_after_seq);
    if (rows.length < pageSize || fold.lastSeq === after) break;
  }
  return { fold, offset };
}

// ── metrics ──────────────────────────────────────────────────────────────────

/** Time a stretch overlaps [lo, hi]; the open stretch runs to `hi`. */
function overlap(seg, lo, hi) {
  const a = Math.max(seg.from, lo);
  const b = Math.min(seg.to ?? hi, hi);
  return Math.max(0, b - a);
}

/** Cycle time of a finished card: first start → done. No start, no cycle time. */
export function cycleTime(h) {
  if (h.done_at == null || h.first_start == null || h.first_start > h.done_at) return null;
  return h.done_at - h.first_start;
}

/** The history-only part: everything that depends on the journal and `now`. */
export function windowMetrics(fold, now, { windowMs = WINDOW_MS, weeks = WEEKS } = {}) {
  const lo = now - windowMs;
  const finished = [];
  const tp = Array.from({ length: weeks }, (_, i) => {
    const end = now - (weeks - 1 - i) * WEEK;
    return { start_ms: end - WEEK, end_ms: end, count: 0, claude: 0, human: 0 };
  });
  const blockedByCard = new Map();
  const blockedByKind = new Map();
  const stageByCard = new Map(WAIT_STAGES.map((s) => [s.id, new Map()]));
  const stageOf = new Map(WAIT_STAGES.flatMap((s) => s.states.map((st) => [st, s.id])));

  for (const h of fold.cards.values()) {
    if (h.done_at != null) {
      // A reopened and re-finished card counts once, in the week it was last finished.
      const w = tp.find((b) => h.done_at > b.start_ms && h.done_at <= b.end_ms);
      if (w) { w.count += 1; w[h.done_by] += 1; }
      if (h.done_at > lo && h.done_at <= now) finished.push({ card_id: h.card_id, done_at: h.done_at, by: h.done_by, ms: cycleTime(h) });
    }
    const segs = h.open && WAIT_STATES.has(h.open.state) ? [...h.waits, h.open] : h.waits;
    for (const seg of segs) {
      const ms = overlap(seg, lo, now);
      if (!ms) continue;
      if (seg.state === 'blocked' || seg.state === 'parked') {
        blockedByCard.set(h.card_id, (blockedByCard.get(h.card_id) ?? 0) + ms);
        const k = seg.kind ?? 'unknown';
        blockedByKind.set(k, (blockedByKind.get(k) ?? 0) + ms);
      }
      const m = stageByCard.get(stageOf.get(seg.state));
      m.set(h.card_id, (m.get(h.card_id) ?? 0) + ms);
    }
  }

  const cycles = finished.filter((f) => f.ms != null);
  const cycleMs = cycles.map((f) => f.ms);
  const buckets = CYCLE_BUCKETS.map((b) => ({ id: b.id, label: b.label, count: 0 }));
  for (const ms of cycleMs) buckets[CYCLE_BUCKETS.findIndex((b) => ms < b.max)].count += 1;
  const claude = finished.filter((f) => f.by === 'claude').length;
  const stages = WAIT_STAGES.map((s) => {
    const per = [...stageByCard.get(s.id).values()];
    return { id: s.id, label: s.label, states: s.states, total_ms: per.reduce((a, b) => a + b, 0), cards: per.length, median_ms: median(per) };
  });
  const slowest = stages.reduce((best, s) => (s.median_ms != null && (best == null || s.median_ms > best.median_ms) ? s : best), null);
  return {
    now, window_ms: windowMs,
    has_history: fold.cards.size > 0,
    cycle: { count: cycles.length, median_ms: median(cycleMs), p85_ms: percentile(cycleMs, 0.85), buckets, items: cycles },
    throughput: { weeks: tp, total: tp.reduce((s, w) => s + w.count, 0), this_week: tp.at(-1)?.count ?? 0, last_week: tp.at(-2)?.count ?? null },
    share: { claude, human: finished.length - claude, total: finished.length, claude_pct: finished.length ? claude / finished.length : null },
    blocked: {
      total_ms: [...blockedByCard.values()].reduce((s, x) => s + x, 0), cards: blockedByCard.size,
      by_card: [...blockedByCard].map(([card_id, value]) => ({ card_id, value })),
      by_kind: [...blockedByKind].map(([kind, value]) => ({ kind, value })).sort((a, b) => b.value - a.value || a.kind.localeCompare(b.kind)),
    },
    stages, slowest: slowest?.id ?? null,
  };
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

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const top = (list, n = 5) => list.slice().sort((a, b) => b.value - a.value || collator.compare(String(a.key ?? ''), String(b.key ?? ''))).slice(0, n);

/** Join the window metrics with the live cards (aged CardViews): cheap, run on every card change. */
export function cardMetrics(win, fold, cards) {
  // A card an AI is still working on is not finished, whatever its column says.
  const unfinished = cards.filter((v) => hasLiveCapture(v) && fold.cards.get(v.id)?.done_at != null).map((v) => v.id);
  if (unfinished.length) {
    const hist = new Map(fold.cards);
    for (const id of unfinished) hist.set(id, { ...hist.get(id), done_at: null, done_by: null });
    win = windowMetrics({ ...fold, cards: hist }, win.now, { windowMs: win.window_ms, weeks: win.throughput.weeks.length });
  }
  const cardsById = new Map(cards.map((v) => [v.id, v]));
  const ref = (id) => cardRef(id, cardsById, fold.cards.get(id));
  // The hub sends budget: null for a card with no cap, spend included, so
  // those cards' spend is unknown here rather than zero.
  const budgeted = cards.filter((v) => v.budget != null);
  const spent = budgeted.filter((v) => Number(v.budget.spent_usd) > 0).map((v) => ({ ...ref(v.id), value: Number(v.budget.spent_usd) }));
  return {
    now: win.now, window_ms: win.window_ms, has_history: win.has_history,
    cycle: { ...win.cycle, items: win.cycle.items.map((f) => ({ ...ref(f.card_id), ...f })) },
    throughput: win.throughput,
    share: win.share,
    blocked: { total_ms: win.blocked.total_ms, cards: win.blocked.cards, by_kind: win.blocked.by_kind, top: top(win.blocked.by_card.map((x) => ({ ...ref(x.card_id), value: x.value }))) },
    cost: { total_usd: spent.reduce((s, x) => s + x.value, 0), median_usd: median(spent.map((x) => x.value)), cards: spent.length, unbudgeted: cards.length - budgeted.length, top: top(spent) },
    bottleneck: {
      stages: win.stages.map(({ states, ...s }) => {
        const current = cards.filter((v) => states.includes(v.run_state));
        return { ...s, now_count: current.length, now_oldest_ms: current.length ? Math.max(...current.map((v) => v.state_age_ms ?? 0)) : null };
      }),
      slowest: win.slowest,
      people: waitedOn(cards),
    },
  };
}

/**
 * Everything the Dashboard shows, in one call. `rows` = journal rows as the
 * hub sends them, `cards` = CardViews (state_age_ms already aged), `now` =
 * hub wall ms.
 */
export function dashboardMetrics({ rows = [], cards = [], now, windowMs = WINDOW_MS, weeks = WEEKS } = {}) {
  const fold = foldRows(emptyFold(), rows);
  return cardMetrics(windowMetrics(fold, now, { windowMs, weeks }), fold, cards);
}
