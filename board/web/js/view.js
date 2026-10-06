// Pure view logic over the shared card face. No DOM, no clocks: callers pass
// `elapsed_ms` (performance.now() since the view arrived) and whether the
// board socket is down.
import { cardFace, alertsFor, sponsorLine } from '../../shared/cardface.js';
import { formatAge } from '../../shared/liveness.js';
import { ACTIVE, COLUMNS } from '../../shared/states.js';

export const COLUMN_LABEL = { todo: 'To do', in_progress: 'In progress', in_review: 'Review', done: 'Done' };
export { COLUMNS, formatAge, sponsorLine };

/**
 * cardFace + decision D13: green shows only when the hub's LeaseView.green
 * AND the client's recomputation on aged values agree. When they disagree the
 * card falls back to the quiet tone; it never borrows the hub's word alone.
 */
export function displayFace(view, { elapsed_ms = 0, connection_lost = false } = {}) {
  const face = cardFace(view, { elapsed_ms, connection_lost });
  const hubGreen = view.live?.green === true;
  const green = face.green && hubGreen && !connection_lost;
  let tone = face.tone;
  if (face.tone === 'green' && !green) tone = connection_lost ? 'unknown' : 'quiet';
  return { ...face, green, tone, hub_green: hubGreen, client_green: face.green, disagree: face.green !== hubGreen && !!view.live };
}

// A card with no run is human-owned: its column is whatever a person set.
// Everything else is derived from run state and never dragged.
export const isHumanOwned = (view) => (view.run_state ?? 'todo') === 'todo';
// Captured work already exists outside the board dispatcher. Once a real run
// is queued/started, keep that run's normal controls and verified liveness.
export const isObservedWork = (view) => !view.run && isHumanOwned(view) && view.capture?.source === 'local_observation';

// An AI is reporting work on this card right now: it is not done, whatever
// column a person last chose.
export const hasLiveCapture = (view) => view.capture?.fresh === true && view.capture?.status === 'working';

export function cardWorkPhase(view, face) {
  if (isObservedWork(view)) return null;
  if (face.state === 'in_review' || (isHumanOwned(view) && view.column === 'in_review')) return 'Awaiting human review';
  if (view.run && face.green === true) return 'AI working';
  if (view.run && face.state === 'quiet') return 'No recent AI activity';
  if (view.run && face.state === 'running') return 'AI activity not confirmed';
  return null;
}

export function columnFor(view, face) {
  if (isHumanOwned(view) && hasLiveCapture(view)) return 'in_progress';
  if (isHumanOwned(view) && COLUMNS.includes(view.column)) return view.column;
  return face.column;
}

// Ordering inside a column: what needs a human first, then live work, then
// the rest by recency (smallest state age first).
const RANK = { blocked: 0, orphaned: 1, failed: 1, parked: 1, unresponsive: 2, suspended: 2, handing_over: 3, handed_over: 3, quiet: 4, running: 5, claimed: 5, reconnecting: 5, queued: 6, in_review: 6, todo: 7, done: 8 };

export function groupColumns(entries) {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  for (const e of entries) cols[columnFor(e.view, e.face)]?.push(e);
  for (const c of COLUMNS) {
    cols[c].sort((a, b) => (RANK[a.face.state] ?? 9) - (RANK[b.face.state] ?? 9)
      || (a.view.state_age_ms ?? Infinity) - (b.view.state_age_ms ?? Infinity)
      || String(a.view.key).localeCompare(String(b.view.key), undefined, { numeric: true }));
  }
  return cols;
}

// The alerts strip reads state ages, so feed it the aged views.
export function agedView(view, elapsed_ms) {
  return { ...view, state_age_ms: view.state_age_ms == null ? null : view.state_age_ms + elapsed_ms };
}

export function alertsForViewer(viewerId, entries, opts) {
  const res = alertsFor(viewerId, entries.map((e) => agedView(e.view, e.elapsed_ms ?? 0)), opts);
  return { ...res, items: res.items.map((a) => ({ ...a, text: stripGlyph(a.text) })) };
}

// cardface strings lead with a glyph (✋ ⚠ ✖); the web draws its own icon.
export function stripGlyph(s) {
  return String(s ?? '').replace(/^[←-⯿\u{1F300}-\u{1FAFF}]️?\s*/u, '');
}

export function repoBranch(view) {
  const repo = view.repo?.short_name;
  const ref = view.branch ?? view.base_ref;
  if (!repo && !ref) return null;
  return `${repo ?? '?'}${ref ? `@${ref}` : ''}`;
}

export function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  const v = Number(n);
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

export function clock(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function initials(name) {
  const parts = String(name ?? '?').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Stable hue per member for initials chips (not a status colour).
export function hueOf(s) {
  let x = 0;
  for (const ch of String(s ?? '')) x = (x * 31 + ch.codePointAt(0)) % 360;
  return x;
}

// Header lamps: the board's own traffic light, as the widget would show it.
export function boardLamps(viewerId, entries, connection_lost) {
  if (connection_lost) return { red: false, amber: false, green: false };
  const { items } = alertsForViewer(viewerId, entries, { max: 99 });
  return {
    red: items.some((a) => a.kind === 'orphaned' || a.kind === 'failed'),
    amber: items.some((a) => a.kind === 'blocked' || a.kind === 'overlap'),
    green: entries.some((e) => e.face.green),
  };
}

export const isActive = (state) => ACTIVE.has(state);

// Button copy for each cardface action id.
export const ACTION_LABEL = {
  give_to_claude: 'Tackle with AI',
  cancel: 'Cancel',
  stop: 'Stop',
  watch: 'Watch',
  switch_ai: 'Move to another AI',
  view_handover: 'Read handover',
  allow: 'Review request',
  deny: null,
  answer: 'Answer',
  approve_plan: 'Review plan',
  resolve_conflict: 'Resolve',
  continue: 'Review',
  take_over_confirm: 'Take over…',
  take_over: 'Take over',
  take_over_with_claude: 'Tackle with AI',
  take_over_myself: 'Take it myself',
  open_pr: 'Open PR',
  request_changes: 'Request changes',
  retry: 'Retry',
};

// Rarely needed actions: only in the drawer, behind its Advanced disclosure.
export const ADVANCED_ACTIONS = new Set(['switch_ai', 'request_changes']);

// Which action id is the primary (filled) button for a face.
export function primaryAction(face) {
  return face.actions.find((a) => ACTION_LABEL[a]) ?? null;
}
