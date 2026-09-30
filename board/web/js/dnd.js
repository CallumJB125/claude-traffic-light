// Pure drag-and-drop logic: move planning, selection and the keyboard state
// machine. No DOM, no clocks. A column is derived (rank, then recency), never
// stored, so a drop only ever changes `column`; where the card will *land* is
// computed by running the same sort with the column changed.
import { COLUMNS, COLUMN_LABEL, groupColumns, isHumanOwned } from './view.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * ids → what a drop on `column` would do. Run-driven cards never move by hand
 * (CONTRACT §10): they are skipped with a reason, not silently dropped.
 */
export function planMoves(ids, getView, column) {
  const moves = [];
  const skipped = [];
  const unchanged = [];
  for (const id of ids) {
    const v = getView(id);
    if (!v) continue;
    if (!isHumanOwned(v)) skipped.push({ id, key: v.key, reason: 'run' });
    else if (v.column === column) unchanged.push(id);
    else moves.push({ id, key: v.key, from: v.column, version: v.version });
  }
  return { moves, skipped, unchanged };
}

/** One sentence for the toast / live region after a (possibly partial) move. */
export function moveSummary(plan, column) {
  const label = COLUMN_LABEL[column] ?? column;
  const parts = [];
  if (plan.moves.length === 1) parts.push(`Moved ${plan.moves[0].key} to ${label}.`);
  else if (plan.moves.length > 1) parts.push(`Moved ${plural(plan.moves.length, 'card')} to ${label}.`);
  if (plan.skipped.length) {
    const keys = plan.skipped.map((s) => s.key).join(', ');
    const one = plan.skipped.length === 1;
    parts.push(`Skipped ${keys}: Claude drives ${one ? 'its' : 'their'} column, so ${one ? 'it' : 'they'} can't be moved by hand.`);
  }
  if (!plan.moves.length && !plan.skipped.length && plan.unchanged.length) parts.push(`Already in ${label}.`);
  return parts.join(' ');
}

/**
 * The card the moved cards will sit directly above once the column is sorted
 * (null = the end). Lets the UI draw one indicator line at the derived spot.
 */
export function dropSlot(entries, ids, column) {
  const set = new Set(ids);
  const moved = entries.map((e) => (set.has(e.view.id) ? { ...e, view: { ...e.view, column } } : e));
  const list = groupColumns(moved)[column] ?? [];
  const i = list.findIndex((e) => set.has(e.view.id));
  if (i < 0) return { before: null };
  return { before: list.slice(i).find((e) => !set.has(e.view.id))?.view.id ?? null };
}

/** What the board renders while something is held over `over` (or nothing yet). */
export function dragModel({ ids, over, mode }, entries) {
  const byId = new Map(entries.map((e) => [e.view.id, e.view]));
  const plan = over ? planMoves(ids, (id) => byId.get(id), over) : { moves: [], skipped: [], unchanged: [] };
  const ok = plan.moves.length > 0;
  return { ids, over, mode, ok, plan, before: ok ? dropSlot(entries, plan.moves.map((m) => m.id), over).before : null };
}

// ── selection ───────────────────────────────────────────────────────────────

export function toggleSelection(sel, id) {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Drop ids that left the board (removed, or filtered out of sight). */
export function pruneSelection(sel, existingIds) {
  const have = new Set(existingIds);
  const next = new Set([...sel].filter((id) => have.has(id)));
  return next.size === sel.size ? sel : next;
}

/** Dragging a selected card carries the whole selection; any other card goes alone. */
export function idsToDrag(sel, id) {
  return sel.has(id) ? [...sel] : [id];
}

export function selectionBar(sel, getView) {
  const views = [...sel].map(getView).filter(Boolean);
  const movable = views.filter(isHumanOwned).length;
  return {
    count: views.length,
    movable,
    skipped: views.length - movable,
    text: `${views.length} selected`,
  };
}

// ── keyboard ────────────────────────────────────────────────────────────────

export function kbdStart(ids, column) {
  return { ids, from: column, over: column };
}

/**
 * Space picked a card up; left/right choose a column (no wrap), Space/Enter
 * drops, Escape cancels. Anything else is not ours (effect null, state kept).
 */
export function kbdKey(state, key) {
  const i = COLUMNS.indexOf(state.over);
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const over = COLUMNS[Math.max(0, Math.min(COLUMNS.length - 1, i + (key === 'ArrowRight' ? 1 : -1)))];
    return { state: { ...state, over }, effect: { type: 'over', column: over, edge: over === state.over } };
  }
  if (key === ' ' || key === 'Enter') {
    return { state: null, effect: state.over === state.from ? { type: 'cancel', dropped: true } : { type: 'drop', column: state.over } };
  }
  if (key === 'Escape') return { state: null, effect: { type: 'cancel' } };
  return { state, effect: null };
}

/** Live-region text for each step of the keyboard flow. */
export function announcement(effect, { key, count = 1, from, over, plan } = {}) {
  const what = count > 1 ? `${count} cards` : key;
  switch (effect.type) {
    case 'pickup':
      return `Picked up ${what}. Left and right arrows choose a column, Space drops, Escape cancels.`;
    case 'over': {
      if (effect.edge) return `${COLUMN_LABEL[over]}. No column further that way.`;
      return `${what} over ${COLUMN_LABEL[over]}.`;
    }
    case 'drop': return plan ? moveSummary(plan, over) : `Moved ${what} to ${COLUMN_LABEL[over]}.`;
    case 'cancel': return effect.dropped ? `${what} stays in ${COLUMN_LABEL[from]}.` : `Cancelled. ${what} stays in ${COLUMN_LABEL[from]}.`;
    default: return '';
  }
}
