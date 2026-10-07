'use strict';

// Burst's on-screen events (~/.config/claude-burst/notices.json) as Plexiform
// notifications, and its audit as a Health list. Local file reads only.
// notices.json is {"events":[{id, kind, severity: info|ok|warn|error, title, detail, at, ts,
// resolves, session, audit_only}]}, the last 20, newest last (Burst internal/notice/notice.go).
// An "ok" event carries resolves = the kind it clears; it never carries an id.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLL_MS = 3000;
// Events already this old when the file is first read are history, not news.
const FRESH_MS = 5 * 60000;
const SEEN_MAX = 200;

const noticesPath = (home = os.homedir()) => path.join(home, '.config', 'claude-burst', 'notices.json');

const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const SEVERITY = { ok: 'info', info: 'info', warn: 'warn', error: 'error' };

function stamp(e) {
  const at = Date.parse(e.at);
  if (Number.isFinite(at)) return at;
  return Number.isFinite(e.ts) ? e.ts * 1000 : 0;
}

function entry(e) {
  if (!e || typeof e !== 'object') return null;
  const title = text(e.title, 200);
  if (!title) return null;
  return {
    kind: text(e.kind, 40),
    severity: SEVERITY[e.severity] || 'info',
    title,
    detail: text(e.detail, 1000),
    at: stamp(e),
    session: text(e.session, 100),
  };
}

// notices.json -> [{ id, kind, severity: 'info'|'warn'|'error', title, detail, at, session, resolves, auditOnly }]
function normalizeNotices(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.events) ? raw.events : [];
  const out = [];
  for (const e of list.slice(-50)) {
    const n = entry(e);
    if (!n) continue;
    const id = text(e.id, 80);
    if (!id) continue;
    out.push({ id, ...n, resolves: text(e.resolves, 40), auditOnly: e.audit_only === true });
  }
  return out;
}

// GET /api/audit (scrubbed) -> [{ at, kind, severity, title, detail, source }] newest first, at most 50.
function normalizeAudit(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.events) ? raw.events : [];
  const out = [];
  for (const e of list) {
    const n = entry(e);
    if (n) out.push({ at: n.at, kind: n.kind, severity: n.severity, title: n.title, detail: n.detail, source: e.audit_only === true ? 'action' : 'alert' });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 50);
}

// A spend notice is Burst's own; once Plexiform has a budget of its own the two would double up.
const hasBudget = (cfg) => !!(cfg && (cfg.spendBudget || cfg.budget || cfg.budgets));

// onEvents([{ key: 'burst:'+id, title, body, severity, session }]) for new events; onResolve(key) closes one.
// config() is Plexiform's config (budgets, quiet hours); burst() returns the BurstIpc object (read('modStatus') etc.).
// active() is true while notices.json is being watched: main then skips the poll-diff events.
// isGhostty(sessionId), optional: whether that session runs in Ghostty, where Burst's band shows its own toast.
// Options: { file = noticesPath(), isMac, onEvents, onResolve, config, burst, isGhostty, now = Date.now, log, fsImpl }.
function createBurstNotices({ file = noticesPath(), isMac = process.platform === 'darwin', onEvents = () => {}, onResolve = () => {}, config = () => ({}), burst = () => null, isGhostty = null, now = Date.now, log = () => {}, fsImpl = fs } = {}) {
  const seen = new Set();
  const open = new Map(); // key -> kind, for what a later "resolves" may close
  let timer = null;
  let watcher = null;
  let sig = '';
  let first = true;
  let live = false;
  let busy = false;

  async function bandToasts() {
    try {
      const b = burst();
      const m = b && typeof b.read === 'function' ? await b.read('modStatus') : null;
      return !!(m && m.installed === true && m.toasts === true);
    } catch { return false; }
  }

  async function check() {
    if (!isMac || busy) return;
    busy = true;
    try { await scan(); } catch (e) { log('[burst] notices', e && e.code); } finally { busy = false; }
  }

  async function scan() {
    let st;
    try { st = fsImpl.statSync(file); } catch { live = false; sig = ''; return; }
    const next = `${st.mtimeMs}:${st.size}`;
    if (next === sig && live) return;
    let raw;
    try { raw = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return; }
    sig = next;
    live = true;
    const t = now();
    const fresh = [];
    for (const n of normalizeNotices(raw)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (first && t - n.at > FRESH_MS) continue;
      fresh.push(n);
    }
    first = false;
    if (seen.size > SEEN_MAX) for (const id of [...seen].slice(0, seen.size - SEEN_MAX)) seen.delete(id);

    const send = [];
    for (const n of fresh) {
      if (n.resolves) {
        for (const [key, kind] of [...open]) if (kind === n.resolves) { open.delete(key); onResolve(key); }
        continue;
      }
      if (n.auditOnly) continue;
      send.push(n);
    }
    if (!send.length) return;
    const budget = hasBudget(config());
    const toasts = send.some((n) => n.session) && isGhostty ? await bandToasts() : false;
    const events = [];
    for (const n of send) {
      if (n.kind === 'spend' && budget) continue;
      if (toasts && n.session && isGhostty(n.session)) continue;
      const key = `burst:${n.id}`;
      open.set(key, n.kind);
      events.push({ key, title: n.title, body: n.detail, severity: n.severity, session: n.session });
    }
    if (events.length) onEvents(events);
  }

  return {
    start() {
      if (!isMac || timer) return;
      check();
      timer = setInterval(check, POLL_MS);
      if (timer.unref) timer.unref();
      try {
        watcher = fsImpl.watch(path.dirname(file), { persistent: false }, (_ev, name) => { if (!name || name === path.basename(file)) check(); });
        watcher.on('error', () => {});
      } catch { watcher = null; }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (watcher) { try { watcher.close(); } catch { /* closed */ } }
      watcher = null;
    },
    check,
    active: () => live,
  };
}

module.exports = { createBurstNotices, normalizeNotices, normalizeAudit, noticesPath };
