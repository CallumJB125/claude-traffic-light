'use strict';
// Main-only subscriber to each signed-in team hub's activity stream
// (GET /api/activity/v1/stream, SSE) while the app is open. Resumes from the
// last seq it saw (Last-Event-ID), reconnects with backoff, and drops a
// connection that goes quiet past two heartbeats. Everything from the hub is
// untrusted: only known event types and fields reach main, strings capped.

const { parseHub } = require('./activity-publisher');

const PATH = '/api/activity/v1/stream';
const TYPES = new Set(['record.upsert', 'record.end', 'collision']);
const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000, 60_000];
const QUIET_MS = 60_000;
const BUFFER_MAX = 256 * 1024;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const str = (v, max) => (typeof v === 'string' ? v.replace(HIDDEN, ' ').slice(0, max) : null);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const paths = (v) => (Array.isArray(v) ? v.slice(0, 50).map((p) => str(p, 300)).filter(Boolean) : []);

/** The fields of a hub event main may use, or null. */
function cleanEvent(type, data) {
  if (!TYPES.has(type) || !data || typeof data !== 'object') return null;
  const base = { seq: int(data.seq), type, team_id: str(data.team_id, 100), repo_id: str(data.repo_id, 100), created_at: str(data.created_at, 40) };
  if (base.seq == null) return null;
  if (type === 'collision') {
    return { ...base, path: str(data.path, 300), records: Array.isArray(data.records) ? data.records.slice(0, 2).map((r) => str(r, 300)) : [],
      people: Array.isArray(data.people) ? data.people.slice(0, 2).map((p) => str(p, 80) || 'Teammate') : [] };
  }
  const r = data.record && typeof data.record === 'object' ? data.record : {};
  return { ...base, record_id: str(data.record_id, 300), rev: int(data.rev), author: str(data.author, 80) || 'Teammate',
    record: { record_id: str(r.record_id, 300), adapter: str(r.adapter, 20), folder: str(r.folder, 120), title: str(r.title, 120), goal: str(r.goal, 400),
      summary: str(r.summary, 1500), status: str(r.status, 20), branch: str(r.branch, 200), updated_at: str(r.updated_at, 40),
      files: { edited: paths(r.files?.edited), read: paths(r.files?.read) }, handover: r.handover && typeof r.handover === 'object' ? { available: r.handover.available === true } : null } };
}

/** Split SSE text into complete blocks; returns [blocks, rest]. */
function splitBlocks(text) {
  const parts = text.replace(/\r\n?/g, '\n').split('\n\n');
  return [parts.slice(0, -1), parts.at(-1)];
}
function parseBlock(block) {
  const ev = { data: [] };
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const k = i < 0 ? line : line.slice(0, i);
    const v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (k === 'data') ev.data.push(v);
    else if (k === 'id' || k === 'event' || k === 'retry') ev[k] = v;
  }
  return ev;
}

/**
 * hubs(): [{origin, token: () => string}] for every signed-in team hub.
 * onEvent(origin, event) gets each cleaned event; subscribe() adds more listeners.
 */
function createActivityStream({ hubs, onEvent = () => {}, fetch = globalThis.fetch, now = Date.now, timers = { setTimeout, clearTimeout }, log = () => {}, quietMs = QUIET_MS } = {}) { // privacy-flow: team-activity
  if (typeof hubs !== 'function') throw new Error('activity stream needs hubs()');
  const conns = new Map(); // origin → {ctl, timer, quiet, cursor, failures, retryMs, state}
  const listeners = new Set([onEvent]);
  let running = false;

  const emit = (origin, ev) => { for (const fn of listeners) { try { fn(origin, ev); } catch { /* a listener never stops the stream */ } } };

  function retry(origin, c) {
    if (!running || conns.get(origin) !== c) return;
    const wait = Math.max(c.retryMs ?? 0, BACKOFF_MS[Math.min(c.failures, BACKOFF_MS.length - 1)]);
    c.failures++;
    c.state = 'waiting';
    c.timer = timers.setTimeout(() => { c.timer = null; connect(origin, c); }, wait);
    c.timer?.unref?.();
  }

  async function connect(origin, c) {
    if (!running || conns.get(origin) !== c) return;
    const hub = hubs().find((h) => h.origin === origin);
    const token = hub?.token?.();
    if (parseHub(origin) !== origin || typeof token !== 'string' || !token) { stopOne(origin); return; }
    c.ctl = new AbortController();
    const quiet = () => { if (c.quiet) timers.clearTimeout(c.quiet); c.quiet = timers.setTimeout(() => c.ctl?.abort(), quietMs); c.quiet?.unref?.(); };
    c.state = 'connecting';
    try {
      const headers = { authorization: `Bearer ${token}`, accept: 'text/event-stream', origin };
      if (c.cursor != null) headers['last-event-id'] = String(c.cursor);
      quiet();
      const res = await fetch(origin + PATH + (c.cursor == null ? '' : `?after=${c.cursor}`), { headers, redirect: 'error', signal: c.ctl.signal }); // privacy-flow: team-activity
      if (res.status === 401 || res.status === 403) { log(`activity stream refused (${res.status})`); stopOne(origin); return; }
      if (!res.ok || !/^text\/event-stream/.test(res.headers.get('content-type') ?? '')) throw new Error(`status ${res.status}`);
      c.state = 'open';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        quiet();
        buf += dec.decode(value, { stream: true });
        if (buf.length > BUFFER_MAX) throw new Error('event too large');
        const [blocks, rest] = splitBlocks(buf);
        buf = rest;
        for (const block of blocks) {
          const ev = parseBlock(block);
          if (ev.retry && /^\d{1,7}$/.test(ev.retry)) c.retryMs = Number(ev.retry);
          if (!ev.data.length) continue;
          let data = null;
          try { data = JSON.parse(ev.data.join('\n')); } catch { continue; }
          const clean = cleanEvent(ev.event, data);
          if (ev.id && /^\d{1,15}$/.test(ev.id)) c.cursor = Number(ev.id);
          c.failures = 0;
          if (clean) emit(origin, clean);
        }
      }
    } catch (e) {
      if (running && conns.get(origin) === c) log(`activity stream interrupted: ${String(e?.message ?? e).slice(0, 60)}`);
    } finally {
      if (c.quiet) timers.clearTimeout(c.quiet);
      c.quiet = null;
      c.ctl = null;
    }
    retry(origin, c);
  }

  function stopOne(origin) {
    const c = conns.get(origin);
    if (!c) return;
    conns.delete(origin);
    if (c.timer) timers.clearTimeout(c.timer);
    if (c.quiet) timers.clearTimeout(c.quiet);
    c.ctl?.abort();
  }

  /** Match connections to the current signed-in hubs. */
  function refresh() {
    if (!running) return;
    const want = new Set(hubs().map((h) => h.origin).filter((o) => typeof o === 'string'));
    for (const origin of [...conns.keys()]) if (!want.has(origin)) stopOne(origin);
    for (const origin of want) {
      if (conns.has(origin)) continue;
      const c = { cursor: null, failures: 0, retryMs: 0, state: 'connecting' };
      conns.set(origin, c);
      connect(origin, c);
    }
  }

  return {
    start() { if (running) return; running = true; refresh(); },
    refresh,
    stop() { running = false; for (const origin of [...conns.keys()]) stopOne(origin); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    state: () => [...conns].map(([origin, c]) => ({ origin, state: c.state, cursor: c.cursor })),
  };
}

module.exports = { createActivityStream, cleanEvent, parseBlock, splitBlocks };
