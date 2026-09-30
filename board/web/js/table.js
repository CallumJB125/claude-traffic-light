// Table view logic: pure (entries, query) → rows. No DOM, no clocks; ages come
// in already aged (entry.elapsed_ms), like the board columns.
import { columnFor, stripGlyph, COLUMN_LABEL, repoBranch } from './view.js';
import { COLUMNS } from '../../shared/states.js';

// Same "what needs a human first" order as the board columns, so sorting by
// status in the table and scanning a column agree.
const STATUS_RANK = { blocked: 0, orphaned: 1, failed: 1, parked: 1, unresponsive: 2, suspended: 2, handing_over: 3, handed_over: 3, quiet: 4, running: 5, claimed: 5, reconnecting: 5, queued: 6, in_review: 6, todo: 7, done: 8 };

export const TABLE_COLUMNS = [
  { id: 'key', label: 'Key' },
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'column', label: 'Column' },
  { id: 'people', label: 'People' },
  { id: 'repo', label: 'Repo' },
  { id: 'labels', label: 'Labels' },
  { id: 'cost', label: 'Cost', num: true },
  { id: 'age', label: 'In state', num: true },
];

export const DEFAULT_SORT = { by: 'status', dir: 'asc' };

function peopleOf(view, members) {
  const ids = new Set(view.assignee_ids ?? []);
  if (view.run?.owner?.member_id) ids.add(view.run.owner.member_id);
  return [...ids].map((id) => members.get(id) ?? (view.run?.owner?.member_id === id ? view.run.owner : null)).filter(Boolean);
}

export function toRow(entry, members) {
  const { view, face, elapsed_ms = 0 } = entry;
  const col = columnFor(view, face);
  const cost = view.budget?.spent_usd ?? null;
  return {
    id: view.id,
    key: view.key,
    title: view.title,
    status: face.state,
    status_label: face.label,
    status_reason: face.reason ? stripGlyph(face.reason) : null,
    tone: face.tone,
    column: col,
    column_label: COLUMN_LABEL[col] ?? col,
    people: peopleOf(view, members),
    repo: repoBranch(view),
    labels: view.labels ?? [],
    cost,
    cap: view.budget?.cap_usd ?? null,
    age_ms: view.state_age_ms == null ? null : view.state_age_ms + elapsed_ms,
    pr: view.pr ?? null,
    entry,
  };
}

const keyNum = (k) => String(k ?? '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmpText = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

// Empty values sort last in both directions: a blank cost is "unknown", not zero.
function cmpNullable(a, b, dir, cmp) {
  const an = a == null || a === '';
  const bn = b == null || b === '';
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return dir * cmp(a, b);
}

const SORTERS = {
  key: (r) => keyNum(r.key),
  title: (r) => r.title,
  status: (r) => STATUS_RANK[r.status] ?? 9,
  column: (r) => COLUMNS.indexOf(r.column),
  people: (r) => r.people.map((p) => p.name ?? p.login).join(', ') || null,
  repo: (r) => r.repo,
  labels: (r) => r.labels.join(', ') || null,
  cost: (r) => r.cost,
  age: (r) => r.age_ms,
};

export function matches(row, needle) {
  if (!needle) return true;
  const hay = [row.key, row.title, row.status_label, row.column_label, row.repo, ...row.labels, ...row.people.map((p) => p.name ?? p.login)]
    .filter(Boolean).join('\n').toLowerCase();
  return needle.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

export function tableRows(entries, { members = new Map(), sort = DEFAULT_SORT, filter = '' } = {}) {
  const rows = entries.map((e) => toRow(e, members)).filter((r) => matches(r, filter.trim()));
  const get = SORTERS[sort.by] ?? SORTERS.status;
  const dir = sort.dir === 'desc' ? -1 : 1;
  const numeric = sort.by === 'status' || sort.by === 'column' || sort.by === 'cost' || sort.by === 'age';
  rows.sort((a, b) => cmpNullable(get(a), get(b), dir, numeric ? (x, y) => x - y : cmpText)
    // Ties: needs-you first, then newest state, then key, whatever the sort.
    || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || (a.age_ms ?? Infinity) - (b.age_ms ?? Infinity)
    || cmpText(a.key, b.key));
  return rows;
}

/** Clicking a header: same column flips direction, a new one starts ascending. */
export function nextSort(sort, by) {
  if (sort.by === by) return { by, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  // Cost and age read best largest-first.
  return { by, dir: by === 'cost' || by === 'age' ? 'desc' : 'asc' };
}

export function summary(rows) {
  const spent = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
  const needs = rows.filter((r) => r.tone === 'amber' || r.tone === 'red').length;
  return { count: rows.length, spent, needs };
}
