'use strict';
// Recurring recipes: a recipe of yours (or a ready-made one) runs on a
// schedule as an ordinary task, through the same confirmation-free path as
// "Run tonight" once you have set it up. Schedules live in
// <data root>/recipes/schedules.json beside your recipes, by recipe id, with
// the folder it works in, when it next runs, a short run history and whether
// it is paused.
//
// The scheduler is deliberately simple and robust to a Mac that sleeps: one
// timer for the soonest run (capped at an hour, so a clock jump or a long
// sleep is noticed on wake), and a missed slot runs once when the Mac is next
// awake, never once per slot missed. A run that the spend guard holds (daily
// limit reached) is skipped with a note and the next slot is computed as usual.
// Schedules need the Plus overnight-queue feature (queue.windows); without it
// nothing is started and the page shows the usual teaser.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'schedules.json';
const KINDS = Object.freeze(['off', 'nightly', 'weekdays', 'weekly', 'hours']);
const HISTORY_MAX = 20;
const MAX_TIMER_MS = 60 * 60 * 1000;
const MIN_TIMER_MS = 5 * 1000;
const HOURS = Object.freeze([1, 2, 3, 4, 6, 8, 12]);
const DAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const RECIPE_ID = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');

// → a clean schedule or null. Times are local 'HH:MM'; weekly has a day 0..6 (Sunday = 0).
function normalize(s) {
  if (!isObject(s) || !KINDS.includes(s.kind)) return null;
  if (s.kind === 'off') return { kind: 'off' };
  if (s.kind === 'hours') return HOURS.includes(s.every) ? { kind: 'hours', every: s.every } : null;
  if (!(typeof s.time === 'string' && TIME.test(s.time))) return null;
  if (s.kind === 'weekly') return Number.isInteger(s.day) && s.day >= 0 && s.day <= 6 ? { kind: 'weekly', day: s.day, time: s.time } : null;
  return { kind: s.kind, time: s.time };
}

// The next local wall-clock time strictly after `from`. Built with the Date
// constructor from calendar parts, so a DST change moves the clock, not the slot.
function nextRun(schedule, from, { lastRun = null } = {}) {
  const s = normalize(schedule);
  if (!s || s.kind === 'off') return null;
  if (s.kind === 'hours') {
    const base = Number.isFinite(lastRun) && lastRun <= from ? lastRun : from;
    const step = s.every * 60 * 60 * 1000;
    let t = base + step;
    while (t <= from) t += step;
    return t;
  }
  const [, hh, mm] = TIME.exec(s.time);
  const d = new Date(from);
  for (let i = 0; i < 9; i++) {
    const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, Number(hh), Number(mm), 0, 0);
    const t = cand.getTime();
    if (t <= from) continue;
    const day = cand.getDay();
    if (s.kind === 'nightly') return t;
    if (s.kind === 'weekdays' && day >= 1 && day <= 5) return t;
    if (s.kind === 'weekly' && day === s.day) return t;
  }
  return null;
}

function describe(schedule) {
  const s = normalize(schedule);
  if (!s || s.kind === 'off') return 'Off';
  if (s.kind === 'nightly') return `Every night at ${s.time}`;
  if (s.kind === 'weekdays') return `Every weekday at ${s.time}`;
  if (s.kind === 'weekly') return `Every ${DAYS[s.day]} at ${s.time}`;
  return s.every === 1 ? 'Every hour while this Mac is awake' : `Every ${s.every} hours while this Mac is awake`;
}

// 'HH:MM' today, otherwise the short weekday in front; a far date gets the day and month.
function clock(atMs, now) {
  const d = new Date(atMs), n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  if (atMs - now < 6 * 24 * 60 * 60 * 1000) return `${DAYS[d.getDay()].slice(0, 3)} ${hm}`;
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })} ${hm}`;
}

function cleanEntry(e) {
  if (!isObject(e)) return null;
  const schedule = normalize(e.schedule);
  if (!schedule || schedule.kind === 'off' || typeof e.folder !== 'string' || !e.folder) return null;
  const hist = Array.isArray(e.history) ? e.history.filter((h) => isObject(h) && Number.isFinite(h.at) && ['started', 'skipped', 'failed'].includes(h.result)).slice(-HISTORY_MAX) : [];
  return {
    schedule, folder: e.folder,
    paused: e.paused === true, skipNext: e.skipNext === true,
    nextRunAtMs: Number.isFinite(e.nextRunAtMs) ? e.nextRunAtMs : null,
    lastRunAtMs: Number.isFinite(e.lastRunAtMs) ? e.lastRunAtMs : null,
    history: hist.map((h) => ({ at: h.at, result: h.result, note: typeof h.note === 'string' ? h.note.slice(0, 200) : '', taskId: typeof h.taskId === 'string' ? h.taskId.slice(0, 64) : null })),
  };
}

function createStore({ dataDir, fsApi = fs }) {
  const file = path.join(dataDir, FILE);
  function load() {
    let raw;
    try { raw = JSON.parse(fsApi.readFileSync(file, 'utf8')); } catch { return {}; }
    const out = {};
    if (!isObject(raw)) return out;
    for (const [id, e] of Object.entries(raw)) { const c = RECIPE_ID.test(id) ? cleanEntry(e) : null; if (c) out[id] = c; }
    return out;
  }
  function save(all) {
    fsApi.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fsApi.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fsApi.renameSync(tmp, file);
  }
  return { load, save, file };
}

// run(id, entry) → { ok, id?, code?, text?, error? } starts the recipe as a task now
// (recipes.js builds the draft; the spend guard answers BUDGET_HELD when the day's limit is hit).
// exists(id) → whether the recipe is still there. canSchedule() → the Plus feature.
function createScheduler({ store, run, exists = () => true, canSchedule = () => true, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, onChange = () => {} }) {
  let timer = null;
  let running = false;
  let stopped = false;

  const all = () => store.load();
  function write(all_) { store.save(all_); onChange(); }

  function set(id, schedule, folder) {
    if (!RECIPE_ID.test(String(id))) return { ok: false, error: 'That recipe is no longer available.' };
    const s = normalize(schedule);
    if (!s) return { ok: false, error: 'Choose a repeat and a time.' };
    const data = all();
    if (s.kind === 'off') { delete data[id]; write(data); arm(); return { ok: true, entry: null }; }
    if (!canSchedule()) return { ok: false, code: 'PLAN_REQUIRED', error: 'Repeating recipes are not part of your current plan.' };
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'Choose the folder it should work in first.' };
    const prev = data[id];
    const t = now();
    const entry = { schedule: s, folder, paused: false, skipNext: false, nextRunAtMs: nextRun(s, t), lastRunAtMs: prev?.lastRunAtMs ?? null, history: prev?.history ?? [] };
    data[id] = entry;
    write(data); arm();
    return { ok: true, entry: view(id, entry) };
  }
  function pause(id, on) {
    const data = all(); const e = data[id];
    if (!e) return { ok: false, error: 'That recipe has no schedule.' };
    e.paused = on === true;
    if (!e.paused) e.nextRunAtMs = nextRun(e.schedule, now(), { lastRun: e.lastRunAtMs });
    write(data); arm();
    return { ok: true, entry: view(id, e) };
  }
  function skipNext(id) {
    const data = all(); const e = data[id];
    if (!e) return { ok: false, error: 'That recipe has no schedule.' };
    const t = now();
    const next = e.nextRunAtMs ?? nextRun(e.schedule, t, { lastRun: e.lastRunAtMs });
    e.nextRunAtMs = next === null ? null : nextRun(e.schedule, next, { lastRun: next });
    e.skipNext = false;
    write(data); arm();
    return { ok: true, entry: view(id, e) };
  }
  function remove(id) { const data = all(); if (!data[id]) return { ok: true }; delete data[id]; write(data); arm(); return { ok: true }; }

  function view(id, e) {
    const t = now();
    return {
      id, schedule: e.schedule, label: describe(e.schedule), folder: e.folder, paused: e.paused,
      nextRunAtMs: e.paused ? null : e.nextRunAtMs,
      next: e.paused ? 'Paused' : e.nextRunAtMs === null ? 'No next run' : `Next run ${clock(e.nextRunAtMs, t)}`,
      lastRunAtMs: e.lastRunAtMs,
      history: e.history.slice(-5).reverse().map((h) => ({ ...h, when: clock(h.at, t) })),
    };
  }
  const list = () => Object.entries(all()).map(([id, e]) => view(id, e));
  // Runs inside a window, for the digest: [{ id, at, result, note }].
  const runsBetween = (from, to) => Object.entries(all()).flatMap(([id, e]) => e.history.filter((h) => h.at >= from && h.at <= to).map((h) => ({ id, ...h })));

  // Every due entry runs once, whatever number of slots passed while asleep.
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const t = now();
      const data = all();
      let changed = false;
      for (const [id, e] of Object.entries(data)) {
        if (e.paused || e.nextRunAtMs === null || e.nextRunAtMs > t) continue;
        changed = true;
        if (!exists(id)) { delete data[id]; continue; }
        let h;
        if (!canSchedule()) h = { at: t, result: 'skipped', note: 'Repeating recipes are not part of your current plan.', taskId: null };
        else {
          let r;
          try { r = await run(id, e); } catch (err) { r = { ok: false, error: err?.message || 'failed' }; }
          if (r && r.ok) h = { at: t, result: 'started', note: '', taskId: typeof r.id === 'string' ? r.id : null };
          else if (r && r.code === 'BUDGET_HELD') h = { at: t, result: 'skipped', note: `Skipped: ${r.text || r.error || 'the daily spend limit is reached.'}`.slice(0, 200), taskId: null };
          else h = { at: t, result: 'failed', note: String(r?.text || r?.error || 'It did not start.').slice(0, 200), taskId: null };
          log(`[recipes] scheduled ${id}: ${h.result}${h.note ? ` (${h.note})` : ''}`);
        }
        e.lastRunAtMs = t;
        e.history = [...e.history, h].slice(-HISTORY_MAX);
        e.nextRunAtMs = nextRun(e.schedule, t, { lastRun: t });
      }
      if (changed) write(data);
    } finally { running = false; }
    arm();
  }

  function arm() {
    if (stopped) return;
    if (timer) { clearTimer(timer); timer = null; }
    const t = now();
    const due = Object.values(all()).filter((e) => !e.paused && e.nextRunAtMs !== null).map((e) => e.nextRunAtMs);
    if (!due.length) return;
    const wait = Math.max(MIN_TIMER_MS, Math.min(MAX_TIMER_MS, Math.min(...due) - t));
    timer = setTimer(() => { timer = null; tick().catch((err) => log(`[recipes] tick: ${err?.message ?? err}`)); }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function start() { stopped = false; tick().catch(() => {}); }
  function stop() { stopped = true; if (timer) { clearTimer(timer); timer = null; } }
  // On wake: anything missed while asleep runs once, now.
  const wake = () => { tick().catch(() => {}); };

  return { set, pause, skipNext, remove, list, view: (id) => { const e = all()[id]; return e ? view(id, e) : null; }, runsBetween, tick, start, stop, wake, arm };
}

module.exports = { createStore, createScheduler, nextRun, normalize, describe, clock, KINDS, HOURS, DAYS, FILE, HISTORY_MAX };
