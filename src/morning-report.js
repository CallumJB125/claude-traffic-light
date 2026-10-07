'use strict';

// Overnight queue, the Home side: what your queued tasks did while you were away.
// Reads the Tasks store (the same files the Tasks page is built from, never written here) and shows
// tasks finished since you last looked: branch, commits, diffstat, cost, pull request and any open question.
// It only reports on your own CLI runs, started under your own login on this Mac.

const fs = require('fs');
const path = require('path');

const FINISHED = new Set(['in_review', 'done', 'failed']);
const FIRST_LOOK_MS = 24 * 3600 * 1000;
const MAX_ITEMS = 20;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const text = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// The last snapshot per task wins; a torn or foreign line is skipped.
function readTasks(storeDir) {
  const file = path.join(storeDir, 'tasks.jsonl');
  let raw;
  try { if (fs.statSync(file).size > MAX_STORE_BYTES) return []; raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { const t = JSON.parse(line)?.task; if (t && typeof t.id === 'string' && typeof t.state === 'string') byId.set(t.id, t); } catch { /* torn line */ }
  }
  return [...byId.values()];
}

function item(t) {
  const ev = t.evidence || {}, ds = ev.diffStat || {};
  const ask = t.openAsk ? text(t.openAsk.text, 160) : t.openApprovals?.length ? text(t.openApprovals[0].inputSummary, 160) : null;
  return {
    id: text(t.id, 40), title: text(t.title, 120) || 'Task', state: t.state === 'failed' ? 'failed' : 'finished',
    branch: t.workInPlace ? null : text(t.branch, 160) || null, commits: num(ev.commits),
    files: num(ds.files), added: num(ds.added), removed: num(ds.removed),
    costUsd: num(ev.costUsd ?? t.cost?.usd), tests: text(ev.tests, 20) || null,
    pr: typeof t.pr?.url === 'string' ? text(t.pr.url, 300) : null, ask,
    summary: text(ev.summary, 240) || (t.state === 'failed' ? text(t.failReason, 240) : ''),
  };
}

// → null when nothing happened since `since`.
function build(tasks, since) {
  const done = tasks.filter((t) => FINISHED.has(t.state) && num(t.stateSince) > since).sort((a, b) => b.stateSince - a.stateSince);
  const waiting = tasks.filter((t) => !FINISHED.has(t.state) && t.state !== 'done' && (t.openAsk || t.openApprovals?.length));
  if (!done.length && !waiting.length) return null;
  const items = done.slice(0, MAX_ITEMS).map(item);
  return {
    since, count: done.length, items, more: Math.max(0, done.length - items.length),
    costUsd: items.reduce((s, i) => s + i.costUsd, 0),
    asks: waiting.slice(0, MAX_ITEMS).map((t) => ({ id: text(t.id, 40), title: text(t.title, 120) || 'Task', ask: text(t.openAsk?.text ?? t.openApprovals?.[0]?.inputSummary, 160) })),
  };
}

// Is there still work in the Tasks snapshot (main's sanitised rows)? Used to hold the Mac awake until the queue drains.
function queueActive(snap) {
  const rows = Array.isArray(snap?.tasks) ? snap.tasks : [];
  return rows.some((t) => ['queued', 'claimed', 'running', 'quiet'].includes(t.state)
    || (t.state === 'parked' && t.parkReason === 'limit' && /resumes then/.test(t.reason || '')));
}

function createMorningReport({ storeDir, seenFile, now = Date.now, allowed = () => true, read = readTasks }) {
  const loadSeen = () => { try { const v = JSON.parse(fs.readFileSync(seenFile, 'utf8')).at; return Number.isFinite(v) ? v : null; } catch { return null; } };
  return {
    state() {
      if (!allowed()) return null;
      const seen = loadSeen();
      return build(read(storeDir), seen ?? now() - FIRST_LOOK_MS);
    },
    markSeen() {
      try { fs.mkdirSync(path.dirname(seenFile), { recursive: true }); fs.writeFileSync(seenFile, JSON.stringify({ at: now() }), { mode: 0o600 }); return true; } catch { return false; }
    },
  };
}

let current = null;

// Paid-wiring contract: gated by queue.morningReport (Plus); free keeps run-at-reset only.
function register(ctx) {
  const { app, rootDir, entitlements } = ctx;
  const dev = !app.isPackaged && process.env.CLAUDE_TRAFFIC_LIGHT_TASKS_HOME;
  const dataDir = dev || path.join(app.getPath('userData'), 'tasks');
  current = createMorningReport({
    storeDir: path.join(dataDir, 'store'), seenFile: path.join(rootDir, 'morning-seen.json'),
    allowed: () => entitlements.has('queue.morningReport'),
  });
  return current;
}

module.exports = { register, createMorningReport, build, queueActive, readTasks, current: () => current };
