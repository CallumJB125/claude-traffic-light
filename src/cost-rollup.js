'use strict';
// Where the AI money went: priced Claude Code turns (usage.js) rolled up by
// project (cwd folder name), by git branch, by PR or board card (joined the
// way src/work-cost.js joins them), and by model, for today / 7d / 30d, with
// the previous period of the same length for a trend. Top N rows plus one
// "other" bucket. Pure: turns and capture rows in, numbers out. Paths, branch
// names and titles are user data and stay plain strings for textContent.
const Usage = require('../usage.js');
const { cleanTitle } = require('./title-clean.js');

const DAY_MS = 86400000;
const RANGES = { today: { days: 1, label: 'Today' }, '7d': { days: 7, label: 'Last 7 days' }, '30d': { days: 30, label: 'Last 30 days' } };
const DIMENSIONS = ['project', 'branch', 'pr', 'model'];
const TOP = 8;

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const folderOf = (t) => str(t.cwd ? String(t.cwd).split(/[\\/]/).filter(Boolean).pop() : null) || str(t.project) || 'Unknown project';
const familyOf = (k) => (k === 'fable-5' ? 'fable' : k);
const MODEL_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

// The window for a range and the one just before it, both whole local days
// (today is the window from midnight; its previous period is all of yesterday).
function windowsOf(range, now) {
  const r = RANGES[range] ? range : '7d';
  const { days, label } = RANGES[r];
  const from = startOfDay(now - (days - 1) * DAY_MS);
  const prevFrom = startOfDay(from - days * DAY_MS + DAY_MS / 2);
  return { range: r, label, days, from, to: now, prevFrom, prevTo: from };
}

// Claude sessions captured as board cards: session id → {key, label, pr}.
// A session counts on the first card it was captured as (src/work-cost.js).
function cardsOf(tasks, records) {
  const titleOf = new Map();
  for (const r of Array.isArray(records) ? records : []) if (r?.adapter === 'claude' && r.session_id) titleOf.set(r.session_id, str(r.title));
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.provider !== 'claude' || typeof t.session_id !== 'string' || !t.card_id || out.has(t.session_id)) continue;
    const n = Number(t.pr?.number);
    const pr = Number.isInteger(n) && n > 0 ? n : null;
    const title = cleanTitle(titleOf.get(t.session_id) || str(t.title), 200, 'Untitled card');
    out.set(t.session_id, pr
      ? { key: `pr:${str(t.repo, 300) || ''}#${pr}`, label: `PR #${pr} · ${title}`, pr, card: true }
      : { key: `card:${t.card_id}`, label: title, pr: null, card: true });
  }
  return out;
}

function keysOf(t, cards) {
  const project = folderOf(t);
  const branch = str(t.branch);
  const card = t.sessionId ? cards.get(t.sessionId) : null;
  const fam = familyOf(t.modelKey);
  return {
    project: { key: project, label: project },
    branch: { key: `${project}\u0000${branch ?? ''}`, label: branch ? `${project} · ${branch}` : `${project} · no branch` },
    pr: card || { key: 'none', label: 'No card or PR', none: true },
    model: { key: fam, label: MODEL_LABEL[fam] || fam },
  };
}

const change = (cur, prev) => (prev > 0 ? (cur - prev) / prev : null);

function topN(map, total, top) {
  const rows = [...map.values()].map((b) => ({ ...b, usd: r4(b.usd), prevUsd: r4(b.prevUsd), share: total > 0 ? b.usd / total : 0, change: change(b.usd, b.prevUsd) }))
    .filter((b) => b.usd > 0 || b.turns > 0)
    .sort((a, b) => b.usd - a.usd || b.turns - a.turns || String(a.label).localeCompare(String(b.label)));
  if (rows.length <= top) return rows;
  const head = rows.slice(0, top);
  const rest = rows.slice(top);
  const sum = (f) => rest.reduce((s, r) => s + r[f], 0);
  const usd = r4(sum('usd')), prevUsd = r4(sum('prevUsd'));
  head.push({ key: 'other', label: `${rest.length} other${rest.length === 1 ? '' : 's'}`, other: true, count: rest.length, usd, prevUsd, turns: sum('turns'), unpriced: sum('unpriced'), share: total > 0 ? usd / total : 0, change: change(usd, prevUsd) });
  return head;
}

/**
 * turns: usage.js turns. tasks/records: work-capture costRows()/localRecords().
 * → {range, label, from, to, prevFrom, total:{usd, prevUsd, change, turns, unpriced}, by:{project, branch, pr, model}}
 */
function rollup({ turns = [], tasks = [], records = [], range = '7d', now = Date.now(), top = TOP } = {}) {
  const w = windowsOf(range, now);
  const cards = cardsOf(tasks, records);
  const maps = Object.fromEntries(DIMENSIONS.map((d) => [d, new Map()]));
  const total = { usd: 0, prevUsd: 0, turns: 0, unpriced: 0 };
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !(t.ts >= w.prevFrom) || t.ts > now) continue;
    const cur = t.ts >= w.from;
    const c = Usage.costOf(t);
    if (cur) { total.turns += 1; if (c == null) total.unpriced += 1; else total.usd += c; } else if (c != null) total.prevUsd += c;
    const ks = keysOf(t, cards);
    for (const d of DIMENSIONS) {
      const k = ks[d];
      const m = maps[d];
      let b = m.get(k.key);
      if (!b) { b = { key: k.key, label: k.label, usd: 0, prevUsd: 0, turns: 0, unpriced: 0, ...(k.pr ? { pr: k.pr } : {}), ...(k.card ? { card: true } : {}), ...(k.none ? { none: true } : {}) }; m.set(k.key, b); }
      if (cur) { b.turns += 1; if (c == null) b.unpriced += 1; else b.usd += c; } else if (c != null) b.prevUsd += c;
    }
  }
  const by = {};
  for (const d of DIMENSIONS) by[d] = topN(maps[d], total.usd, Math.max(1, Number(top) || TOP));
  return { ...w, total: { usd: r4(total.usd), prevUsd: r4(total.prevUsd), change: change(total.usd, total.prevUsd), turns: total.turns, unpriced: total.unpriced }, by };
}

module.exports = { rollup, windowsOf, RANGES, DIMENSIONS, TOP };
