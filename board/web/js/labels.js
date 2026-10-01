// Label colours, covers and archive on the web (CONTRACT D91, D93, D94). Pure.
// Colours are CSS classes only (`label-c-<token>`, `cover-<token>`): the CSP
// has no 'unsafe-inline' for styles, and the tokens are the hub's own list.
import { LABEL_COLORS } from '../../shared/protocol.js';
import { POLICY_LABELS, isReservedLabel } from '../../shared/states.js';

export { LABEL_COLORS };
const COLORS = new Set(LABEL_COLORS);
export const VIA_LABEL = /^via:[a-z0-9-]{2,32}$/;

/** registry [{name, color}] → Map(lower-case name → token): card labels match ignoring case. */
export function colorMap(registry) {
  return new Map((registry ?? []).filter((l) => COLORS.has(l.color)).map((l) => [String(l.name).toLowerCase(), l.color]));
}

/**
 * The colour a card label shows: the live registry when the board has one
 * (it changes under `board.labels`), else the hub's `label_colors` as of send.
 * Policy labels never take a colour: they get a fixed outline instead.
 */
export function labelColor(name, i, view, colors) {
  if (isReservedLabel(name)) return null;
  const c = colors ? colors.get(String(name).toLowerCase()) : view?.label_colors?.[i];
  return COLORS.has(c) ? c : null;
}

export function labelClass(name, color) {
  if (POLICY_LABELS.includes(String(name).toLowerCase())) return 'label is-policy';
  return color ? `label label-c-${color}` : 'label';
}

export const coverClass = (token) => (COLORS.has(token) ? ` has-cover cover-${token}` : '');

// Only a card with no run, or a finished one, can be archived (D94).
export const canArchive = (view) => !view.archived && ['todo', 'done', 'failed'].includes(view.run_state ?? 'todo');

/** The label manager's rows: registry entries, then labels on cards with no entry (reserved ones left out). */
export function managerRows(registry, cardLabels) {
  const known = colorMap(registry);
  const rows = [...(registry ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ name: l.name, color: l.color, registered: true }));
  const seen = new Set();
  for (const name of cardLabels) {
    const k = String(name).toLowerCase();
    if (known.has(k) || seen.has(k) || isReservedLabel(name) || VIA_LABEL.test(name)) continue;
    seen.add(k);
    rows.push({ name, color: null, registered: false });
  }
  return rows;
}
