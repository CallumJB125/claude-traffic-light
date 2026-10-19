'use strict';

// The weekly digest's repo view: a two-or-three line overview in plain words,
// then one line per repo (sessions, work finished, tasks done, spend). Pure:
// callers pass work records (src/work-record.js), tasks (src/morning-report.js
// readTasks), usage turns and the "what shipped" sections already built by
// src/shipped-report.js; nothing is read here. The words come from templates,
// never from an AI call, so the same facts always give the same lines. Repo
// names are folder names only; they go through the digest's clean() too.

const path = require('node:path');
const Usage = require('../usage.js');
const ModelMix = require('./model-mix.js');

const DAYS = 7;
const LIST_MAX = 8;
const DONE_RECORD = new Set(['ended', 'review']);
const DONE_TASK = new Set(['done', 'in_review']);

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const dayKey = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const folderOf = (p) => { const s = String(p ?? '').replace(/[\\/]+$/, ''); return s ? path.basename(s) : ''; };
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

// → Map folder → {sessions, finished, tasks, usd, last}
function byRepo({ records = [], tasks = [], turns = [], now = Date.now() } = {}) {
  const from = dayKey(now) - (DAYS - 1) * 86400000;
  const repos = new Map();
  const at = (name) => { if (!repos.has(name)) repos.set(name, { sessions: 0, finished: 0, tasks: 0, usd: 0, last: 0 }); return repos.get(name); };
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.status !== 'string') continue;
    const t = Date.parse(r.updated_at) || 0;
    if (t < from || t > now) continue;
    const name = String(r.folder || '').trim();
    if (!name) continue;
    const row = at(name);
    row.sessions += 1;
    if (DONE_RECORD.has(r.status)) row.finished += 1;
    row.last = Math.max(row.last, t);
  }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !DONE_TASK.has(t.state)) continue;
    const since = Number(t.stateSince) || 0;
    if (since < from || since > now) continue;
    const name = folderOf(t.where);
    if (!name) continue;
    const row = at(name);
    row.tasks += 1;
    row.last = Math.max(row.last, since);
  }
  for (const u of Array.isArray(turns) ? turns : []) {
    if (!u || !Number.isFinite(u.ts) || u.ts < from || u.ts > now) continue;
    const cost = Usage.costOf(u);
    if (cost == null) continue;
    const name = folderOf(u.cwd);
    if (!name) continue;
    at(name).usd += cost;
  }
  for (const row of repos.values()) row.usd = Math.round(row.usd * 100) / 100;
  return repos;
}

// Two or three lines that say what the week was, from the counts alone.
function overview(repos, { prs = 0 } = {}) {
  const rows = [...repos.entries()].sort((a, b) => b[1].sessions - a[1].sessions || b[1].last - a[1].last || a[0].localeCompare(b[0]));
  if (!rows.length) return [];
  const sessions = rows.reduce((n, [, r]) => n + r.sessions, 0);
  const finished = rows.reduce((n, [, r]) => n + r.finished + r.tasks, 0);
  const usd = rows.reduce((n, [, r]) => n + r.usd, 0);
  const out = [];
  const top = rows[0];
  out.push(rows.length === 1
    ? `You worked in ${top[0]} this week, across ${plural(sessions, 'session')}.`
    : `You worked in ${plural(rows.length, 'repo')} this week, most in ${top[0]} (${plural(top[1].sessions, 'session')} of ${sessions}).`);
  const bits = [];
  bits.push(finished ? `${plural(finished, 'piece')} of work finished or ready for review` : 'nothing finished yet');
  if (prs) bits.push(`${plural(prs, 'pull request')} opened`);
  out.push(`${bits.join(' and ')}.`.replace(/^./, (c) => c.toUpperCase()));
  const spenders = rows.filter(([, r]) => r.usd > 0).sort((a, b) => b[1].usd - a[1].usd);
  if (spenders.length) out.push(spenders.length === 1 || spenders[0][1].usd >= usd * 0.6
    ? `Spend was ${money(usd)}, ${spenders.length === 1 ? 'all' : 'mostly'} on ${spenders[0][0]}.`
    : `Spend was ${money(usd)}, spread over ${list(spenders.slice(0, 3).map(([n]) => n))}.`);
  return out;
}

// → the digest's section shape: an overview first, then the per-repo lines. [] for an empty week.
function sections({ records = [], tasks = [], turns = [], now = Date.now(), prs = 0, clean = (v, max) => String(v ?? '').slice(0, max) } = {}) {
  const repos = byRepo({ records, tasks, turns, now });
  if (!repos.size) return [];
  const lines = overview(repos, { prs }).map((l) => clean(l, 240));
  const rows = [...repos.entries()].sort((a, b) => b[1].sessions - a[1].sessions || b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
  const items = rows.slice(0, LIST_MAX).map(([name, r]) => {
    const bits = [plural(r.sessions, 'session')];
    if (r.finished) bits.push(`${r.finished} finished`);
    if (r.tasks) bits.push(plural(r.tasks, 'task done', 'tasks done'));
    if (r.usd > 0) bits.push(money(r.usd));
    return clean(`${name}: ${bits.join(', ')}`, 200);
  });
  if (rows.length > items.length) items.push(`And ${rows.length - items.length} more.`);
  const out = [
    { id: 'week-overview', heading: 'Your week', summary: null, items: lines },
    { id: 'by-repo', heading: 'By repo', summary: null, items },
  ];
  const cost = whereItWent(repos, { turns, now });
  if (cost.length) out.push({ id: 'where-it-went', heading: 'Where the money went', summary: null, items: cost.map((l) => clean(l, 240)) });
  return out;
}

// The three projects that cost the most this week, and the one saving suggestion.
function whereItWent(repos, { turns = [], now = Date.now() } = {}) {
  const spenders = [...repos.entries()].filter(([, r]) => r.usd > 0).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0])).slice(0, 3);
  const out = [];
  if (spenders.length) {
    const total = [...repos.values()].reduce((n, r) => n + r.usd, 0);
    const named = spenders.map(([n, r]) => `${n} (${money(r.usd)})`);
    out.push(spenders.length === 1
      ? `All ${money(total)} went to ${named[0]}.`
      : `Most went to ${list(named)}, out of ${money(total)}.`);
  }
  const saving = ModelMix.savingLine(ModelMix.routineEstimate(turns, { from: dayKey(now) - (DAYS - 1) * 86400000, now }));
  if (saving) out.push(saving);
  return out;
}

module.exports = { sections, byRepo, overview, whereItWent };
