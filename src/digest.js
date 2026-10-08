'use strict';

// The daily and weekly digest: what finished, what is stuck or waiting, spend
// against the day or week before, what Plexiform saved and the top waste
// finding. Built on this Mac from what other pages already read: the Tasks
// store (src/morning-report.js), work records (src/work-record.js), usage
// turns, and the cost guard report (src/receipt.js, src/waste.js).
// compose() is deterministic: the same facts and clock give the same words.
// Every line goes through clean(), so no prompt, file path, username or secret
// reaches text that can be copied, saved or posted. Session rows are named by
// tool, folder and branch only, never by their prompt-derived title.

const fs = require('fs');
const os = require('os');
const Usage = require('../usage.js');
const { cleanTitle } = require('./title-clean.js');
const { redactSecretsPass } = require('./scrub.js');
const { readTasks } = require('./morning-report.js');
const { finding } = require('../usage-waste-view.js');

const PERIODS = new Set(['day', 'week']);
const LIST_MAX = 8;
const RECORDS_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', cursor: 'Cursor' };

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const user = () => { try { return os.userInfo().username; } catch { return null; } };

const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clean(value, max = 160, { home = os.homedir(), username = user() } = {}) {
  let s = String(value ?? '').slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
  s = redactSecretsPass(s)
    .replace(/\b(?:https?|file):\/\/[^\s<>"'`]+/g, (m) => (m.startsWith('file:') ? 'a file' : 'a link'))
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>]*/g, 'a file')
    .replace(/(?<![\w.:/~-])~?\/(?!\/)[^\s"'`<>),;\]}]+/g, 'a file');
  if (home && home.length > 1) s = s.replace(new RegExp(escapeRe(home), 'g'), 'a file');
  if (username && username.length >= 3) s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(username)}(?![A-Za-z0-9])`, 'gi'), '[user]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function dayStart(now, offset = 0) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}
const windowOf = (period, now) => ({ from: dayStart(now, period === 'week' ? -6 : 0), to: now });

function spendOf(turns, period, now) {
  const today = dayStart(now), yesterday = dayStart(now, -1), week = dayStart(now, -6), lastWeek = dayStart(now, -13);
  const cur = period === 'week' ? week : today, prev = period === 'week' ? lastWeek : yesterday;
  const out = { current: 0, previous: 0, week: 0, unpriced: 0, turns: 0 };
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !Number.isFinite(t.ts) || t.ts > now || t.ts < lastWeek) continue;
    const cost = Usage.costOf(t);
    if (t.ts >= cur) { out.turns += 1; if (cost == null) out.unpriced += 1; }
    if (cost == null) continue;
    if (t.ts >= cur) out.current += cost;
    else if (t.ts >= prev) out.previous += cost;
    if (t.ts >= week) out.week += cost;
  }
  for (const k of ['current', 'previous', 'week']) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

function readRecords(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RECORDS_MAX_BYTES) return [];
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v?.records && typeof v.records === 'object' ? Object.values(v.records) : [];
  } catch { return []; }
}

const sessionName = (r) => [PROVIDER[r.adapter] || 'AI', r.folder ? `session in ${r.folder}` : 'session', r.branch ? `(branch ${r.branch})` : ''].filter(Boolean).join(' ');

// The facts for one period, already cleaned. Pure: callers pass what they read.
function gather({ period = 'day', now = Date.now(), tasks = [], records = [], turns = [], report = null, team = null, home, username } = {}) {
  const p = PERIODS.has(period) ? period : 'day';
  const { from } = windowOf(p, now);
  const c = (v, n) => clean(v, n, { home, username });
  const finished = [], stuck = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t.state !== 'string') continue;
    const since = num(t.stateSince), title = c(cleanTitle(t.title, 120, 'A task'), 120);
    const asks = t.openAsk || (Array.isArray(t.openApprovals) && t.openApprovals.length);
    if ((t.state === 'in_review' || t.state === 'done') && since >= from && since <= now) finished.push({ at: since, title, what: t.state === 'done' ? 'done' : 'ready for review' });
    else if (t.state === 'failed' && since >= from && since <= now) stuck.push({ at: since, title, why: 'failed' });
    else if (!['in_review', 'done', 'failed'].includes(t.state) && asks) stuck.push({ at: since, title, why: 'has a question for you' });
    else if (t.state === 'parked' && t.parkReason === 'limit') stuck.push({ at: since, title, why: 'paused at a usage limit' });
  }
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.status !== 'string') continue;
    const at = Date.parse(r.updated_at) || 0;
    if (at < from || at > now) continue;
    const title = c(sessionName(r), 160);
    if (r.status === 'review') finished.push({ at, title, what: 'ready for review' });
    else if (r.status === 'ended') finished.push({ at, title, what: 'finished' });
    else if (r.status === 'waiting') stuck.push({ at, title, why: 'waiting for you' });
    else if (r.status === 'paused_limit') stuck.push({ at, title, why: 'paused at a usage limit' });
  }
  const newest = (a, b) => b.at - a.at || a.title.localeCompare(b.title);
  finished.sort(newest); stuck.sort(newest);
  const receipt = report?.receipt;
  const waste = report?.waste;
  return {
    period: p, now,
    finished: finished.map(({ title, what }) => ({ title, what })),
    stuck: stuck.map(({ title, why }) => ({ title, why })),
    spend: spendOf(turns, p, now),
    saved: receipt && !receipt.teaser && typeof receipt.headline === 'string' ? c(receipt.headline, 200) : null,
    waste: waste && Array.isArray(waste.findings) && waste.findings.length ? c(finding(waste.findings[0]), 240) : null,
    team: typeof team === 'string' && team.trim() ? c(team, 600) : null,
  };
}

function change(cur, prev, word) {
  const d = Math.round((cur - prev) * 100) / 100;
  if (!prev && !cur) return `nothing ${word} either`;
  if (Math.abs(d) < 0.01) return `the same as ${word}`;
  return `${d > 0 ? 'up' : 'down'} ${money(Math.abs(d))} on ${word}`;
}

function listSection(id, heading, rows, line, none) {
  const items = rows.slice(0, LIST_MAX).map(line);
  if (rows.length > items.length) items.push(`And ${rows.length - items.length} more.`);
  return { id, heading, summary: rows.length ? null : none, items };
}

// → {period, title, sections:[{id, heading, summary, items}], team, text, markdown, slack}
function compose(data) {
  const d = data || {};
  const week = d.period === 'week';
  const date = new Date(d.now ?? 0).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const title = week ? `Your weekly digest, week to ${date}` : `Your daily digest, ${date}`;
  const finished = Array.isArray(d.finished) ? d.finished : [], stuck = Array.isArray(d.stuck) ? d.stuck : [];
  const s = d.spend || { current: 0, previous: 0, week: 0, unpriced: 0, turns: 0 };
  const span = week ? 'this week' : 'today';
  const sections = [];
  if (!finished.length && !stuck.length) sections.push({ id: 'quiet', heading: 'Overview', summary: week ? 'A quiet week: nothing finished and nothing is waiting on you.' : 'A quiet day: nothing finished and nothing is waiting on you.', items: [] });
  else {
    sections.push(listSection('finished', `Finished ${span}`, finished, (f) => `${f.title}: ${f.what}`, `Nothing finished ${span}.`));
    sections.push(listSection('stuck', 'Stuck or waiting', stuck, (x) => `${x.title}: ${x.why}`, 'Nothing is stuck or waiting on you.'));
  }
  const spend = [];
  if (!s.turns && !s.previous) spend.push(`No AI spend recorded ${span}.`);
  else if (week) spend.push(`${money(s.current)} this week, ${change(s.current, s.previous, 'last week')}.`);
  else spend.push(`${money(s.current)} today, ${change(s.current, s.previous, 'yesterday')}.`, `${money(s.week)} over the last 7 days.`);
  if (s.unpriced) spend.push(`${plural(s.unpriced, 'reply', 'replies')} from models without a known price ${s.unpriced === 1 ? 'is' : 'are'} not counted.`);
  sections.push({ id: 'spend', heading: 'Spend (at API list prices)', summary: null, items: spend });
  if (d.saved) sections.push({ id: 'saved', heading: 'Saved by Plexiform', summary: null, items: [d.saved] });
  if (d.waste) sections.push({ id: 'waste', heading: 'Top waste finding', summary: null, items: [d.waste] });
  const lines = (sec) => [sec.summary, ...sec.items].filter(Boolean);
  const text = [title, ...sections.map((sec) => [`${sec.heading}`, ...lines(sec).map((l) => `- ${l}`)].join('\n'))].join('\n\n');
  const markdown = [`# ${title}`, ...sections.map((sec) => [`## ${sec.heading}`, ...lines(sec).map((l) => `- ${l}`)].join('\n'))].join('\n\n') + '\n';
  const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const slack = [`*${esc(title)}*`, ...sections.map((sec) => [`*${esc(sec.heading)}*`, ...lines(sec).map((l) => `• ${esc(l)}`)].join('\n'))].join('\n\n');
  return { period: week ? 'week' : 'day', title, sections, team: d.team || null, text, markdown, slack };
}

// Reads the local sources and composes. report() and team() are optional and may be async.
function createDigest({ tasksStoreDir, recordsFile, turns = async () => [], report = async () => null, team = async () => null, now = Date.now, home = os.homedir(), username = user() }) {
  const safe = async (fn, ...a) => { try { return await fn(...a); } catch { return null; } };
  return {
    async build(period = 'day', { withTeam = false } = {}) {
      const t = now();
      const [allTurns, rep] = await Promise.all([safe(turns), safe(report)]);
      const brief = withTeam ? await safe(team, allTurns) : null;
      return compose(gather({ period, now: t, tasks: tasksStoreDir ? readTasks(tasksStoreDir) : [], records: recordsFile ? readRecords(recordsFile) : [], turns: allTurns || [], report: rep, team: brief, home, username }));
    },
  };
}

module.exports = { createDigest, gather, compose, clean, spendOf, readRecords, dayStart, windowOf, PERIODS };
