'use strict';

// The "what shipped" part of the weekly digest: work finished, pull requests,
// where the spend went and the busiest days, in plain words. Pure: callers pass
// work records (src/work-record.js), the cost report (src/work-cost.js
// attribute().week) and optionally open PRs by branch (src/branch-prs.js
// index()). No reading, no network. Titles are tag-stripped here, then go
// through the digest's clean() so nothing private reaches copied text.

const LIST_MAX = 6;
const DAYS = 7;
const PROVIDER = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', cursor: 'Cursor' };
const DONE = new Set(['ended', 'review']);

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

// Tool-injected wrappers like <command-message>…</command-message> are not part of what the work was.
function stripTags(value) {
  return String(value ?? '')
    .replace(/<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?[A-Za-z][\w:-]*(?:[\s/][^>]*)?>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const dayKey = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

function titleOf(r, clean) {
  const t = clean(stripTags(r.title), 100);
  if (t) return t;
  return [PROVIDER[r.adapter] || 'AI', r.folder ? `session in ${r.folder}` : 'session'].join(' ');
}

// → [{id, heading, summary, items}] in the digest's section shape, or [] when the week is empty.
function sections({ records = [], cost = null, prs = {}, now = Date.now(), clean = (v, max) => String(v ?? '').slice(0, max) } = {}) {
  const from = dayKey(now) - (DAYS - 1) * 86400000;
  const inWeek = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.status !== 'string') continue;
    const at = Date.parse(r.updated_at) || 0;
    if (at >= from && at <= now) inWeek.push({ r, at });
  }
  const done = inWeek.filter((x) => DONE.has(x.r.status)).sort((a, b) => b.at - a.at || titleOf(a.r, clean).localeCompare(titleOf(b.r, clean)));
  const out = [];

  if (done.length) {
    const items = done.slice(0, LIST_MAX).map((x) => titleOf(x.r, clean));
    if (done.length > items.length) items.push(`And ${done.length - items.length} more.`);
    out.push({ id: 'shipped', heading: 'Work done this week', summary: `${plural(done.length, 'piece')} of work finished or ready for review.`, items });
  }

  const found = new Map();
  for (const it of cost?.items ?? []) if (it?.pr?.number) found.set(it.pr.number, `PR #${it.pr.number}: ${clean(stripTags(it.title), 100)}`);
  for (const { r } of inWeek) {
    const pr = r.branch ? prs?.[r.branch] : null;
    if (pr?.number && !found.has(pr.number)) found.set(pr.number, `PR #${pr.number}: ${titleOf(r, clean)}`);
  }
  if (found.size) {
    const items = [...found.entries()].sort((a, b) => b[0] - a[0]).map((e) => e[1]);
    out.push({ id: 'prs', heading: 'Pull requests', summary: null, items: items.slice(0, LIST_MAX).concat(items.length > LIST_MAX ? [`And ${items.length - LIST_MAX} more.`] : []) });
  }

  const rows = (cost?.items ?? []).filter((it) => it && it.usd > 0).slice(0, 3);
  if (rows.length) {
    out.push({ id: 'spend-by-work', heading: 'Where the spend went', summary: null, items: rows.map((it) => `${clean(stripTags(it.title), 100)}: ${money(it.usd)}`) });
  }

  const perDay = new Map();
  for (const x of inWeek) perDay.set(dayKey(x.at), (perDay.get(dayKey(x.at)) || 0) + 1);
  const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 3);
  if (busiest.length) {
    out.push({ id: 'busiest', heading: 'Busiest days', summary: null, items: busiest.map(([d, n]) => `${new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}: ${plural(n, 'session')}`) });
  }
  return out;
}

module.exports = { sections, stripTags };
