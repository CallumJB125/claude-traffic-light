// Board filters as pure logic: the filter model, its URL form (?q= and &f=),
// matching, and the counts the bar shows. Shared by the Board and Table views.
import { alertsForViewer } from './view.js';

export const CHIPS = [
  { id: 'mine', label: 'Mine', hint: 'Cards you own, run or are assigned' },
  { id: 'needs', label: 'Needs you', hint: 'Cards on your attention strip' },
  { id: 'working', label: 'Claude working', hint: 'A Claude is running it right now' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting for an answer or approval' },
];
const CHIP_IDS = new Set(CHIPS.map((c) => c.id));
const WORKING = new Set(['claimed', 'running', 'quiet']);

export const emptyFilters = () => ({ q: '', chips: [], labels: [], assignee: null });

export function isFiltering(f) {
  return !!(f.q.trim() || f.chips.length || f.labels.length || f.assignee);
}

// ── URL form: ?q=text&f=mine,blocked,l:api,a:m-alice ─────────────────────────
// Values are percent-encoded per token so a label with a comma survives.

export function parseFilters(search) {
  const p = new URLSearchParams(search);
  const f = emptyFilters();
  f.q = (p.get('q') ?? '').slice(0, 200);
  for (const tok of (p.get('f') ?? '').split(',').filter(Boolean)) {
    let v;
    try { v = decodeURIComponent(tok); } catch { continue; }
    if (CHIP_IDS.has(v)) { if (!f.chips.includes(v)) f.chips.push(v); }
    else if (v.startsWith('l:') && v.length > 2) { if (!f.labels.includes(v.slice(2))) f.labels.push(v.slice(2)); }
    else if (v.startsWith('a:') && v.length > 2) f.assignee = v.slice(2);
  }
  return f;
}

/** Writes q/f into `params` (a URLSearchParams), removing them when empty. */
export function writeFilters(f, params) {
  const toks = [...f.chips, ...f.labels.map((l) => `l:${l}`), ...(f.assignee ? [`a:${f.assignee}`] : [])].map(encodeURIComponent);
  if (f.q.trim()) params.set('q', f.q); else params.delete('q');
  if (toks.length) params.set('f', toks.join(',')); else params.delete('f');
  return params;
}

export function toggleIn(list, v) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

// ── matching ────────────────────────────────────────────────────────────────

const involves = (v, id) => !!id && (
  (v.assignee_ids ?? []).includes(id) || v.run?.owner?.member_id === id || v.run?.dispatched_by?.member_id === id);

const CHIP_TEST = {
  mine: (e, ctx) => involves(e.view, ctx.viewerId),
  needs: (e, ctx) => alertsForViewer(ctx.viewerId, [e], { max: 1 }).items.length > 0,
  working: (e) => WORKING.has(e.view.run_state ?? 'todo'),
  blocked: (e) => e.view.run_state === 'blocked',
};

function haystack(e, members) {
  const v = e.view;
  const people = [...(v.assignee_ids ?? []).map((id) => members.get(id)), v.run?.owner].filter(Boolean).map((m) => m.name ?? m.login);
  return [v.key, v.title, v.repo?.short_name, v.branch, e.face?.label, ...(v.labels ?? []), ...people].filter(Boolean).join('\n').toLowerCase();
}

/** Chips AND together; labels are any-of; the assignee and every word of the text must match. */
export function matchEntry(e, f, ctx) {
  for (const c of f.chips) if (!CHIP_TEST[c]?.(e, ctx)) return false;
  if (f.labels.length && !f.labels.some((l) => (e.view.labels ?? []).includes(l))) return false;
  if (f.assignee && !involves(e.view, f.assignee)) return false;
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = haystack(e, ctx.members);
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function applyFilters(entries, f, ctx) {
  const shown = isFiltering(f) ? entries.filter((e) => matchEntry(e, f, ctx)) : entries;
  return { entries: shown, total: entries.length, shown: shown.length };
}

/** What each chip would match on its own, plus the label and person pickers. */
export function filterOptions(entries, ctx) {
  const counts = Object.fromEntries(CHIPS.map((c) => [c.id, entries.filter((e) => CHIP_TEST[c.id](e, ctx)).length]));
  const labels = new Map();
  const people = new Map();
  for (const e of entries) {
    for (const l of e.view.labels ?? []) labels.set(l, (labels.get(l) ?? 0) + 1);
    for (const id of e.view.assignee_ids ?? []) if (ctx.members.get(id)) people.set(id, ctx.members.get(id));
  }
  return {
    counts,
    labels: [...labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, n]) => ({ label, n })),
    people: [...people].map(([id, m]) => ({ id, name: m.name ?? m.login })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
