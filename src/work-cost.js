'use strict';
// What a piece of work cost: Claude Code turns (usage.js, priced at API list
// prices) joined to the card their session was captured as (work-capture's
// provider + session_id + task_id, with the work record's branch), and to the
// card's PR when the board knows one. Sessions with no card fall back to their
// project and the git branch Claude Code recorded for the session's folder.
// Local data only: nothing here reads the network or writes anywhere.
const Usage = require('../usage.js');
const { cleanTitle } = require('./title-clean.js');

const DAY_MS = 86400000;
const TOOLS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes' };
const BASIS = 'API-price equivalent: these tokens priced at API list prices. On a subscription this is not a bill.';
const TOP = 10;

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfMonth = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const prOf = (pr) => {
  const number = Number(pr?.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const url = typeof pr.url === 'string' && /^https:\/\/github\.com\/[^\s]+$/.test(pr.url) && pr.url.length <= 500 ? pr.url : null;
  return { number, url };
};

// Whole-session totals for one capture observation, cached per turns array:
// work-capture asks once per session per pass. Only Claude Code has
// transcripts priced here; other tools answer null.
const sessionIndex = new WeakMap();
function sessionSpend(turns, o) {
  if (!Array.isArray(turns) || o?.provider !== 'claude' || typeof o.session_id !== 'string') return null;
  let idx = sessionIndex.get(turns);
  if (!idx) {
    idx = new Map();
    for (const t of turns) {
      if (!t?.sessionId) continue;
      const s = idx.get(t.sessionId) || { usd: 0, unpriced: 0 };
      const c = Usage.costOf(t);
      if (c == null) s.unpriced += 1; else s.usd += c;
      idx.set(t.sessionId, s);
    }
    sessionIndex.set(turns, idx);
  }
  const s = idx.get(o.session_id);
  return s ? { cost_usd: r4(s.usd), unpriced: s.unpriced } : null;
}

const blank = () => ({ usd: 0, unpriced: 0 });

/**
 * turns: usage.js turns. tasks: work-capture costRows() ({provider, session_id,
 * task_id, card_id, title, repo, pr, last_seen}). records: work-capture
 * localRecords() (WorkRecords: branch, title). → {basis, week, month}, each
 * {label, from, to, total, byTool, top, items}.
 */
function attribute({ turns = [], tasks = [], records = [], now = Date.now() } = {}) {
  const windows = {
    week: { label: 'Last 7 days', from: startOfDay(now - 6 * DAY_MS), to: now },
    month: { label: new Date(now).toLocaleString('en-US', { month: 'long', year: 'numeric' }), from: startOfMonth(now), to: now },
  };
  const recordOf = new Map();
  for (const r of Array.isArray(records) ? records : []) if (r?.adapter && r.session_id) recordOf.set(`${r.adapter}:${r.session_id}`, r);
  const items = new Map();
  const item = (key, init) => {
    let it = items.get(key);
    if (!it) { it = { key, sessions: new Set(), week: blank(), month: blank(), priced: true, ...init }; items.set(key, it); }
    return it;
  };
  // One card can hold several sessions (a resumed or repeated task); one
  // session is counted on the first card it was captured as.
  const cardOfSession = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !TOOLS[t.provider] || typeof t.session_id !== 'string' || !t.card_id) continue;
    const sk = `${t.provider}:${t.session_id}`;
    if (cardOfSession.has(sk)) continue;
    const rec = recordOf.get(sk);
    const it = item(`card:${t.card_id}`, { kind: 'card', card_id: t.card_id, title: cleanTitle(str(rec?.title) || str(t.title), 200, 'Untitled card'), tool: t.provider, repo: str(t.repo, 300), branch: str(rec?.branch), pr: prOf(t.pr) });
    if (!it.pr) it.pr = prOf(t.pr);
    if (!it.branch) it.branch = str(rec?.branch);
    cardOfSession.set(sk, it);
    if (t.provider !== 'claude') {
      it.priced = false;
      it.sessions.add(sk);
      const seen = Number(t.last_seen);
      for (const [w, win] of Object.entries(windows)) if (Number.isFinite(seen) && seen >= win.from && seen <= win.to) it[w].seen = true;
    }
  }
  const earliest = Math.min(windows.week.from, windows.month.from);
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !(t.ts >= earliest) || t.ts > now) continue;
    const sk = `claude:${t.sessionId}`;
    let it = cardOfSession.get(sk);
    if (!it) {
      const project = str(t.project) || 'Unknown project', branch = str(t.branch);
      it = item(`branch:${project}\u0000${branch ?? ''}`, { kind: branch ? 'branch' : 'project', card_id: null, title: cleanTitle(branch ? `${project} · ${branch}` : project, 200), tool: 'claude', repo: null, branch, pr: null });
    }
    it.sessions.add(sk);
    const c = Usage.costOf(t);
    for (const [w, win] of Object.entries(windows)) {
      if (t.ts < win.from) continue;
      if (c == null) it[w].unpriced += 1; else it[w].usd += c;
      it[w].seen = true;
    }
  }
  const out = { basis: BASIS };
  for (const [w, win] of Object.entries(windows)) {
    const rows = [...items.values()].filter((it) => it[w].seen).map((it) => ({
      key: it.key, kind: it.kind, title: it.title, tool: it.tool, toolLabel: TOOLS[it.tool], repo: it.repo, branch: it.branch, pr: it.pr, card_id: it.card_id,
      sessions: it.sessions.size, usd: it.priced ? r4(it[w].usd) : null, unpriced: it[w].unpriced,
    })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.unpriced - a.unpriced || a.title.localeCompare(b.title));
    const tools = new Map();
    for (const r of rows) {
      const g = tools.get(r.tool) || { tool: r.tool, label: TOOLS[r.tool], usd: 0, unpriced: 0, items: 0, priced: r.usd != null };
      g.items += 1; g.unpriced += r.unpriced;
      if (r.usd != null) g.usd += r.usd;
      tools.set(r.tool, g);
    }
    const byTool = [...tools.values()].map((g) => ({ ...g, usd: g.priced ? r4(g.usd) : null })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    const total = rows.reduce((s, r) => ({ usd: s.usd + (r.usd ?? 0), unpriced: s.unpriced + r.unpriced }), blank());
    out[w] = {
      label: win.label, from: win.from, to: win.to,
      total: { usd: r4(total.usd), unpriced: total.unpriced, onCards: r4(rows.filter((r) => r.kind === 'card').reduce((s, r) => s + (r.usd ?? 0), 0)), unpricedTools: byTool.filter((g) => !g.priced).map((g) => g.label) },
      byTool, top: rows.slice(0, TOP), items: rows,
    };
  }
  return out;
}

const unpricedText = (n) => (n > 0 ? `${n.toLocaleString('en-US')} request${n === 1 ? '' : 's'} could not be priced` : '');

// Spreadsheet apps run a cell that starts with = + - @ (or a tab/CR) as a formula.
function cell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(report) {
  const head = ['window', 'kind', 'title', 'tool', 'repo', 'branch', 'pr_number', 'pr_url', 'card_id', 'sessions', 'cost_usd_api_equivalent', 'unpriced_requests'];
  const lines = [head.join(',')];
  for (const w of ['week', 'month']) {
    for (const r of report?.[w]?.items ?? []) {
      lines.push([report[w].label, r.kind, r.title, r.toolLabel, r.repo, r.branch, r.pr?.number, r.pr?.url, r.card_id, r.sessions, r.usd == null ? '' : r.usd.toFixed(4), r.unpriced].map(cell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { attribute, sessionSpend, toCsv, unpricedText, BASIS, TOOLS };
