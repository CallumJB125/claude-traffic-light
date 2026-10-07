// Command palette, pure parts: fuzzy scoring, the command and card items, and
// ranking. No DOM; app.js runs the `run` descriptor of the chosen item.
import { VIEWS } from './views.js';
import { CHIPS, isFiltering } from './filters.js';
import { COLUMN_LABEL, columnFor } from './view.js';

const SEP = /[\s\-_/.:·]/;

/**
 * Subsequence match of `query` in `text`, scored so the obvious hit wins:
 * word starts and runs of consecutive letters score high, long gaps cost a
 * little, and a shorter text beats a longer one. Returns {score, indices} (the
 * matched positions, for highlighting) or null when some letter is missing.
 */
export function fuzzyMatch(query, text) {
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, '');
  const t = String(text ?? '');
  const lt = t.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const m = q.length;
  const n = lt.length;
  if (m > n) return null;
  const bonus = (j) => (j === 0 ? 8 : SEP.test(lt[j - 1]) ? 6 : 0);
  // best[i][j]: best score with q[i] matched at text position j.
  const best = Array.from({ length: m }, () => new Array(n).fill(-Infinity));
  const from = Array.from({ length: m }, () => new Array(n).fill(-1));
  for (let i = 0; i < m; i++) {
    // gap = best earlier match at k <= j-2, less 0.1 per skipped letter.
    let gap = -Infinity;
    let gapK = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0) {
        if (gap > -Infinity) gap -= 0.1;
        if (j >= 2 && best[i - 1][j - 2] > gap) { gap = best[i - 1][j - 2]; gapK = j - 2; }
      }
      if (lt[j] !== q[i]) continue;
      const base = 1 + bonus(j);
      if (i === 0) { best[0][j] = base; continue; }
      let cand = gap;
      let k = gapK;
      if (j >= 1 && best[i - 1][j - 1] > -Infinity && best[i - 1][j - 1] + 5 > cand) { cand = best[i - 1][j - 1] + 5; k = j - 1; }
      if (cand > -Infinity) { best[i][j] = cand + base; from[i][j] = k; }
    }
  }
  let end = -1;
  let score = -Infinity;
  for (let j = 0; j < n; j++) if (best[m - 1][j] > score) { score = best[m - 1][j]; end = j; }
  if (end < 0) return null;
  const indices = new Array(m);
  for (let i = m - 1, j = end; i >= 0; i--) { indices[i] = j; j = from[i][j]; }
  if (lt === q) score += 20;
  else if (lt.startsWith(q)) score += 10;
  return { score: score - n * 0.01, indices };
}

export const fuzzyScore = (query, text) => fuzzyMatch(query, text)?.score ?? null;

// ── items ───────────────────────────────────────────────────────────────────

const GIVE = new Set(['give_to_claude', 'take_over_with_claude']);

function giveFor(e) {
  const a = e.face.actions.find((x) => GIVE.has(x));
  return a ? { id: e.view.id, mode: a === 'give_to_claude' ? 'dispatch' : 'redispatch' } : null;
}

const cmd = (id, title, run, extra = {}) => ({ id: `cmd:${id}`, kind: 'command', title, run, keywords: '', ...extra });

export function commandItems({ view, readOnly, filters, hasGive, showPlanner = false }) {
  const items = [];
  for (const v of VIEWS.filter((x) => !x.planner || showPlanner)) items.push(cmd(`view-${v.id}`, `Go to ${v.label}`, { type: 'view', view: v.id }, { hint: v.id === view ? 'current' : null, keywords: `switch view ${v.id}`, icon: v.icon }));
  items.push(cmd('search', 'Search all boards…', { type: 'scope-search' }, { keywords: 'project search comments handover artifacts', icon: 'search' }));
  items.push(cmd('workflows', 'Reusable workflows…', { type: 'workflows' }, { keywords: 'templates recipes delivery repeat steps', icon: 'queue' }));
  items.push(cmd('theme', 'Toggle theme', { type: 'theme-next' }, { keywords: 'dark light system appearance', icon: 'auto' }));
  if (!readOnly) items.push(cmd('new', 'New card', { type: 'new-card' }, { hint: 'n', keywords: 'create add', icon: 'plus' }));
  if (!readOnly && hasGive) items.push(cmd('give', 'Tackle with AI…', { type: 'scope-give' }, { keywords: 'dispatch run assign codex ai', icon: 'person' }));
  for (const c of CHIPS) items.push(cmd(`filter-${c.id}`, `Show only: ${c.label}`, { type: 'filter', chip: c.id }, { keywords: `filter ${c.id}`, icon: 'queue' }));
  if (isFiltering(filters)) items.push(cmd('filter-clear', 'Clear filters', { type: 'filter-clear' }, { hint: 'Esc', keywords: 'reset remove', icon: 'close' }));
  return items;
}

export function cardItems(entries) {
  return entries.map((e) => ({
    id: `card:${e.view.id}`, kind: 'card', title: `${e.view.key} ${e.view.title}`, keyLen: String(e.view.key).length,
    hint: e.face.label || COLUMN_LABEL[columnFor(e.view, e.face)], tone: e.face.tone, run: { type: 'open-card', id: e.view.id }, give: giveFor(e), keywords: '',
  }));
}

/** Cards you could hand to Claude right now (the "Tackle with AI…" second step). */
export function giveItems(entries) {
  return entries.map((e) => ({ e, give: giveFor(e) })).filter((x) => x.give).map(({ e, give }) => ({
    id: `give:${e.view.id}`, kind: 'card', title: `${e.view.key} ${e.view.title}`, keyLen: String(e.view.key).length,
    hint: give.mode === 'redispatch' ? 'take back' : 'give', tone: e.face.tone, run: { type: 'give', ...give }, give, keywords: '',
  }));
}

/**
 * Ranked results for a query. No query: the commands, then the cards that need
 * attention first. A query ranks commands and cards together; a key like
 * "bdl-12" outranks the same letters spread through a title.
 */
export function rankItems(items, query, { limit = 14 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, indices: [] }));
  const out = [];
  for (const item of items) {
    const hit = fuzzyMatch(q, item.title);
    const kw = item.keywords ? fuzzyMatch(q, item.keywords) : null;
    if (!hit && !kw) continue;
    const score = hit ? hit.score + (item.kind === 'card' && hit.indices[0] < (item.keyLen ?? 0) ? 4 : 0) : (kw.score - 6);
    out.push({ item, score, indices: hit?.indices ?? [] });
  }
  out.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
  return out.slice(0, limit).map(({ item, indices }) => ({ item, indices }));
}

const NEEDS = { red: 0, amber: 1 };

/** Everything the palette can show for the current board, in default order. */
export function paletteResults(dlg, { entries, view, readOnly, filters, showPlanner }) {
  if (dlg.scope === 'search') return (dlg.search?.results ?? []).map((hit) => ({ item: {
    id: hit.id, kind: 'search', title: `${hit.card.key} ${hit.card.title}`, hint: `${hit.board.name} · ${hit.kind}`,
    snippet: hit.snippet, run: { type: 'open-search', id: hit.card.id, boardId: hit.board.id, section: hit.section },
  }, indices: [] }));
  if (dlg.scope === 'give') return rankItems(giveItems(entries), dlg.query);
  const ordered = [...entries].sort((a, b) => (NEEDS[a.face.tone] ?? 2) - (NEEDS[b.face.tone] ?? 2));
  const hasGive = entries.some((e) => giveFor(e));
  const commands = commandItems({ view, readOnly, filters, hasGive, showPlanner });
  const cards = cardItems(ordered);
  // With nothing typed, show a short command list and the top cards, not 40 of each.
  if (!String(dlg.query ?? '').trim()) return [...commands.slice(0, 8), ...cards.slice(0, 4)].map((item) => ({ item, indices: [] }));
  return rankItems([...commands, ...cards], dlg.query);
}
