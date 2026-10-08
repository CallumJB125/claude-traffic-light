// Outbound webhooks (docs/PUBLIC-API.md, migration 069). A team admin
// registers an https endpoint and the event types it wants; the hub POSTs each
// event as JSON signed with HMAC-SHA256 under a secret shown once.
//
// Events come from the journal through the bus (at-least-once): the consumer
// only writes delivery rows (idempotent on endpoint, journal row and type), and
// a separate sender works through them so a slow receiver never holds the bus.
// Each attempt resolves the host again and connects to the vetted address
// (ssrf.js), never follows a redirect and gives up after 5 s. A delivery that
// fails 6 times disables its endpoint, with an audit row. Payloads carry ids
// and titles; card and comment text only when the admin ticked include_text.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net'; // privacy-flow: hub-outbound-webhooks
import { request as httpRequest } from 'node:http'; // privacy-flow: hub-outbound-webhooks
import { request as httpsRequest } from 'node:https'; // privacy-flow: hub-outbound-webhooks
import { HubError } from '../db.js';
import { columnOf } from '../../shared/states.js';
import { limitOrThrow } from '../ratelimit.js';
import { vetEndpoint } from './ssrf.js';

export const EVENT_TYPES = Object.freeze(['card.created', 'card.moved', 'card.commented', 'run.finished', 'review.requested']);
export const TEST_EVENT = 'webhook.test';
export const MAX_ATTEMPTS = 6;
// Waits before attempts 2..6 (about 2 h 36 min in all).
export const BACKOFF_MS = Object.freeze([10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000]);
export const TIMEOUT_MS = 5_000;
export const LOG_KEEP = 50;
export const MAX_ENDPOINTS_PER_TEAM = 10;
const MAX_PENDING_PER_ENDPOINT = 500;
const SEND_BATCH = 16;
const TICK_MS = 5_000;
const SECRET_KIND = 'webhook_secret';
const KINDS = ['card.create', 'card.transition', 'card.update', 'comment.create', 'card_review.request'];

const bad = (message) => new HubError('VALIDATION', message);

/** The signature header value for a body sent at `timestamp` (unix seconds). */
export function signature(secret, timestamp, body) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export const publicEndpoint = (r) => ({
  id: r.id, url: r.url, events: json(r.events, []), include_text: !!r.include_text, created_at: r.created_at, updated_at: r.updated_at,
  enabled: !r.disabled_at, disabled_at: r.disabled_at ?? null, disabled_reason: r.disabled_reason ?? null,
});

export const publicDelivery = (r) => ({
  id: r.id, event_type: r.event_type, state: r.state, attempts: r.attempts, status: r.last_status ?? null, error: r.last_error ?? null,
  latency_ms: r.latency_ms ?? null, created_at: r.created_at, updated_at: r.updated_at,
  next_attempt_at: r.state === 'pending' && r.next_at_ms != null ? new Date(r.next_at_ms).toISOString() : null,
});

export class Webhooks {
  constructor(hub, { bus = null, allowHttp = false, allowPrivate = false, timeoutMs = TIMEOUT_MS, lookup } = {}) {
    this.hub = hub;
    this.db = hub.db;
    this.opts = { allowHttp, allowPrivate, ...(lookup ? { lookup } : {}) };
    this.timeoutMs = timeoutMs;
    this.running = null;
    this.timer = null;
    this.started = false;
    if (bus) bus.subscribe('public-webhooks', (row) => this.onJournal(row), { kinds: KINDS });
  }

  // ── management (team admins) ────────────────────────────────────────────

  endpoint(member, id) {
    const r = this.db.get('SELECT * FROM webhook_endpoints WHERE id = ? AND org_id = ? AND deleted_at IS NULL', id, member.org_id);
    if (!r) throw new HubError('NOT_FOUND', 'no such webhook endpoint');
    return r;
  }

  audit(action, { member = null, orgId, target, detail = null, ip = null }) {
    if (member) this.hub.accounts.audit(action, { user: member.user_id ?? null, org: member.org_id, target, detail, ip });
    else this.db.insert('audit', { actor: 'system', action, target, detail: detail ? JSON.stringify(detail) : null, at: this.hub.iso(), org_id: orgId });
  }

  events(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.some((e) => !EVENT_TYPES.includes(e))) throw bad(`events must be a non-empty list of: ${EVENT_TYPES.join(', ')}`);
    return [...new Set(raw)];
  }

  list(member) {
    return { event_types: EVENT_TYPES, endpoints: this.db.all('SELECT * FROM webhook_endpoints WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at, id', member.org_id).map(publicEndpoint) };
  }

  /** POST {url, events, include_text?} → {endpoint, secret}: the secret is never shown again. */
  async create(member, body, { ip, recheck = null }) {
    const events = this.events(body.events);
    if (body.include_text != null && typeof body.include_text !== 'boolean') throw bad('include_text must be true or false');
    if (!this.hub.vault.available) throw new HubError('POLICY_DENIED', 'webhooks need an encryption key (BOARD_ENC_KEY) on this hub');
    const n = this.db.get('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE org_id = ? AND deleted_at IS NULL', member.org_id).n;
    if (n >= MAX_ENDPOINTS_PER_TEAM) throw new HubError('QUOTA_EXCEEDED', `at most ${MAX_ENDPOINTS_PER_TEAM} webhook endpoints per team`, { resource: 'webhook_endpoints', limit: MAX_ENDPOINTS_PER_TEAM });
    const target = await vetEndpoint(body.url, this.opts);
    if (recheck) member = recheck();
    const id = randomUUID();
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const sealed = this.hub.vault.seal(id, SECRET_KIND, secret);
    const now = this.hub.iso();
    const row = {
      id, org_id: member.org_id, url: target.url.href, events: JSON.stringify(events), include_text: body.include_text === true ? 1 : 0,
      key_id: sealed.key_id, nonce: sealed.nonce, ciphertext: sealed.ciphertext, created_by: member.id, created_at: now, updated_at: now,
    };
    this.hub.txn(() => {
      this.db.insert('webhook_endpoints', row);
      this.audit('webhook.create', { member, target: id, detail: { host: target.url.host, events, include_text: !!row.include_text }, ip });
    });
    return { endpoint: publicEndpoint(row), secret };
  }

  /** PATCH {events?, include_text?, enabled?} */
  update(member, id, body, { ip }) {
    const r = this.endpoint(member, id);
    const set = {};
    if (body.events !== undefined) set.events = JSON.stringify(this.events(body.events));
    if (body.include_text !== undefined) {
      if (typeof body.include_text !== 'boolean') throw bad('include_text must be true or false');
      set.include_text = body.include_text ? 1 : 0;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw bad('enabled must be true or false');
      if (body.enabled && r.disabled_at) Object.assign(set, { disabled_at: null, disabled_reason: null });
      if (!body.enabled && !r.disabled_at) Object.assign(set, { disabled_at: this.hub.iso(), disabled_reason: 'admin' });
    }
    if (!Object.keys(set).length) return { endpoint: publicEndpoint(r) };
    set.updated_at = this.hub.iso();
    this.hub.txn(() => {
      this.db.run(`UPDATE webhook_endpoints SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), id);
      const detail = { ...(set.events ? { events: JSON.parse(set.events) } : {}), ...('include_text' in set ? { include_text: !!set.include_text } : {}), ...('disabled_at' in set ? { enabled: !set.disabled_at } : {}) };
      this.audit('webhook.update', { member, target: id, detail, ip });
    });
    return { endpoint: publicEndpoint(this.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', id)) };
  }

  remove(member, id, { ip }) {
    this.endpoint(member, id);
    const now = this.hub.iso();
    this.hub.txn(() => {
      this.db.run('UPDATE webhook_endpoints SET deleted_at = ?, updated_at = ?, key_id = \'\', nonce = X\'\', ciphertext = X\'\' WHERE id = ?', now, now, id);
      this.db.run('DELETE FROM webhook_deliveries WHERE endpoint_id = ?', id);
      this.audit('webhook.delete', { member, target: id, ip });
    });
    return { ok: true };
  }

  deliveries(member, id) {
    this.endpoint(member, id);
    return { deliveries: this.db.all('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', id, LOG_KEEP).map(publicDelivery) };
  }

  /** "Send test event": one attempt now, logged, never retried and never disabling. */
  async test(member, id, { ip }) {
    const r = this.endpoint(member, id);
    limitOrThrow(this.hub, 'webhook_test_member', member.id);
    const deliveryId = randomUUID();
    const payload = { id: deliveryId, type: TEST_EVENT, created_at: this.hub.iso(), team_id: r.org_id, data: { endpoint_id: r.id } };
    const now = this.hub.iso();
    this.db.insert('webhook_deliveries', { id: deliveryId, endpoint_id: r.id, event_type: TEST_EVENT, journal_seq: null, payload: JSON.stringify(payload), state: 'pending', attempts: 0, next_at_ms: null, created_at: now, updated_at: now });
    this.audit('webhook.test', { member, target: r.id, ip });
    await this.attempt(this.db.get('SELECT * FROM webhook_deliveries WHERE id = ?', deliveryId), { final: true });
    return { delivery: publicDelivery(this.db.get('SELECT * FROM webhook_deliveries WHERE id = ?', deliveryId)) };
  }

  // ── events ──────────────────────────────────────────────────────────────

  /** journal row → [{type, data}] in this API's terms (ids and titles only). */
  eventsOf(row, card) {
    const p = row.payload ?? {};
    const out = [];
    if (row.kind === 'card.create') out.push({ type: 'card.created', data: {} });
    if (row.kind === 'card.update' && Array.isArray(p.fields?.column_name)) out.push({ type: 'card.moved', data: { from_column: p.fields.column_name[0], to_column: p.fields.column_name[1] } });
    if (row.kind === 'card.transition') {
      const from = columnOf(p.from);
      const to = p.state?.column_name ?? columnOf(p.to === 'SAME' ? p.from : p.to);
      if (from !== to) out.push({ type: 'card.moved', data: { from_column: from, to_column: to } });
      if (row.run_id && Array.isArray(p.effects) && p.effects.includes('run_end')) {
        const run = this.db.get('SELECT id, end_reason FROM runs WHERE id = ?', row.run_id);
        if (run) out.push({ type: 'run.finished', data: { run: { id: run.id, outcome: p.to === 'SAME' ? p.from : p.to, end_reason: run.end_reason ?? null } } });
      }
    }
    if (row.kind === 'comment.create' && p.comment_id) out.push({ type: 'card.commented', data: { comment: { id: p.comment_id } }, comment: p.comment_id });
    if (row.kind === 'card_review.request' && p.review_id && p.status === 'pending') out.push({ type: 'review.requested', data: { review: { id: p.review_id } } });
    return card ? out : [];
  }

  /** Bus consumer: write one pending delivery per (subscribed endpoint, event). */
  onJournal(row) {
    if (!row.card_id || !row.board_id) return;
    const board = this.db.get('SELECT b.id, b.name, b.org_id FROM boards b JOIN orgs o ON o.id = b.org_id WHERE b.id = ? AND o.deleted_at IS NULL', row.board_id);
    if (!board) return;
    const endpoints = this.db.all('SELECT * FROM webhook_endpoints WHERE org_id = ? AND deleted_at IS NULL AND disabled_at IS NULL', board.org_id);
    if (!endpoints.length) return;
    const card = this.db.get('SELECT id, key, title, body, column_name, run_state FROM cards WHERE id = ?', row.card_id);
    const events = this.eventsOf(row, card);
    if (!events.length) return;
    const now = this.hub.iso();
    let added = 0;
    this.hub.txn(() => {
      for (const e of endpoints) {
        const wants = json(e.events, []);
        for (const ev of events) {
          if (!wants.includes(ev.type)) continue;
          if (this.db.get("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? AND state = 'pending'", e.id).n >= MAX_PENDING_PER_ENDPOINT) continue;
          const id = randomUUID();
          const c = { id: card.id, key: card.key, title: card.title, column: card.column_name, run_state: card.run_state ?? null, ...(e.include_text ? { body: card.body } : {}) };
          const data = { board: { id: board.id, name: board.name }, card: c, ...ev.data };
          if (ev.comment && e.include_text) data.comment = { ...data.comment, body: this.db.get('SELECT body FROM comments WHERE id = ?', ev.comment)?.body ?? null };
          const payload = JSON.stringify({ id, type: ev.type, created_at: row.at_hub, team_id: board.org_id, data });
          if (payload.length > 65536) continue;
          const r = this.db.run('INSERT OR IGNORE INTO webhook_deliveries (id, endpoint_id, event_type, journal_seq, payload, state, attempts, next_at_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'pending\', 0, ?, ?, ?)',
            id, e.id, ev.type, row.seq, payload, this.hub.wallMs(), now, now);
          added += Number(r.changes);
        }
      }
    });
    if (added) this.kick();
  }

  // ── sending ─────────────────────────────────────────────────────────────

  start() {
    this.started = true;
    const now = this.hub.iso();
    this.db.run("UPDATE webhook_deliveries SET next_at_ms = ?, updated_at = ? WHERE state = 'pending' AND next_at_ms IS NULL AND event_type != ?", this.hub.wallMs(), now, TEST_EVENT);
    this.db.run("UPDATE webhook_deliveries SET state = 'failed', last_error = 'interrupted', updated_at = ? WHERE state = 'pending' AND event_type = ?", now, TEST_EVENT);
    this.timer = setInterval(() => { this.deliverDue().catch((e) => this.hub.log.warn('webhook delivery failed', { err: e?.message })); }, TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    if (this.started) setImmediate(() => { this.deliverDue().catch(() => {}); });
  }

  /** Attempt every due delivery once (endpoints enabled, not deleted). Resolves when they have all finished. */
  deliverDue() {
    if (this.running) return this.running;
    const run = (async () => {
      for (;;) {
        const due = this.db.all(`SELECT d.* FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.state = 'pending' AND d.next_at_ms IS NOT NULL AND d.next_at_ms <= ? AND e.deleted_at IS NULL AND e.disabled_at IS NULL ORDER BY d.next_at_ms, d.rowid LIMIT ?`, this.hub.wallMs(), SEND_BATCH);
        if (!due.length) return;
        await Promise.all(due.map((d) => this.attempt(d)));
        if (due.length < SEND_BATCH) return;
      }
    })();
    this.running = run.finally(() => { this.running = null; });
    return this.running;
  }

  async attempt(d, { final = false } = {}) {
    const e = this.db.get('SELECT * FROM webhook_endpoints WHERE id = ? AND deleted_at IS NULL', d.endpoint_id);
    if (!e) return;
    // Claimed before the network wait: a concurrent pass never sends it twice.
    if (!final) {
      const claimed = this.db.run("UPDATE webhook_deliveries SET next_at_ms = NULL WHERE id = ? AND state = 'pending' AND next_at_ms = ?", d.id, d.next_at_ms);
      if (!Number(claimed.changes)) return;
    }
    let secret = null;
    try { secret = this.hub.vault.open(e.id, SECRET_KIND, e); } catch { secret = null; }
    const result = secret ? await this.send(e.url, d, secret) : { status: null, error: 'no_key', latency_ms: null };
    const ok = result.status != null && result.status >= 200 && result.status < 300;
    const attempts = d.attempts + 1;
    const now = this.hub.iso();
    const state = ok ? 'delivered' : final || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const next = state === 'pending' ? this.hub.wallMs() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] : null;
    this.hub.txn(() => {
      this.db.run(`UPDATE webhook_deliveries SET state = ?, attempts = ?, next_at_ms = ?, last_status = ?, last_error = ?, latency_ms = ?, updated_at = ?,
        payload = CASE WHEN ? = 'pending' THEN payload ELSE '{}' END WHERE id = ?`, state, attempts, next, result.status, ok ? null : result.error, result.latency_ms, now, state, d.id);
      if (state === 'failed' && !final) this.disable(e, d);
      this.db.run(`DELETE FROM webhook_deliveries WHERE endpoint_id = ? AND state != 'pending' AND id NOT IN
        (SELECT id FROM webhook_deliveries WHERE endpoint_id = ? AND state != 'pending' ORDER BY created_at DESC, rowid DESC LIMIT ?)`, e.id, e.id, LOG_KEEP);
    });
  }

  disable(e, d) {
    const now = this.hub.iso();
    const r = this.db.run("UPDATE webhook_endpoints SET disabled_at = ?, disabled_reason = 'failing', updated_at = ? WHERE id = ? AND disabled_at IS NULL", now, now, e.id);
    if (!Number(r.changes)) return;
    this.db.run("UPDATE webhook_deliveries SET state = 'failed', last_error = 'endpoint_disabled', next_at_ms = NULL, payload = '{}', updated_at = ? WHERE endpoint_id = ? AND state = 'pending'", now, e.id);
    this.audit('webhook.disabled', { orgId: e.org_id, target: e.id, detail: { reason: 'failing', delivery_id: d.id, attempts: MAX_ATTEMPTS } });
  }

  /** One POST → {status, error, latency_ms}. Never throws. */
  async send(url, d, secret) {
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    let target;
    try { target = await vetEndpoint(url, this.opts); } catch { return { status: null, error: 'address_refused', latency_ms: latency() }; }
    const timestamp = Math.floor(this.hub.wallMs() / 1000);
    const body = d.payload;
    const headers = {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'user-agent': 'Plexiform-Webhooks/1',
      'plexiform-event': d.event_type, 'plexiform-delivery': d.id, 'plexiform-timestamp': String(timestamp), 'plexiform-signature': signature(secret, timestamp, body),
      host: target.url.host,
    };
    const https = target.url.protocol === 'https:';
    const options = {
      host: target.address, family: target.family, port: target.url.port || (https ? 443 : 80), path: `${target.url.pathname}${target.url.search}`,
      method: 'POST', headers, agent: false, ...(https && !isIP(target.host) ? { servername: target.host } : {}),
    };
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...r, latency_ms: latency() });
      };
      const req = (https ? httpsRequest : httpRequest)(options, (res) => { // privacy-flow: hub-outbound-webhooks
        const status = res.statusCode;
        res.destroy();
        finish({ status, error: status >= 300 && status < 400 ? 'redirect_refused' : status >= 200 && status < 300 ? null : 'bad_status' });
      });
      const timer = setTimeout(() => { finish({ status: null, error: 'timeout' }); req.destroy(); }, this.timeoutMs);
      req.on('error', () => finish({ status: null, error: 'connect_failed' }));
      req.end(body);
    });
  }
}
