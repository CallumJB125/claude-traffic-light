'use strict';
// Team file heat map: which files and folders teammates' sessions touched in
// the last 24 hours or 7 days. Pure. Input is the activity records the desktop
// already reads (src/team-activity.js `record` shape); files exist on a record
// only when its author chose to share them, so nothing here reaches further.
// An active session (working or waiting) counts double: it is where a clash
// can still happen. A file edited by two or more people is flagged.

const WINDOWS = Object.freeze({ '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 });
const ACTIVE = new Set(['working', 'waiting']);
const LIMITS = Object.freeze({ dirs: 8, filesPerDir: 5, people: 4 });

const time = (iso) => Date.parse(iso || '') || 0;
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '.'; };
const byHeat = (a, b) => b.weight - a.weight || b.people.length - a.people.length || a.path.localeCompare(b.path);

// records: [{author, status, updated_at, files:{edited, read}}]. → { window, files, dirs, shared, total }
function heatmap(records, { window = '24h', now = Date.now() } = {}) {
  const span = WINDOWS[window] || WINDOWS['24h'];
  const files = new Map(); // path -> { path, count, weight, people:Set, active }
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.files || !Array.isArray(r.files.edited)) continue;
    const active = ACTIVE.has(r.status);
    const at = time(r.updated_at);
    if (!active && !(at && now - at <= span)) continue;
    const w = active ? 2 : 1;
    for (const p of new Set(r.files.edited)) {
      if (typeof p !== 'string' || !p) continue;
      const f = files.get(p) || { path: p, count: 0, weight: 0, people: new Set(), active: false };
      f.count += 1; f.weight += w; f.active = f.active || active;
      if (r.author) f.people.add(r.author);
      files.set(p, f);
    }
  }
  const rows = [...files.values()].map((f) => ({ path: f.path, count: f.count, weight: f.weight, active: f.active, people: [...f.people].sort(), shared: f.people.size >= 2 })).sort(byHeat);
  const dirs = new Map();
  for (const f of rows) {
    const d = dirOf(f.path);
    const x = dirs.get(d) || { path: d, count: 0, weight: 0, people: new Set(), files: [], shared: false };
    x.count += f.count; x.weight += f.weight; x.shared = x.shared || f.shared;
    f.people.forEach((p) => x.people.add(p));
    x.files.push({ ...f, name: f.path.slice(d === '.' ? 0 : d.length + 1) });
    dirs.set(d, x);
  }
  const tree = [...dirs.values()].map((d) => ({ path: d.path, count: d.count, weight: d.weight, shared: d.shared, people: [...d.people].sort().slice(0, LIMITS.people), files: d.files.slice(0, LIMITS.filesPerDir), more: Math.max(0, d.files.length - LIMITS.filesPerDir) })).sort(byHeat);
  return { window: WINDOWS[window] ? window : '24h', files: rows, dirs: tree.slice(0, LIMITS.dirs), more: Math.max(0, tree.length - LIMITS.dirs), shared: rows.filter((f) => f.shared).map((f) => f.path), total: rows.length };
}

module.exports = { heatmap, WINDOWS, LIMITS };
