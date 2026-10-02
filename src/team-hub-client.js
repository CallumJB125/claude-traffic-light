'use strict';
const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SHARED = 300, MAX_TEAMS = 64, MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_BODY = 1_000_000;
const DELIVERY_STATES = ['queued', 'sending', 'delivered', 'acknowledged', 'replied', 'refused', 'expired', 'unknown'];
const REASONS = {
  stale: 'This session is no longer shared with you.',
  forbidden: 'This session is not shared with you to send.',
  unavailable: 'The team hub did not accept the request just now.',
  unreadable: 'The team hub sent an unreadable answer.',
  invalid: 'Check the message and try again.',
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const failed = (status, reason) => ({ ok: false, status, reason });

function shareRow(x) {
  if (!object(x)) return null;
  const id = str(x.id, 100), session = str(x.session, 100);
  const scope = x.scope === 'interact' || x.scope === 'watch' ? x.scope : '';
  const team = object(x.team) ? { id: str(x.team.id, 100), name: str(x.team.name, 80) || 'Team' } : null;
  if (!UUID.test(id) || !UUID.test(session) || !scope || !team || !team.id) return null;
  return {
    ref: id, session, scope, team,
    expiresAt: typeof x.expires_at === 'string' && x.expires_at.length <= 60 ? x.expires_at : null,
    owner: { id, name: str(x.owner?.name, 80) || 'Teammate' },
    online: x.online === true,
  };
}

function createTeamHubClient({ baseUrl, token, fetch = globalThis.fetch } = {}, { pollMs = 5000, timeoutMs = 15_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/.{1,2000}$/.test(base)) throw new Error('a team hub client needs an http(s) baseUrl');
  if (typeof token !== 'function') throw new Error('a team hub client needs token as a function');
  if (typeof fetch !== 'function') throw new Error('a team hub client needs a fetch function');
  const pollEvery = Number.isSafeInteger(pollMs) && pollMs > 0 ? pollMs : 5000;
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000;
  let cache = [];

  const bearer = () => {
    const tok = token();
    if (typeof tok !== 'string' || !tok) throw new Error('no team hub token is current');
    return tok;
  };
  const json = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

  async function request(url, { method, body = undefined }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${bearer()}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const raw = await res.text();
      return { status: res.status, body: raw.length <= MAX_BODY ? json(raw) : null };
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

  const sharedCall = (shareId, requestId, op, args) =>
    request(`${base}/api/interaction/v1/shared/${encodeURIComponent(shareId)}/call`, { method: 'POST', body: { request_id: requestId, op, args } });

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
    id: str(d.id, 80), text: str(d.text, 4000), by: typeof d.by === 'string' && d.by ? str(d.by, 80) : null,
    state: DELIVERY_STATES.includes(d.state) ? d.state : 'unknown', response: str(d.response, 4000),
  } : null;

  async function teams(viewer) {
    const rows = await listShared();
    cache = rows;
    const out = [], seen = new Set();
    for (const row of rows) if (!seen.has(row.team.id) && out.length < MAX_TEAMS) { seen.add(row.team.id); out.push({ id: row.team.id, name: row.team.name }); }
    return out;
  }

  async function sessions(viewer, teamId) {
    if (typeof teamId !== 'string' || !teamId || teamId.length > 100) return [];
    const all = await listShared();
    cache = all;
    const out = [];
    for (const row of all.filter((r) => r.team.id === teamId)) {
      const entry = {
        ref: row.ref, team: { ...row.team }, owner: { ...row.owner },
        share: { explicit: true, scope: row.scope, expiresAt: row.expiresAt, revoked: false },
        provider: null, device: null, card: null, task_title: null, state: 'Unknown', input_needed: false,
        observed_at: null, self_reported: null, online: row.online, capabilities: {}, handoffs: [], children: [], deliveries: [],
      };
      try {
        const st = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session }));
        const s = st.ok && object(st.result.state) ? st.result.state : null;
        if (s) {
          const pid = str(s.provider?.id, 40);
          entry.provider = { id: pid || 'unknown', label: str(s.provider?.label, 120) || 'AI', kind: /^local-/.test(pid) ? 'local' : 'integrated' };
          entry.state = s.status === 'working' || s.status === 'compacting' ? 'working' : s.status === 'ended' ? 'ended' : s.status === 'ready' ? 'idle' : 'Unknown';
          entry.observed_at = Date.now();
          entry.capabilities = object(s.capabilities) ? { steer: s.capabilities.steer === true, interrupt: s.capabilities.interrupt === true } : {};
          entry.deliveries = (Array.isArray(s.deliveries) ? s.deliveries : []).slice(-10).map(deliveryOf).filter(Boolean);
        }
      } catch { /* the share row alone still lists the session */ }
      out.push(entry);
    }
    return out;
  }

  async function send(viewer, teamId, ref, text, requestId) {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message || message.includes('\0') || message.length > MAX_TEXT || Buffer.byteLength(message) > MAX_BYTES) return failed('invalid', REASONS.invalid);
    let row = cache.find((r) => r.ref === ref) ?? null;
    if (!row) {
      try { cache = await listShared(); } catch { cache = []; }
      row = cache.find((r) => r.ref === ref) ?? null;
    }
    if (!row) return failed('stale', REASONS.stale);
    if (typeof teamId === 'string' && teamId && row.team.id !== teamId) return failed('forbidden', REASONS.forbidden);
    if (row.scope !== 'interact') return failed('forbidden', 'This session is shared with you to watch only.');
    let st;
    try { st = hubResult(await sharedCall(row.ref, crypto.randomUUID(), 'state', { session: row.session })); } catch { st = failed('unavailable', REASONS.unavailable); }
    if (!st.ok) return st;
    const generation = object(st.result.state) && Number.isSafeInteger(st.result.state.generation) ? st.result.state.generation : null;
    if (generation === null) return failed('unavailable', REASONS.unreadable);
    const id = typeof requestId === 'string' && requestId ? requestId : crypto.randomUUID();
    let out;
    try { out = hubResult(await sharedCall(row.ref, id, 'send', { session: row.session, generation, text: message })); } catch { out = failed('unavailable', REASONS.unavailable); }
    if (!out.ok) return out;
    return { ok: true, status: 'queued', delivery: deliveryOf(out.result.delivery) };
  }

  const listeners = new Set();
  let scheduled = null, running = false, last = '';
  const fingerprint = (rows) => JSON.stringify(rows.map((r) => [r.ref, r.session, r.scope, r.expiresAt, r.team, r.owner.name, r.online]));
  async function poll() {
    running = true;
    try {
      const rows = await listShared();
      cache = rows;
      const fp = fingerprint(rows);
      if (fp !== last) {
        last = fp;
        for (const l of [...listeners]) { try { l(); } catch { /* a listener must never break the loop */ } }
      }
    } catch { /* unreachable or unreadable hub: try again on the next tick */ }
    running = false;
    if (listeners.size && !scheduled) scheduleNext();
  }
  const arm = (ms) => { const t = setTimeout(() => { scheduled = null; poll(); }, ms); t.unref?.(); return t; };
  function kick() {
    if (scheduled || running) return;
    scheduled = arm(0);
  }
  function onChange(fn) {
    if (typeof fn !== 'function') throw new Error('onChange needs a function');
    listeners.add(fn);
    kick();
    return () => {
      listeners.delete(fn);
      if (!listeners.size && scheduled) { clearTimeout(scheduled); scheduled = null; }
    };
  }
  function scheduleNext() { scheduled = arm(pollEvery); }

  return { teams, sessions, send, onChange };
}

module.exports = { createTeamHubClient };
