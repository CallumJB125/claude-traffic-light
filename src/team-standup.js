'use strict';
// Auto standup from what teammates already share: per person, Yesterday
// (finished work and handovers), Today (in progress) and Blocked (stuck,
// waiting, or editing a file someone else is editing). Pure, plain words.
// Input is the activity records the desktop already reads (src/team-activity.js
// `record` shape) plus optional collision events; it never reads further.

const DAY = 24 * 3600_000;
const WINDOW = 2 * DAY; // "Yesterday" covers the last two days so a morning standup still sees last afternoon's work
const LIMITS = Object.freeze({ people: 12, items: 4 });
const ACTIVE = new Set(['working', 'waiting']);
const time = (iso) => Date.parse(iso || '') || 0;
const quote = (t) => `"${t}"`;

// records: [{record_id, author, title, status, updated_at, handover, handoff_requested, files:{edited}}]
// collisions: [{path, records:[record_id]}] (optional). → [{author, yesterday, today, blocked}]
function standup(records, { collisions = [], now = Date.now() } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r.author === 'string' && r.author);
  const editors = new Map(); // path -> Set(author) among active sessions
  for (const r of list) if (ACTIVE.has(r.status)) for (const p of r.files?.edited || []) { const s = editors.get(p) || new Set(); s.add(r.author); editors.set(p, s); }
  const byId = new Map(list.map((r) => [r.record_id, r]));
  const clash = new Map(); // author -> Set(path)
  const add = (a, p) => { const s = clash.get(a) || new Set(); s.add(p); clash.set(a, s); };
  for (const [p, who] of editors) if (who.size >= 2) for (const a of who) add(a, p);
  for (const c of Array.isArray(collisions) ? collisions : []) {
    const who = new Set((c?.records || []).map((id) => byId.get(id)?.author).filter(Boolean));
    if (who.size >= 2 && typeof c.path === 'string') for (const a of who) add(a, c.path);
  }

  const people = new Map();
  const person = (a) => { if (!people.has(a)) people.set(a, { author: a, yesterday: [], today: [], blocked: [], at: 0 }); return people.get(a); };
  for (const r of list) {
    const p = person(r.author);
    const at = time(r.updated_at);
    p.at = Math.max(p.at, at);
    const recent = at && now - at <= WINDOW;
    if (r.handoff_requested && recent) p.yesterday.push(`Handed ${quote(r.title)} to the team`);
    else if (r.status === 'ended' && recent) p.yesterday.push(`Finished ${quote(r.title)}${r.handover ? ' and left a handover' : ''}`);
    else if (r.status === 'review' && recent) p.yesterday.push(`Got ${quote(r.title)} ready for review`);
    if (r.status === 'working') p.today.push(`Working on ${quote(r.title)}`);
    if (r.status === 'waiting') { p.today.push(`On ${quote(r.title)}`); p.blocked.push(`${quote(r.title)} is waiting for an answer`); }
    if (r.status === 'paused_limit') p.blocked.push(`${quote(r.title)} is paused at a usage limit`);
  }
  for (const [a, paths] of clash) if (people.has(a)) {
    const files = [...paths].sort();
    people.get(a).blocked.push(`Editing ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''} alongside someone else`);
  }
  const cap = (xs) => xs.slice(0, LIMITS.items);
  return [...people.values()]
    .filter((p) => p.yesterday.length || p.today.length || p.blocked.length)
    .sort((x, y) => y.at - x.at || x.author.localeCompare(y.author))
    .slice(0, LIMITS.people)
    .map((p) => ({ author: p.author, yesterday: cap(p.yesterday), today: cap(p.today), blocked: cap(p.blocked) }));
}

// Plain text for the Copy button.
function toText(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'Standup: nothing shared by the team in the last two days.';
  const part = (label, xs, none) => `  ${label}: ${xs.length ? xs.join('; ') : none}`;
  return rows.map((p) => [p.author, part('Yesterday', p.yesterday, 'nothing shared'), part('Today', p.today, 'nothing shared'), part('Blocked', p.blocked, 'nothing')].join('\n')).join('\n\n');
}

module.exports = { standup, toText, LIMITS };
