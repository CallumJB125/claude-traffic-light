'use strict';
// Home's "Stuck" and "Limit hit" cards, and the Usage page's Limits panel.
// Main hands in the live sessions, Burst's last detection and the Tasks
// snapshot; the page only ever gets opaque handles, never a session id or path.
// "Resume this at reset" queues a Task only after the person's click and the
// native confirmation; nothing here ever queues one on its own.

const crypto = require('node:crypto');
const path = require('node:path');
const Limits = require('./limit-resets.js');
const SessionHandover = require('./session-handover.js');
const { isRemote } = require('./remote-devices.js');

const MAX_CARDS = 5;
const TASK_TEXT_MAX = 20000;
const AIS = ['claude', 'codex', 'gemini'];
const project = (cwd) => (typeof cwd === 'string' && cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) || cwd : 'a session');
const mins = (ms) => Math.max(1, Math.round(ms / 60000));

// The handover a resumed task continues from: Plexiform's own doc for that session.
function docKey(s) { return SessionHandover.keyOf(SessionHandover.adapterOf(s.source), s.sessionId); }

// tasks: the tasks service (start, snapshot, registerFolder, create). Waits briefly for the supervisor.
async function queueResume({ tasks, doc, session, provider, resetAtMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 20 }) {
  if (!doc) return { ok: false, error: 'No handover has been written for this session yet, so there is nothing to continue from.' };
  tasks.start();
  for (let i = 0; i < tries && tasks.snapshot()?.conn?.status !== 'connected'; i += 1) await sleep(250);
  const folder = tasks.registerFolder(session.cwd);
  const r = await tasks.create({ text: SessionHandover.asPrompt(doc).slice(0, TASK_TEXT_MAX), folder: folder.handle, ai: AIS.includes(provider) ? provider : 'auto', surface: 'background', when: 'reset' }, { startAfter: resetAtMs });
  return r && r.ok ? { ok: true, id: r.id } : { ok: false, error: (r && r.text) || 'Tasks could not queue it. Open Tasks to see why.' };
}

// sessions(): live session rows; burst(): BurstIpc.snapshot().d; tasks(): tasks snapshot rows.
// jump(s), copyHandover(s) → {ok}, docFor(s) → markdown|null, confirm(info) → bool, resume({session, provider, resetAtMs, doc}) → {ok, id|error}.
function createHomeAlerts({ sessions = () => [], burst = () => null, tasks = () => [], jump, copyHandover, docFor, confirm, resume, now = Date.now, newHandle = () => crypto.randomUUID() }) {
  const handles = new Map(); // episode key -> handle
  const byHandle = new Map(); // handle -> card
  const dismissed = new Set();
  const queued = new Map(); // episode key -> reset time of the task it queued
  const handleOf = (key) => { if (!handles.has(key)) handles.set(key, newHandle()); return handles.get(key); };
  const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };

  function cards() {
    const t = now();
    const live = safe(sessions, []).filter((s) => s && typeof s.sessionId === 'string');
    const out = { stuck: [], limits: [] };
    const seen = new Set();
    for (const s of live) {
      if (!s.stuck || !Number.isFinite(s.stuck.sinceMs)) continue;
      const key = `stuck|${s.sessionId}|${s.updatedAt || ''}`;
      seen.add(key);
      if (dismissed.has(key)) continue;
      const remote = isRemote(s);
      out.stuck.push({ key, session: s, view: { title: `Stuck: ${project(s.cwd)} silent for ${mins(s.stuck.sinceMs)} min`, meta: [Limits.labelOf(Limits.providerOf(s.source)), s.stuck.tool ? `last tool ${s.stuck.tool}` : null, remote && s.deviceName ? `on ${s.deviceName}` : null].filter(Boolean).join(' · '), canOpen: !remote, canHand: !remote } });
    }
    const entries = Limits.collect({ burst: safe(burst, null), tasks: safe(tasks, []), sessions: live, now: t });
    const covered = new Set();
    for (const e of entries.filter((x) => x.source === 'session')) {
      const s = e.session, at = Limits.resetFor(entries, e.provider);
      covered.add(e.provider);
      const key = `limit|${s.sessionId}|${s.updatedAt || ''}`;
      seen.add(key);
      if (dismissed.has(key)) continue;
      const done = queued.get(key);
      const local = !isRemote(s) && typeof s.cwd === 'string' && path.isAbsolute(s.cwd);
      out.limits.push({ key, session: s, provider: e.provider, resetAtMs: at, view: {
        title: at !== null ? `Limit hit: resets at ${Limits.clock(at, t)}` : 'Limit hit: reset time not known',
        meta: `${e.label} · ${project(s.cwd)}${done ? ` · Resume queued for ${Limits.clock(done, t)}` : at === null ? ' · Plexiform shows the time when Burst or a paused task reports it' : ''}`,
        canResume: local && at !== null && !done,
      } });
    }
    for (const p of new Set(entries.filter((x) => x.source !== 'session' && !x.model).map((x) => x.provider))) {
      if (covered.has(p)) continue;
      const at = Limits.resetFor(entries, p);
      const src = entries.find((x) => x.provider === p && !x.model && x.resetAtMs === at) || entries.find((x) => x.provider === p && !x.model);
      const key = `limit|${p}|${at ?? ''}`;
      seen.add(key);
      if (dismissed.has(key)) continue;
      out.limits.push({ key, provider: p, resetAtMs: at, view: {
        title: at !== null ? `Limit hit: resets at ${Limits.clock(at, t)}` : 'Limit hit: reset time not known',
        meta: `${Limits.labelOf(p)} · ${src.source === 'burst' ? `reported by Claude Burst${src.why ? `: ${src.why}` : ''}` : 'a task is paused on it'}`,
        canResume: false,
      } });
    }
    out.stuck = out.stuck.slice(0, MAX_CARDS); out.limits = out.limits.slice(0, MAX_CARDS);
    const keep = new Set([...out.stuck, ...out.limits].map((c) => c.key));
    for (const k of [...handles.keys()]) if (!keep.has(k)) handles.delete(k);
    for (const k of [...dismissed]) if (!seen.has(k)) dismissed.delete(k);
    for (const k of [...queued.keys()]) if (!seen.has(k)) queued.delete(k);
    byHandle.clear();
    for (const c of [...out.stuck, ...out.limits]) byHandle.set(handleOf(c.key), c);
    return out;
  }

  function snapshot() {
    const c = cards();
    const view = (list) => list.map((x) => ({ handle: handleOf(x.key), ...x.view }));
    return { stuck: view(c.stuck), limits: view(c.limits) };
  }

  async function act(kind, action, handle) {
    if (typeof handle !== 'string') return { ok: false, error: 'That card has changed. Home refreshes in a moment.' };
    cards();
    const c = byHandle.get(handle);
    const isStuck = c && c.key.startsWith('stuck|');
    if (!c || (kind === 'stuck') !== isStuck || (kind !== 'stuck' && kind !== 'limit')) return { ok: false, error: 'That card has changed. Home refreshes in a moment.' };
    if (action === 'dismiss') { dismissed.add(c.key); return { ok: true }; }
    if (kind === 'stuck' && action === 'open') {
      if (!c.view.canOpen) return { ok: false, error: 'That session runs on another computer.' };
      try { await jump(c.session); return { ok: true }; } catch { return { ok: false, error: 'Plexiform could not bring that session forward.' }; }
    }
    if (kind === 'stuck' && action === 'handoff') {
      if (!c.view.canHand) return { ok: false, error: 'That session runs on another computer.' };
      const r = await copyHandover(c.session);
      return r && r.ok ? { ok: true, note: 'Copied its handover as a prompt. Paste it into Codex, Claude or another AI to carry on.' } : { ok: false, error: (r && r.error) || 'No handover could be built for this session.' };
    }
    if (kind === 'limit' && action === 'resume') {
      if (!c.view.canResume) return { ok: false, error: 'This one cannot be resumed at reset.' };
      const doc = await docFor(c.session);
      if (!doc) return { ok: false, error: 'No handover has been written for this session yet, so there is nothing to continue from.' };
      const ok = await confirm({ project: project(c.session.cwd), where: c.session.cwd, provider: Limits.labelOf(c.provider), at: Limits.clock(c.resetAtMs, now()) });
      if (!ok) return { ok: false, cancelled: true };
      const r = await resume({ session: c.session, provider: c.provider, resetAtMs: c.resetAtMs, doc });
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Tasks could not queue it.' };
      queued.set(c.key, c.resetAtMs);
      return { ok: true, note: `Queued in Tasks. It continues from the handover at ${Limits.clock(c.resetAtMs, now())}.` };
    }
    return { ok: false, error: 'Unknown action.' };
  }

  function limits() {
    const t = now();
    return Limits.panel(Limits.collect({ burst: safe(burst, null), tasks: safe(tasks, []), sessions: safe(sessions, []), now: t }), t);
  }

  return { snapshot, act, limits };
}

function register({ ipcMain, homeAllowed, usageAllowed, alerts }) {
  ipcMain.handle('home:alerts', (e) => (homeAllowed(e) ? alerts.snapshot() : null));
  ipcMain.handle('home:alert', (e, kind, action, handle) => (homeAllowed(e) ? alerts.act(kind, action, handle) : { ok: false, error: 'Not allowed.' }));
  ipcMain.handle('usage:limits', (e) => (usageAllowed(e) ? alerts.limits() : null));
}

// Main's one call. The confirmation is a native dialog with Cancel as the default, like Tasks' risky actions.
function wire({ ipcMain, dialog, clipboard, homeAllowed, usageAllowed, sessions, burst, tasksRows, tasksService, handoverText, jump, entitlements = require('./entitlements.js') }) {
  const Handoff = require('./handoff.js');
  const docFor = (s) => handoverText(docKey(s)) || null;
  const handoff = Handoff.create({ entitlements, clipboard, docFor: async (key) => handoverText(key) || null, adapters: {} });
  const alerts = createHomeAlerts({
    sessions, burst, tasks: tasksRows, jump, docFor,
    copyHandover: (s) => handoff.copy(docKey(s)),
    confirm: async (info) => (await dialog.showMessageBox({
      type: 'question', buttons: ['Cancel', 'Queue task'], defaultId: 0, cancelId: 0, noLink: true,
      message: 'Resume this at reset?',
      detail: [`Task: continue ${info.project} from its handover`, `Runs in: ${info.where}`, `Starts at ${info.at}, when ${info.provider}'s limit resets, under your own login on this Mac.`].join('\n'),
    })).response === 1,
    resume: ({ session, provider, resetAtMs, doc }) => queueResume({ tasks: tasksService(), doc, session, provider, resetAtMs }),
  });
  register({ ipcMain, homeAllowed, usageAllowed, alerts });
  return alerts;
}

module.exports = { createHomeAlerts, register, wire, queueResume, docKey };
