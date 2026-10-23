'use strict';
// Find agents search: pure, runs in the page over the slim catalogue list.
// Ranking reuses the command palette's score() (src/command-palette.js), and
// no regex is ever built from what the user types.
(function (root) {
  const Palette = typeof module === 'object' && module.exports ? require('./command-palette.js') : root.PlexiformPalette;
  const MAX_QUERY = 256, MAX_TERMS = 8, MAX_TERM = 64;
  // [field, weight, loose]. Only the name allows the palette's subsequence
  // match; elsewhere a term must be a real substring, or nearly every agent
  // would "match" any short word.
  const FIELDS = [['name', 1, true], ['slug', 0.8, false], ['facets', 0.8, false], ['oneLiner', 0.6, false], ['description', 0.5, false]];
  const SUBSTRING = 40;
  const norm = Palette.norm;

  function buildIndex(agents) {
    return (Array.isArray(agents) ? agents : []).map((a) => ({
      agent: a,
      name: norm(a.name), slug: norm(String(a.slug ?? '').replace(/[-_]/g, ' ')),
      facets: norm([a.category, ...(Array.isArray(a.tags) ? a.tags : [])].join(' ').replace(/[-_]/g, ' ')),
      oneLiner: norm(a.oneLiner), description: norm(a.description),
      nameKey: norm(a.name),
    }));
  }

  function terms(query) {
    return norm(String(query ?? '').slice(0, MAX_QUERY)).split(/\s+/).filter(Boolean).slice(0, MAX_TERMS).map((t) => t.slice(0, MAX_TERM));
  }

  function termScore(row, t) {
    let best = 0;
    for (const [f, w, loose] of FIELDS) {
      const s = Palette.scoreNorm(row[f], t);
      if (s && (loose || s >= SUBSTRING)) best = Math.max(best, s * w);
    }
    return best;
  }

  // filters: { category, source, tools: 'every'|'limited', works: platform id, only: Set<id> }.
  // Duplicates across sources show once (the catalogue's `primary`) unless a
  // source is picked, which lists that source's own copy.
  function passes(a, f) {
    if (f.category && a.category !== f.category) return false;
    if (f.source ? a.source !== f.source : a.primary === false) return false;
    if (f.tools === 'every' && !a.everyTool) return false;
    if (f.tools === 'limited' && a.everyTool) return false;
    if (f.works && !(Array.isArray(a.works) && a.works.includes(f.works))) return false;
    if (f.only && !f.only.has(a.id)) return false;
    return true;
  }

  function search(index, query, filters = {}) {
    const ts = terms(query);
    const out = [];
    for (const row of index) {
      if (!passes(row.agent, filters)) continue;
      let total = 0;
      for (const t of ts) { const s = termScore(row, t); if (!s) { total = -1; break; } total += s; }
      if (total >= 0) out.push({ row, total });
    }
    out.sort((x, y) => y.total - x.total || x.row.nameKey.localeCompare(y.row.nameKey) || (x.row.agent.id < y.row.agent.id ? -1 : 1));
    return out.map((r) => r.row.agent);
  }

  const api = Object.freeze({ buildIndex, search, terms, MAX_QUERY, MAX_TERMS });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformAgentSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
