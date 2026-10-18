'use strict';
// ⌘K search over people, projects, shared sessions and saved result cards the
// page already holds. Pure ranking; the page decides what the index contains
// (only entries the directory showed it) and what Enter does.
(function (root) {
  const LIMIT = 12;
  const KINDS = Object.freeze({ person: 'Teammate', project: 'Project', session: 'Session', card: 'Result card' });
  const norm = s => String(s ?? '').toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Subsequence match with a bonus for prefix, word-start and contiguous runs.
  function score(hay, needle) {
    const h = norm(hay), n = norm(needle);
    if (!n) return 1;
    if (h === n) return 100;
    if (h.startsWith(n)) return 80 + n.length;
    const at = h.indexOf(n);
    if (at >= 0) return (h[at - 1] === ' ' || h[at - 1] === '/' ? 60 : 40) + n.length;
    let i = 0, run = 0, best = 0;
    for (const c of h) { if (c === n[i]) { i++; run++; best = Math.max(best, run); if (i === n.length) break; } else run = 0; }
    return i === n.length ? 10 + best : 0;
  }
  // index: [{kind, id, title, subtitle, keywords[]}]
  function search(index, query, limit = LIMIT) {
    const q = String(query ?? '').trim();
    const rows = [];
    for (const item of Array.isArray(index) ? index : []) {
      if (!item || !Object.hasOwn(KINDS, item.kind) || typeof item.title !== 'string') continue;
      const s = Math.max(score(item.title, q), ...(Array.isArray(item.keywords) ? item.keywords.map(k => score(k, q) * 0.8) : []), score(item.subtitle || '', q) * 0.6);
      if (s > 0) rows.push({ item, s });
    }
    const order = { session: 0, person: 1, project: 2, card: 3 };
    rows.sort((a, b) => b.s - a.s || order[a.item.kind] - order[b.item.kind] || a.item.title.localeCompare(b.item.title));
    return rows.slice(0, limit).map(r => r.item);
  }
  // Builds the index from directory entries; private sessions never reach the
  // directory, so they never reach here.
  function indexOf({ entries = [], cards = [] } = {}) {
    const out = [], people = new Map(), projects = new Map();
    for (const e of entries) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue;
      const who = e.owner?.self ? 'You' : e.owner?.name || 'Teammate';
      out.push({ kind: 'session', id: e.id, title: e.task?.source === 'unknown' ? `${e.provider?.label || 'AI'} session` : e.task?.title || 'Session', subtitle: [who, e.provider?.label, e.board?.label].filter(Boolean).join(' · '), keywords: [who, e.provider?.label || '', e.board?.label || '', e.state || ''] });
      if (e.owner?.name && !e.owner.self) people.set(e.owner.name, (people.get(e.owner.name) || 0) + 1);
      if (e.board?.label) projects.set(e.board.label, (projects.get(e.board.label) || 0) + 1);
    }
    for (const [name, n] of people) out.push({ kind: 'person', id: name, title: name, subtitle: `${n} shared session${n === 1 ? '' : 's'}`, keywords: [] });
    for (const [name, n] of projects) out.push({ kind: 'project', id: name, title: name, subtitle: `${n} session${n === 1 ? '' : 's'}`, keywords: [] });
    for (const c of Array.isArray(cards) ? cards : []) if (c && typeof c.handle === 'string' && typeof c.title === 'string') out.push({ kind: 'card', id: c.handle, title: c.title, subtitle: c.meta || 'Result card', keywords: [] });
    return out;
  }
  const api = { search, score, indexOf, KINDS, LIMIT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformPalette = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
