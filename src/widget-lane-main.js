'use strict';
// Main's side of the widget's notification lane and rings
// (src/widget-lane-view.js, src/widget-rings-view.js). It watches the alert
// sources main already holds — the live session rows (needs you, finished,
// stuck), the hub's collision alerts, the GitHub signals, teammates' look
// requests and the run budget notices — and sends the widget one
// `widget:lane-event` per new thing and `widget:rings` when a ring changes.
// No network, no disk: everything here is read from in-memory state.

const LaneView = require('./widget-lane-view.js');
const RingsView = require('./widget-rings-view.js');
const CollisionAlerts = require('./collision-alerts.js');

const POLL_MS = 2000;
const NEEDS_YOU = new Set(['permission-ask', 'limit-hit', 'idle-nudge', 'turn-failed']);
const FAILED_CI = new Set(['ci-failed', 'deploy-failed']);
const WORDS = {
  'permission-ask': 'needs your OK',
  'limit-hit': 'hit its usage limit',
  'idle-nudge': 'is waiting for you',
  'turn-failed': 'turn failed',
};
const MAX_REMEMBERED = 400;

const folder = (cwd) => {
  if (typeof cwd !== 'string' || !cwd) return 'a session';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
};
const safe = (fn, fallback) => { try { const v = typeof fn === 'function' ? fn() : fallback; return v ?? fallback; } catch { return fallback; } };
const ms = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : Number.isFinite(iso) ? iso : NaN; return Number.isFinite(t) ? t : null; };

// sources: { state() → aggregate state ({sessions, team, budget}), local(rows) → this Mac's rows,
//   collisions → {list()}, git → {active()}, spend() → spend snapshot, warnAt() → budget warn share }
// Pure enough to test: `observe(now)` diffs the sources against what was seen and returns the new lane events.
function createWatcher(sources = {}, { now = Date.now } = {}) {
  const seen = new Set();
  const remember = (k) => { seen.add(k); if (seen.size > MAX_REMEMBERED) seen.delete(seen.values().next().value); };
  const turns = new Map(); // sessionId -> workingSince ms of the turn in flight
  let durations = [];
  let seeded = false;
  let nextId = 0;

  function sessions() {
    const st = safe(sources.state, {}) || {};
    const rows = Array.isArray(st.sessions) ? st.sessions : [];
    const local = typeof sources.local === 'function' ? safe(() => sources.local(rows), rows) : rows;
    return { st, rows: (Array.isArray(local) ? local : []).filter((s) => s && typeof s.sessionId === 'string') };
  }

  function candidates(st, rows) {
    const out = [];
    for (const s of rows) {
      const name = folder(s.cwd);
      const since = s.signalSince || s.updatedAt || '';
      if (NEEDS_YOU.has(s.signal)) out.push({ key: `n|${s.sessionId}|${s.signal}|${since}`, kind: 'needs-you', sessionId: s.sessionId, text: `${name} ${WORDS[s.signal]}` });
      else if (s.signal === 'stop') out.push({ key: `f|${s.sessionId}|${since}`, kind: 'finished', sessionId: s.sessionId, text: `${name} finished` });
      if (s.stuck && Number.isFinite(s.stuck.sinceMs)) out.push({ key: `s|${s.sessionId}|${s.updatedAt || ''}`, kind: 'stuck', sessionId: s.sessionId, text: `${name} has gone quiet${s.stuck.tool ? ` (last tool ${s.stuck.tool})` : ''}` });
    }
    for (const c of safe(() => sources.collisions.list(), []) || []) {
      if (c && typeof c.key === 'string') out.push({ key: `c|${c.key}`, kind: 'collision', sessionId: c.mine && c.mine.session_id ? `collision:${c.mine.session_id}` : null, text: CollisionAlerts.text(c) });
    }
    for (const e of safe(() => sources.git.active(), []) || []) {
      if (!e || !FAILED_CI.has(e.signal) || e.restored || typeof e.id !== 'string') continue;
      const what = e.signal === 'deploy-failed' ? 'Deploy failed' : 'CI failed';
      out.push({ key: `g|${e.id}`, kind: 'ci-failed', sessionId: `ci:${e.repo || ''}:${e.branch || ''}`, text: `${what}${e.repo ? ` · ${e.repo}` : ''}${e.branch ? ` (${e.branch})` : ''}` });
    }
    const team = st.team && typeof st.team === 'object' ? st.team : null;
    for (const l of (team && Array.isArray(team.looks) ? team.looks : [])) {
      if (l && l.id != null && !l.handling) out.push({ key: `t|${l.id}`, kind: 'teammate', sessionId: `look:${l.id}`, text: `${l.from || 'A teammate'} asks you to look${l.question ? `: ${l.question}` : ''}` });
    }
    for (const n of (Array.isArray(st.budget) ? st.budget : [])) {
      if (n && typeof n.runId === 'string') out.push({ key: `b|${n.runId}`, kind: 'needs-you', sessionId: `run:${n.runId}`, text: n.text || 'A run reached its budget' });
    }
    return out;
  }

  // The turn ring follows the most recently started turn still working.
  function trackTurns(rows, t) {
    const working = new Map();
    for (const s of rows) {
      const started = ms(s.workingSince);
      if (started !== null && !NEEDS_YOU.has(s.signal) && s.signal !== 'stop' && s.signal !== 'idle') working.set(s.sessionId, started);
    }
    for (const [id, started] of turns) {
      if (working.get(id) === started) continue;
      durations = RingsView.recordTurn(durations, t - started);
      turns.delete(id);
    }
    for (const [id, started] of working) turns.set(id, started);
    let latest = null;
    for (const started of turns.values()) if (latest === null || started > latest) latest = started;
    return latest;
  }

  function observe() {
    const t = now();
    const { st, rows } = sessions();
    const startedAt = trackTurns(rows, t);
    const fresh = [];
    for (const c of candidates(st, rows)) {
      if (seen.has(c.key)) continue;
      remember(c.key);
      if (seeded) fresh.push({ id: `lane-${++nextId}`, kind: c.kind, sessionId: c.sessionId, text: c.text, at: t });
    }
    seeded = true;
    const spend = safe(sources.spend, null);
    const day = spend && spend.budget && spend.budget.day;
    const rings = RingsView.rings({
      turn: { startedAt, now: t, durations },
      spend: day ? { today: day.spent, budget: day.budget, warnAt: safe(sources.warnAt, 0.8) } : {},
    });
    return { events: fresh.map((e) => LaneView.normalize(e, t)).filter(Boolean), rings };
  }

  return { observe, durations: () => durations.slice() };
}

// Main's one call. send(channel, payload) reaches the widget window only.
// allowed(e) gates the snapshot handle to the widget's own webContents.
function install({ ipcMain, send, sources = {}, allowed = () => true, interval = POLL_MS, now = Date.now, setInterval: every = setInterval, clearInterval: stop = clearInterval } = {}) {
  const watcher = createWatcher(sources, { now });
  let lane = [];
  let ringsKey = null;
  let lastRings = RingsView.rings({});
  function tick() {
    let r;
    try { r = watcher.observe(); } catch (err) { console.warn('[widget-lane] observe failed:', err && err.message); return; }
    const t = now();
    for (const ev of r.events) {
      lane = LaneView.pushEvent(lane, ev, t);
      try { send('widget:lane-event', ev); } catch { /* the widget may be gone */ }
    }
    lastRings = r.rings;
    const key = JSON.stringify(r.rings);
    if (key !== ringsKey) {
      ringsKey = key;
      try { send('widget:rings', r.rings); } catch { /* the widget may be gone */ }
    }
  }
  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('widget:lane-state', (e) => (allowed(e) ? { lane: LaneView.laneModel(lane, { now: now() }), rings: lastRings } : null));
  }
  tick();
  const timer = every(tick, interval);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { tick, stop: () => stop(timer), lane: () => lane.slice(), rings: () => lastRings };
}

module.exports = { install, createWatcher, POLL_MS };
