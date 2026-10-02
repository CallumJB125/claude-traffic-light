'use strict';
// Real team hub client for Overview "Team sessions" over the interaction hub's
// share endpoints. Every hub response is untrusted: rows are whitelisted,
// capped and stripped of control characters; failures map to a fixed reason
// table returned as both `error` and `reason`. The token is a function, re-read
// on every request, and never stored, logged or returned.
const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SHARED = 300, MAX_TEAMS = 64, MAX_PER_TEAM = 100, FANOUT = 6;
const MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_BODY = 1_000_000;
const POLL_MS = 5000, TIMEOUT_MS = 15_000, DEADLINE_MS = 20_000, BACKOFF_MAX_MS = 60_000;
const DELIVERY_STATES = Object.freeze(['queued', 'sending', 'delivered', 'acknowledged', 'replied', 'refused', 'expired', 'unknown']);
const REASONS = Object.freeze({
  stale: 'This session is no longer shared with you.',
  forbidden: 'This session is not shared with you to send.',
  unavailable: 'The team hub did not accept the request just now.',
  unreadable: 'The team hub sent an unreadable answer.',
  invalid: 'Check the message and try again.',
});
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LOOSE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? [...v.replace(HIDDEN, '')].slice(0, max).join('') : '');
const prose = (v, max) => (typeof v === 'string' ? [...v.replace(LOOSE, '')].slice(0, max).join('').replace(/\n{3,}/g, '\n\n') : '');
const failed = (status, reason) => ({ ok: false, status, reason, error: reason });
const bounded = (v, dflt) => (Number.isSafeInteger(v) && v > 0 ? v : dflt);

function parseBase(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('a team hub client needs an http(s) baseUrl');
  let u;
  try { u = new URL(raw); } catch { throw new Error('the team hub baseUrl is not a valid URL'); }
  const host = u.hostname.toLowerCase();
  const loop = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new Error('the team hub baseUrl must use https (http only for a loopback address)');
  if (u.username || u.password || u.search || u.hash) throw new Error('the team hub baseUrl must not carry credentials, a query or a fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function shareRow(x) {
  if (!object(x)) return null;
  const id = str(x.id, 100), session = str(x.session, 100);
  const scope = x.scope === 'interact' || x.scope === 'watch' ? x.scope : '';
  const team = object(x.team) ? { id: str(x.team.id, 100), name: str(x.team.name, 80) || 'Team' } : null;
  const ownerId = object(x.owner) && typeof x.owner.id === 'string' ? x.owner.id.trim() : '';
  if (!UUID.test(id) || !UUID.test(session) || !scope || !team || !team.id || !ownerId || ownerId.length > 100) return null;
  return {
    ref: id, session, scope, team,
    expiresAt: typeof x.expires_at === 'string' && x.expires_at.length <= 60 ? x.expires_at : null,
    owner: { id: ownerId, name: str(x.owner.name, 80) || 'Teammate' },
    online: x.online === true,
  };
}

function createTeamHubClient({ baseUrl, token, fetch = globalThis.fetch, viewer: viewerOpt = null, viewerId = null } = {}, { pollMs, timeoutMs, deadlineMs, now = Date.now } = {}) {
  const base = parseBase(baseUrl);
  if (typeof token !== 'function') throw new Error('a team hub client needs token as a function');
  if (typeof fetch !== 'function') throw new Error('a team hub client needs a fetch function');
  if (typeof now !== 'function') throw new Error('a team hub client needs now as a function');
  const every = bounded(pollMs, POLL_MS), timeout = bounded(timeoutMs, TIMEOUT_MS), span = bounded(deadlineMs, DEADLINE_MS);
  let cache = [];

  const atNow = () => { try { return now(); } catch { return Date.now(); } };
  const viewer = () => {
    if (object(viewerOpt) && typeof viewerOpt.id === 'string' && viewerOpt.id) return { id: viewerOpt.id.slice(0, 100), name: str(viewerOpt.name, 80) || 'You' };
    if (typeof viewerId === 'string' && viewerId) return { id: viewerId.slice(0, 100), name: 'You' };
    return null;
  };
  const json = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const bearer = () => {
    const tok = token();
    if (typeof tok !== 'string' || !tok) throw new Error('no team hub token is current');
    return tok;
  };

  async function request(url, { method, body = undefined, deadline = 0 }) {
    const ms = deadline ? Math.min(timeout, deadline - Date.now()) : timeout;
    if (!(ms > 0)) throw new Error('the team hub deadline passed');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method, redirect: 'error', signal: ctl.signal,
        headers: { authorization: `Bearer ${bearer()}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const len = Number(res.headers?.get?.('content-length'));
      if (Number.isSafeInteger(len) && len > MAX_BODY) return { status: res.status, body: null };
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader(), parts = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value?.byteLength ?? 0;
          if (bytes > MAX_BODY) { ctl.abort(); Promise.resolve(reader.cancel?.()).catch(() => {}); return { status: res.status, body: null }; }
          parts.push(chunk.value);
        }
        return { status: res.status, body: json(Buffer.concat(parts).toString('utf8')) };
      }
      const raw = await res.text();
      return { status: res.status, body: Buffer.byteLength(raw) <= MAX_BODY ? json(raw) : null };
    } finally { clearTimeout(timer); }
  }

  async function listShared() {
    const r = await request(`${base}/api/interaction/v1/shared`, { method: 'GET' });
    if (r.status !== 200 || !object(r.body) || !Array.isArray(r.body.shared)) throw new Error('the team hub shared list is unreadable');
    const out = [], seen = new Set();
    for (const x of r.body.shared.slice(0, MAX_SHARED)) {
      const row = shareRow(x);
      if (row && !seen.has(row.ref)) { seen.add(row.ref); out.push(row); }
    }
    return out;
  }

  const sharedCall = (shareId, requestId, op, args, deadline = 0) =>
    request(`${base}/api/interaction/v1/shared/${encodeURIComponent(shareId)}/call`, { method: 'POST', body: { request_id: requestId, op, args }, deadline });

  const mapStatus = (code) => (code === 404 || code === 410 ? 'stale' : code === 401 || code === 403 ? 'forbidden' : 'unavailable');
  const reasonFor = (status) => REASONS[status] ?? REASONS.unavailable;
  function hubResult(r) {
    if (!object(r) || typeof r.status !== 'number') return failed('unavailable', REASONS.unavailable);
    if (r.status !== 200) return failed(mapStatus(r.status), reasonFor(mapStatus(r.status)));
    const res = object(r.body) && object(r.body.result) ? r.body.result : null;
    if (!res) return failed('unavailable', REASONS.unreadable);
    if (res.ok !== true) {
      const status = res.status === 'stale' ? 'stale' : res.status === 'forbidden' ? 'forbidden' : 'unavailable';
      return failed(status, reasonFor(status));
    }
    return { ok: true, result: res };
  }

  const deliveryOf = (d) => object(d) && typeof d.id === 'string' && d.id ? {
    id: str(d.id, 80), text: prose(d.text, 4000), by: typeof d.by === 'string' && d.by ? str(d.by, 80) : null,
    state: DELIVERY_STATES.includes(d.state) ? d.state : 'unknown', response: prose(d.response, 4000),
  } : null;

  async function teams() {
    const rows = await listShared();
    cache = rows;
    const out = [], seen = new Set();
    for (const row of rows) if (!seen.has(row.team.id) && out.length < MAX_TEAMS) { seen.add(row.team.id); out.push({ id: row.team.id, name: row.team.name }); }
    return out;
  }

  const baseEntry = (row) => ({
    ref: row.ref, team: { ...row.team }, owner: { ...row.owner },
    share: { explicit: true, scope: row.scope, expiresAt: row.expiresAt, revoked: false },
    provider: null, device: null, card: null, task_title: null, state: 'Unknown', input_needed: false,
    observed_at: null, self_reported: null, online: row.online, capabilities: {}, handoffs: [], children: [], deliveries: [],
  });

  function applyState(entry, out, at) {
    const s = out.ok && object(out.result.state) ? out.result.state : null;
    if (!s) return;
    const pid = str(s.provider?.id, 40);
    entry.provider = { id: pid || 'unknown', label: str(s.provider?.label, 120) || 'AI', kind: /^local-/.test(pid) ? 'local' : 'integrated' };
    entry.state = s.status === 'working' || s.status === 'compacting' ? 'working' : s.status === 'ended' ? 'ended' : s.status === 'ready' ? 'idle' : 'Unknown';
    entry.capabilities = object(s.capabilities) ? { steer: s.capabilities.steer === true, interrupt: s.capabilities.interrupt === true } : {};
    entry.deliveries = (Array.isArray(s.deliveries) ? s.deliveries : []).slice(-10).map(deliveryOf).filter(Boolean);
    const t = typeof s.observed_at === 'number' ? s.observed_at : typeof s.updated_at === 'number' ? s.updated_at : NaN;
    entry.observed_at = Number.isFinite(t) && t >= 0 ? Math.min(Math.floor(t), at) : null;
  }

  async function sessions(viewerArg, teamId) {
    if (typeof teamId !== 'string' || !teamId || teamId.length > 100) return [];
    const all = await listShared();
    cache = all;
    const rows = all.filter((r) => r.team.id === teamId).slice(0, MAX_PER_TEAM);
    const deadline = Date.now() + span, out = rows.map(baseEntry);
    let next = 0, settled = false;
    const cut = new Promise((done) => { const t = setTimeout(done, Math.max(deadline - Date.now(), 0)); t.unref?.(); });
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (settled || i >= rows.length || Date.now() >= deadline) return;
        try { applyState(out[i], hubResult(await sharedCall(rows[i].ref, crypto.randomUUID(), 'state', { session: rows[i].session }, deadline)), atNow()); }
        catch { /* listed without state */ }
      }
    };
    await Promise.race([Promise.all(Array.from({ length: Math.min(FANOUT, rows.length) }, worker)), cut]);
    settled = true;
    return out;
  }

  async function send(viewerArg, teamId, ref, text, requestId) {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message || message.includes('\0') || message.length > MAX_TEXT || Buffer.byteLength(message) > MAX_BYTES) return failed('invalid', REASONS.invalid);
    if (typeof teamId !== 'string' || !teamId || teamId.length > 100) return failed('forbidden', REASONS.forbidden);
    let row = cache.find((r) => r.ref === ref) ?? null;
    if (!row) { try { cache = await listShared(); } catch { cache = []; } row = cache.find((r) => r.ref === ref) ?? null; }
    if (!row) return failed('stale', REASONS.stale);
    if (row.team.id !== teamId) return failed('forbidden', REASONS.forbidden);
    if (row.scope !== 'interact') return failed('forbidden', 'This session is shared with you to watch only.');
    let st;
    try { st = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session })); }
    catch { st = failed('unavailable', REASONS.unavailable); }
    if (!st.ok) return st;
    const generation = object(st.result.state) && Number.isSafeInteger(st.result.state.generation) ? st.result.state.generation : null;
    if (generation === null) return failed('unavailable', REASONS.unreadable);
    const rid = typeof requestId === 'string' && UUID.test(requestId) ? requestId : crypto.randomUUID();
    let out;
    try { out = hubResult(await sharedCall(row.ref, rid, 'send', { session: row.session, generation, text: message })); }
    catch { out = failed('unavailable', REASONS.unavailable); }
    if (!out.ok) return out;
    return { ok: true, status: 'queued', delivery: deliveryOf(out.result.delivery) };
  }

  const listeners = new Set();
  let scheduled = null, running = false, last = '', failures = 0;
  const fingerprint = (rows) => JSON.stringify(rows.map((r) => [r.ref, r.session, r.scope, r.expiresAt, r.team, r.owner.id, r.owner.name, r.online]));
  async function poll() {
    running = true;
    try {
      const rows = await listShared();
      cache = rows;
      failures = 0;
      const fp = fingerprint(rows);
      if (fp !== last) {
        last = fp;
        for (const l of [...listeners]) { try { l(); } catch { /* a listener must never break the loop */ } }
      }
    } catch { failures++; }
    running = false;
    if (listeners.size && !scheduled) scheduleNext();
  }
  const arm = (ms) => { const t = setTimeout(() => { scheduled = null; poll(); }, ms); t.unref?.(); return t; };
  const scheduleNext = () => { scheduled = arm(failures ? Math.min(BACKOFF_MAX_MS, every * 2 ** Math.min(failures, 20)) : every); };
  const kick = () => { if (!scheduled && !running) scheduled = arm(0); };
  function onChange(fn) {
    if (typeof fn !== 'function') throw new Error('onChange needs a function');
    listeners.add(fn);
    kick();
    return () => {
      listeners.delete(fn);
      if (!listeners.size && scheduled) { clearTimeout(scheduled); scheduled = null; }
    };
  }

  return { teams, sessions, send, onChange, viewer };
}

module.exports = { createTeamHubClient };
