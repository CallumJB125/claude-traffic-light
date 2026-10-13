'use strict';
// Publishes this Mac's WorkRecords (src/work-record.js, docs/TEAM-CONTEXT-CONTRACT.md)
// to the team hub's activity log. Local-only by default: a record leaves only
// when its repo's route has share_summaries === true, and its file paths only
// with share_files === true too. Only the newest rev per record is kept; the
// queue is bounded and in memory, so offline time costs at most `queueMax`
// records and a restart re-offers whatever is current. The hub upserts by
// record_id + rev, so a resend after a lost answer is harmless.

const BATCH_MAX = 50;
const BATCH_BYTES = 200 * 1024;
const QUEUE_MAX = 500;
const SENT_MAX = 2000;
const DEBOUNCE_MS = 1000;
const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000, 120_000, 300_000];
const TIMEOUT_MS = 15_000;
const PATH = '/api/activity/v1/events';

function parseHub(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const loop = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.origin;
}

// The default transport: one JSON POST with this hub's own device token, https
// only (http for this computer), no redirects, bounded time.
function hubPoster({ token, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) { // privacy-flow: team-activity
  return async (hub, path, body) => {
    const origin = parseHub(hub);
    const bearer = origin && token(hub);
    if (!origin || typeof bearer !== 'string' || !bearer) return { ok: false, status: 0, reason: 'signed_out' };
    let res;
    try {
      res = await fetch(origin + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), // privacy-flow: team-activity
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json', origin }, body: JSON.stringify(body) });
    } catch { return { ok: false, status: 0, reason: 'offline' }; }
    const retryAfter = Number(res.headers.get('retry-after')) * 1000 || null;
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, body: json, retryAfter };
  };
}

/** The record as it may leave this Mac under `route`, or null when it may not. */
function shareable(record, route) {
  if (!route || route.share_summaries !== true || !record || record.v !== 1 || typeof record.record_id !== 'string' || record.repo_id !== route.repo_id) return null;
  const out = { ...record };
  if (route.share_files !== true) out.files = { edited: [], read: [] };
  return out;
}

function createActivityPublisher({ getRoutes, post, now = Date.now, timers = { setTimeout, clearTimeout }, log = () => {},
  queueMax = QUEUE_MAX, batchMax = BATCH_MAX, debounceMs = DEBOUNCE_MS } = {}) {
  if (typeof getRoutes !== 'function' || typeof post !== 'function') throw new Error('activity publisher needs getRoutes and post');
  const queue = new Map(); // record_id → {hub, record}
  const sent = new Map();  // record_id → highest rev the hub answered for (applied, stale or rejected)
  let timer = null, flushing = null, failures = 0, holdUntil = 0, stopped = false, dropped = 0;

  const remember = (id, rev) => {
    sent.delete(id); sent.set(id, rev);
    while (sent.size > SENT_MAX) sent.delete(sent.keys().next().value);
  };
  const schedule = (ms) => {
    if (stopped || timer) return;
    timer = timers.setTimeout(() => { timer = null; flush(); }, Math.max(0, ms));
    timer?.unref?.();
  };

  async function offer(records) {
    if (stopped || !Array.isArray(records) || !records.length) return;
    let catalog;
    try { catalog = await getRoutes(); } catch { return; }
    const routes = Array.isArray(catalog?.routes) ? catalog.routes : [];
    for (const raw of records) {
      const route = raw && routes.find((r) => r.repo_id === raw.repo_id && typeof r.hub === 'string');
      const record = shareable(raw, route);
      if (!record || !Number.isSafeInteger(record.rev)) continue;
      if ((sent.get(record.record_id) ?? -1) >= record.rev) continue;
      const queued = queue.get(record.record_id);
      if (queued && queued.record.rev >= record.rev) continue;
      queue.delete(record.record_id);
      queue.set(record.record_id, { hub: route.hub, record });
    }
    while (queue.size > queueMax) { queue.delete(queue.keys().next().value); dropped++; }
    if (queue.size) schedule(Math.max(debounceMs, holdUntil - now()));
  }

  function batches() {
    const groups = new Map();
    for (const [id, e] of queue) {
      const key = `${e.hub}\n${e.record.install_id}`;
      let list = groups.get(key);
      if (!list) groups.set(key, list = [[]]);
      let cur = list.at(-1);
      const size = Buffer.byteLength(JSON.stringify(e.record));
      if (cur.length >= batchMax || (cur.bytes ?? 0) + size > BATCH_BYTES) list.push(cur = []);
      cur.push(id); cur.bytes = (cur.bytes ?? 0) + size;
    }
    return [...groups].flatMap(([key, list]) => list.filter((b) => b.length).map((ids) => ({ hub: key.split('\n')[0], ids })));
  }

  async function send({ hub, ids }) {
    const entries = ids.map((id) => [id, queue.get(id)]).filter(([, e]) => e && e.hub === hub);
    if (!entries.length) return true;
    const records = entries.map(([, e]) => e.record);
    let res;
    try { res = await post(hub, PATH, { install_id: records[0].install_id, records }); } catch { res = { ok: false, status: 0 }; }
    if (res?.ok && Array.isArray(res.body?.results)) {
      for (const r of res.body.results) {
        const id = typeof r?.record_id === 'string' ? r.record_id : null;
        const sentRec = id && records.find((x) => x.record_id === id);
        if (!sentRec) continue;
        if (r.status === 'rejected') log(`activity record not accepted: ${String(r.reason ?? 'unknown').slice(0, 40)}`);
        remember(id, sentRec.rev);
        if (queue.get(id)?.record.rev === sentRec.rev) queue.delete(id);
      }
      return true;
    }
    // A refused request that will never pass as sent: drop it rather than retry forever.
    if ([400, 413].includes(res?.status)) {
      for (const [id, e] of entries) { remember(id, e.record.rev); if (queue.get(id) === e) queue.delete(id); }
      log(`activity batch refused (${res.status})`);
      return true;
    }
    if (res?.retryAfter) holdUntil = Math.max(holdUntil, now() + res.retryAfter);
    return false;
  }

  async function flush() {
    if (stopped) return;
    if (flushing) return flushing;
    if (now() < holdUntil) { schedule(holdUntil - now()); return; }
    flushing = (async () => {
      let ok = true;
      for (const b of batches()) {
        if (stopped) break;
        if (!(await send(b))) { ok = false; break; }
      }
      if (ok) failures = 0;
      else {
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        failures++;
        holdUntil = Math.max(holdUntil, now() + wait);
        log('activity publish deferred');
      }
    })().finally(() => {
      flushing = null;
      if (queue.size) schedule(Math.max(debounceMs, holdUntil - now()));
    });
    return flushing;
  }

  return {
    offer,
    flush,
    pending: () => queue.size,
    stats: () => ({ pending: queue.size, failures, dropped, hold_ms: Math.max(0, holdUntil - now()) }),
    stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; queue.clear(); },
  };
}

module.exports = { createActivityPublisher, hubPoster, shareable, parseHub, BATCH_MAX, QUEUE_MAX };
