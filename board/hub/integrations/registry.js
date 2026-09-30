// The integrations registry (I1): holds the connectors and does everything
// around them, so a connector only speaks its provider's language.
//
//   - connections: create (secrets sealed in the vault), list (never secrets), revoke
//   - inbound webhooks: POST /integrations/<connection id>/webhook → verify the
//     provider signature over the raw body → lease the delivery id → handleWebhook
//   - the bus: one consumer per connection, only its own team's rows
//   - ctx: sealed secrets, a host-restricted retrying fetch, act() for the
//     autonomy policy + audit log, whose scope is the only way to act on the
//     board (actAs a member, link a card), health
//
// A connector never gets the DB, the vault key, or another connection's secrets.

import { randomUUID, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HubError } from '../db.js';
import { limitOrThrow } from '../ratelimit.js';
import { redact } from '../log.js';
import { DISPATCH_ACTIONS } from '../http.js';
import { httpStatus } from '../../shared/protocol.js';
import { AUTONOMY } from './connector.js';

const MAX_BODY = 1024 * 1024;
const STATE_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_MAX = 200;
const b64 = (x) => Buffer.from(x).toString('base64url');
const sha = (x) => createHash('sha256').update(String(x)).digest('base64url');
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_TRIES = 4;
const HANDLER_TIMEOUT_MS = 60_000;
const DEDUPE_KEEP_MS = 30 * 24 * 3600_000;
const CONFIG_MAX_BYTES = 8 * 1024;
const AUDIT_JSON_MAX = 2048;
const AUDIT_STR_MAX = 128;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The member an integration acts as was removed or can no longer write: retrying won't help. */
export class ActorUnavailable extends Error {
  constructor() { super('the member this integration acts as was removed or can no longer write'); this.code = 'ACTOR_UNAVAILABLE'; }
}

const tagged = (message, healthCode) => Object.assign(new Error(message), { healthCode });

// Health and audit keep a short code (members can read them), never provider text.
function errCode(e) {
  if (e instanceof ActorUnavailable) return 'actor_unavailable';
  if (e?.code === 'TIMEOUT') return 'handler_timeout';
  if (e?.healthCode) return e.healthCode;
  if (e instanceof HubError) return String(e.code).toLowerCase();
  return 'handler_failed';
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(`handler did not finish within ${ms} ms`), { code: 'TIMEOUT' })), ms);
    t.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Audit detail/undo: scalars and ids only, ≤ 2 KB (never message text).
function auditJson(v) {
  if (!isPlainObject(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k.length > 64) continue;
    if ((typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean' || x === null) out[k] = x;
    else if (typeof x === 'string' && x.length <= AUDIT_STR_MAX) out[k] = x;
  }
  const s = JSON.stringify(out);
  return Buffer.byteLength(s) <= AUDIT_JSON_MAX ? s : JSON.stringify({ truncated: true });
}

export function createIntegrations({
  hub, api, bus = null, log, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  handlerTimeoutMs = HANDLER_TIMEOUT_MS, random = Math.random,
}) {
  const connectors = new Map();
  const db = hub.db;
  const now = () => hub.iso();
  const pending = new Map(); // sha(complete_token) → {m, o, p, v, exp}: OAuth results waiting for POST …/complete

  const warn = (msg, c, e) => log?.warn?.(msg, { integration: c?.provider ?? c?.id, connection_id: c?.id, err: redact(e?.message ?? e) });

  // ── connections ─────────────────────────────────────────────────────────

  const row = (id) => db.get('SELECT * FROM connections WHERE id = ?', id);
  const publicConnection = (c) => ({
    id: c.id, provider: c.provider, external_id: c.external_id, display_name: c.display_name,
    scopes: safeJson(c.scopes, []), status: c.status, health: safeJson(c.health, null),
    settings: safeJson(c.settings, {}), created_at: c.created_at,
  });
  const consumerName = (c) => `integration:${c.provider}:${c.id}`;

  function createConnection({ orgId, memberId, provider, external_id, display_name, scopes = [], secrets = {}, settings = {} }) {
    const conn = connectors.get(provider);
    if (!conn) throw new HubError('VALIDATION', `unknown integration ${provider}`);
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    const ext = String(external_id ?? '');
    if (!ext || ext.length > 200) throw new HubError('VALIDATION', 'the provider did not name the workspace');
    if (!isPlainObject(secrets) || !isPlainObject(settings)) throw new HubError('VALIDATION', 'bad connection data');
    for (const k of Object.keys(secrets)) if (!conn.secrets.includes(k)) throw new HubError('VALIDATION', `${provider} does not declare secret ${k}`);
    const id = randomUUID();
    hub.txn(() => {
      // Unique per org among live rows (partial index); revoked rows stay for their audit history.
      if (db.get("SELECT id FROM connections WHERE org_id = ? AND provider = ? AND external_id = ? AND status != 'revoked'", orgId, provider, ext)) {
        throw new HubError('CONFLICT', `this ${conn.name} is already connected`);
      }
      db.insert('connections', {
        id, org_id: orgId, provider, external_id: ext, display_name: display_name == null ? null : String(display_name).slice(0, 200),
        scopes: JSON.stringify(Array.isArray(scopes) ? scopes.map(String) : []), status: 'active', settings: JSON.stringify(settings), created_by: memberId, created_at: now(),
      });
      for (const [kind, value] of Object.entries(secrets)) {
        const s = hub.vault.seal(id, kind, value);
        db.insert('connection_secrets', { connection_id: id, kind, key_id: s.key_id, nonce: s.nonce, ciphertext: s.ciphertext, created_at: now() });
      }
      hub.journal({ board_id: null, actor_kind: memberId ? 'member' : 'system', actor_id: memberId, kind: 'integration.connect', payload: { connection_id: id, provider } });
    });
    const c = row(id);
    subscribe(c);
    return publicConnection(c);
  }

  function revokeConnection(id, memberId) {
    const c = row(id);
    if (!c || c.status === 'revoked') throw new HubError('NOT_FOUND', 'no such integration');
    hub.txn(() => {
      db.run("UPDATE connections SET status = 'revoked', revoked_at = ? WHERE id = ?", now(), id);
      db.run('DELETE FROM connection_secrets WHERE connection_id = ?', id);
      hub.journal({ board_id: null, actor_kind: memberId ? 'member' : 'system', actor_id: memberId, kind: 'integration.disconnect', payload: { connection_id: id, provider: c.provider } });
    });
    bus?.unsubscribe(consumerName(c));
  }

  function secretsOf(c) {
    const out = {};
    for (const r of db.all('SELECT * FROM connection_secrets WHERE connection_id = ?', c.id)) out[r.kind] = hub.vault.open(c.id, r.kind, r);
    return out;
  }

  /** code: a short category (errCode), never provider text: members read health. */
  function setHealth(id, ok, code) {
    const c = row(id);
    if (!c) return;
    const h = safeJson(c.health, {}) ?? {};
    const t = now();
    const next = ok ? { ...h, ok: true, last_ok_at: t } : { ...h, ok: false, last_error: String(code ?? 'error').slice(0, 40), last_error_at: t };
    db.run('UPDATE connections SET health = ? WHERE id = ?', JSON.stringify(next), id);
  }

  // ── outbound HTTP: only the connector's declared hosts, https, no redirects off-host ──

  function restrictedFetch(conn) {
    const allowed = new Set(conn.hosts);
    const check = (u, base) => {
      let url;
      try { url = new URL(u, base); } catch { throw tagged(`${conn.id}: not a URL`, 'host_refused'); }
      if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !allowed.has(url.hostname)) {
        throw tagged(`${conn.id} may not fetch ${url.protocol}//${url.host}`, 'host_refused');
      }
      return url;
    };
    return async function fetchOnce(u, init = {}) {
      let url = check(u);
      let opts = { ...init };
      for (let hop = 0; ; hop += 1) {
        const res = await fetchImpl(url.href, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const loc = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
        if (!loc) return res;
        if (hop >= 1) throw tagged(`${url.host}: too many redirects`, 'provider_error');
        const next = check(loc, url);
        if (next.host !== url.host) throw tagged(`${url.host} redirected off-host`, 'host_refused');
        if (res.status === 303) opts = { ...opts, method: 'GET', body: undefined };
        url = next;
      }
    };
  }

  // ── ctx given to a connector for one connection ─────────────────────────

  function ctxFor(c) {
    const conn = connectors.get(c.provider);
    const settings = safeJson(c.settings, {});
    const secrets = () => secretsOf(c);
    const fetchOnce = restrictedFetch(conn);
    let openScopes = 0;

    // Retries with backoff on network errors, 5xx and 429 (honouring Retry-After);
    // records health. Never logs bodies or headers.
    async function retryingFetch(url, init = {}) {
      let last;
      for (let i = 0; i < FETCH_TRIES; i += 1) {
        try {
          const res = await fetchOnce(url, init);
          if (res.status === 429 || res.status >= 500) {
            last = tagged(`${new URL(url).host} answered ${res.status}`, 'provider_error');
            const ra = Number(res.headers?.get?.('retry-after'));
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 500 * 2 ** i);
            continue;
          }
          setHealth(c.id, true);
          return res;
        } catch (e) {
          if (e?.healthCode === 'host_refused') { setHealth(c.id, false, 'host_refused'); throw e; }
          last = e?.healthCode ? e : tagged(e?.message ?? 'fetch failed', 'provider_unreachable');
          await sleep(500 * 2 ** i);
        }
      }
      setHealth(c.id, false, errCode(last));
      throw last;
    }

    // The member an integration acts as goes through the same Api methods,
    // per-member rate limit and D8 replay cache as a browser would; the
    // journal and feed name the integration (D42, §15).
    function actAs(memberId) {
      const member = hub.member(memberId);
      if (!member || member.org_id !== c.org_id) throw new HubError('FORBIDDEN', 'not a member of this team');
      if (member.removed_at || !hub.canWrite(member)) throw new ActorUnavailable();
      const via = { connection_id: c.id, member_id: member.id, name: conn.name };
      const call = async (requestId, fn) => {
        // Namespaced per connection: never collides with the member's own browser request ids.
        const rid = requestId == null ? null : `int:${c.id}:${String(requestId).slice(0, 200)}`;
        if (rid) {
          const hit = hub.cachedResponse(member.id, rid);
          if (hit) {
            if (hit.status >= 400) { const { code, message, ...extra } = hit.body.error; throw new HubError(code, message, extra); }
            return hit.body;
          }
        }
        limitOrThrow(hub, 'mutate_member', member.id);
        let out;
        try {
          out = await hub.actVia(via, fn);
        } catch (e) {
          if (rid && e instanceof HubError) hub.cacheResponse(member.id, rid, httpStatus(e.code), { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } });
          throw e;
        }
        if (rid) hub.cacheResponse(member.id, rid, 200, out);
        return out;
      };
      return {
        member: { id: member.id, role: member.role },
        createCard: (boardId, body = {}) => call(body.request_id, () => api.createCard(member, boardId, body)),
        comment: (cardId, body = {}) => call(body.request_id, () => api.comment(member, cardId, body)),
        action: (cardId, action, body = {}) => {
          // Callum's autonomy policy: an integration never starts a paid run.
          if (DISPATCH_ACTIONS.has(action)) throw new HubError('POLICY_DENIED', 'an integration never starts an agent run on its own; a person does it from the card');
          return call(body.request_id, () => api.action(member, cardId, action, body));
        },
        answerPermission: () => { throw new HubError('POLICY_DENIED', 'an integration never answers a permission request'); },
      };
    }

    const cardInOrg = (cardId) => {
      const card = cardId ? hub.card(cardId) : null;
      return card && hub.board(card.board_id)?.org_id === c.org_id ? card : null;
    };

    function link(cardId, kind, externalId, url = null) {
      if (!cardInOrg(cardId)) throw new HubError('NOT_FOUND', 'card not found');
      db.run('INSERT OR IGNORE INTO external_links (card_id, connection_id, kind, external_id, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        cardId, c.id, String(kind), String(externalId), url == null ? null : String(url).slice(0, 500), now());
    }

    function autonomyOf(action) {
      if (!Object.hasOwn(conn.actions, action)) throw new Error(`${conn.id} did not declare action ${action}`);
      const def = conn.actions[action].default;
      // Read fresh: an admin's change applies to the very next action.
      const set = safeJson(row(c.id)?.settings, {})?.autonomy?.[action];
      return AUTONOMY.includes(set) ? set : def;
    }

    /**
     * act(action, {card_id?, external_ref?, detail?, undo?}, run(scope)) — the
     * autonomy gate and the only way to act. 'auto' writes an 'attempted'
     * audit row, runs, then marks it 'auto' or 'failed' (+ code); 'ask'
     * records a suggestion and does not run; 'off' skips. `scope`
     * ({actAs, link}) works only while run() is running.
     */
    async function act(action, meta, run) {
      const mode = autonomyOf(action);
      const base = {
        connection_id: c.id, action, card_id: cardInOrg(meta?.card_id)?.id ?? null,
        external_ref: meta?.external_ref == null ? null : String(meta.external_ref).slice(0, 200),
        detail: auditJson(meta?.detail) ?? '{}', undo: auditJson(meta?.undo),
      };
      const audit = (decision) => { const id = randomUUID(); db.insert('integration_audit', { id, ...base, decision, at: now() }); return id; };
      if (mode === 'off') { audit('skipped'); return { done: false, decision: 'skipped' }; }
      if (mode === 'ask') { audit('asked'); return { done: false, decision: 'asked' }; }
      const auditId = audit('attempted');
      let open = true;
      const guard = (fn) => (...args) => { if (!open) throw new Error('this act() scope has ended'); return fn(...args); };
      const scope = { actAs: guard(actAs), link: guard(link) };
      let decision = 'failed';
      let error = 'handler_failed';
      openScopes += 1;
      try {
        const out = await run(scope);
        decision = 'auto';
        error = null;
        return { done: true, decision: 'auto', result: out };
      } catch (e) {
        error = errCode(e);
        throw e;
      } finally {
        open = false;
        openScopes -= 1;
        db.run('UPDATE integration_audit SET decision = ?, error = ? WHERE id = ?', decision, error, auditId);
      }
    }

    /**
     * Raise a state-machine fact as the integration (D42): `type` must be one
     * the connector declared; the card comes only from this connection's own
     * link. Applied like the merge poll, audited in the same transaction.
     * Never call it from inside a withBoard callback on the same board.
     */
    async function systemEvent(type, { kind, external_id, pr = null, by = null, external_ref = null }) {
      if (!conn.systemEvents.includes(type)) throw new Error(`${conn.id} may not raise ${type}`);
      const prN = Number.isSafeInteger(pr) && pr > 0 ? pr : null;
      const byLogin = typeof by === 'string' && GITHUB_LOGIN.test(by) ? by : null;
      const cardId = db.get('SELECT card_id FROM external_links WHERE connection_id = ? AND kind = ? AND external_id = ?', c.id, String(kind), String(external_id))?.card_id;
      const card = cardInOrg(cardId);
      if (!card) return { done: false, reason: 'not linked' };
      if (hub.inBoard(card.board_id)) throw new Error('ctx.system.event was called inside the board queue of its own card (it would deadlock)');
      const action = `system.${type}`;
      const mode = autonomyOf(action);
      const audit = (decision) => db.insert('integration_audit', {
        id: randomUUID(), connection_id: c.id, action, decision, card_id: card.id,
        external_ref: String(external_ref ?? external_id).slice(0, 200), detail: JSON.stringify({ pr: prN }), undo: null, at: now(),
      });
      if (mode !== 'auto') { audit(mode === 'ask' ? 'asked' : 'skipped'); return { done: false, decision: mode === 'ask' ? 'asked' : 'skipped' }; }
      const via = { connection_id: c.id, member_id: null, name: conn.name };
      // hub.txn (not db.tx): the outermost transaction flushes apply()'s
      // after-commit work (broadcasts, notifies, the bus poke).
      return hub.withBoard(card.board_id, () => hub.actVia(via, () => hub.txn(() => {
        const r = hub.apply(card.id, { type, pr: prN, by: byLogin }, { actor: c.id });
        if (!r.ok) return { done: false, reason: r.error.code };
        audit('auto');
        return { done: true, decision: 'auto', to: r.to };
      })));
    }

    return {
      connection: { id: c.id, org_id: c.org_id, external_id: c.external_id, settings, created_by: c.created_by },
      system: conn.systemEvents.length ? { event: systemEvent } : null,
      secret: (kind) => secrets()[kind] ?? null,
      fetch: retryingFetch,
      act,
      autonomyOf,
      link: (...args) => {
        if (!openScopes) throw new Error('ctx.link works only inside act(); use the scope it passes');
        return link(...args);
      },
      linked: (kind, externalId) => db.get('SELECT card_id FROM external_links WHERE connection_id = ? AND kind = ? AND external_id = ?', c.id, String(kind), String(externalId))?.card_id ?? null,
      boardIds: () => db.all('SELECT id FROM boards WHERE org_id = ?', c.org_id).map((b) => b.id),
      log: (msg, extra = {}) => log?.info?.(msg, { integration: c.provider, connection_id: c.id, ...extra }),
    };
  }

  // ── inbound webhooks ────────────────────────────────────────────────────

  function sweepDedupe() {
    db.run('DELETE FROM inbound_dedupe WHERE received_at < ?', new Date(hub.wallMs() - DEDUPE_KEEP_MS).toISOString());
  }

  /**
   * Lease a delivery id: → {ok:true, until} (we run it), {dup:'done'} or {dup:'busy'}.
   * A lease that outlived its handler (crash, hang) is taken over atomically.
   */
  function reserve(provider, key) {
    if (random() < 0.01) sweepDedupe();
    const t = now();
    const until = new Date(hub.wallMs() + handlerTimeoutMs + 30_000).toISOString();
    const ins = db.run("INSERT OR IGNORE INTO inbound_dedupe (provider, dedupe_key, received_at, state, lease_until) VALUES (?, ?, ?, 'processing', ?)", provider, key, t, until);
    if (Number(ins.changes) === 1) return { ok: true, until };
    const ex = db.get('SELECT state FROM inbound_dedupe WHERE provider = ? AND dedupe_key = ?', provider, key);
    if (ex?.state === 'done') return { dup: 'done' };
    const took = db.run("UPDATE inbound_dedupe SET lease_until = ?, received_at = ? WHERE provider = ? AND dedupe_key = ? AND state = 'processing' AND lease_until < ?", until, t, provider, key, t);
    return Number(took.changes) === 1 ? { ok: true, until } : { dup: 'busy' };
  }

  /** The HTTP layer asks this before reading a body: unknown or inactive → 404 unread. */
  function webhookTarget(connectionId) {
    const c = row(connectionId);
    return !!(c && c.status === 'active' && connectors.get(c.provider)?.handleWebhook);
  }

  /** → {status, body}. Never echoes why a signature failed to the caller. */
  async function webhook(connectionId, { headers, rawBody }) {
    const c = row(connectionId);
    const conn = c && connectors.get(c.provider);
    if (!c || c.status !== 'active' || !conn?.handleWebhook) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } };
    if (rawBody.length > MAX_BODY) return { status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'too large' } } };
    let v;
    try { v = conn.verify({ headers, rawBody, secrets: secretsOf(c), now: Date.now() }); } catch (e) { v = { ok: false, reason: e.message }; }
    if (!v?.ok || !v.dedupe_key) {
      log?.warn?.('integration webhook rejected', { integration: c.provider, connection_id: c.id, reason: redact(v?.reason ?? 'no dedupe key') });
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'bad signature' } } };
    }
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: { code: 'VALIDATION', message: 'body must be JSON' } } }; }
    const key = `${c.id}:${String(v.dedupe_key).slice(0, 200)}`;
    const lease = reserve(c.provider, key);
    if (lease.dup === 'done') return { status: 200, body: { ok: true, duplicate: true } };
    if (lease.dup === 'busy') return { status: 200, body: { ok: true, in_progress: true } };
    const done = () => db.run("UPDATE inbound_dedupe SET state = 'done', lease_until = NULL WHERE provider = ? AND dedupe_key = ?", c.provider, key);
    try {
      await withTimeout(Promise.resolve().then(() => conn.handleWebhook({ headers, payload, ctx: ctxFor(c) })), handlerTimeoutMs);
    } catch (e) {
      if (e instanceof ActorUnavailable) {
        // An admin has to reconnect it; the provider's retries would fail the same way.
        done();
        setHealth(c.id, false, 'actor_unavailable');
        warn('integration acts as a removed member', c, e);
        return { status: 200, body: { ok: true, skipped: true } };
      }
      // Released: the provider's retry gets another go.
      db.run('DELETE FROM inbound_dedupe WHERE provider = ? AND dedupe_key = ? AND lease_until = ?', c.provider, key, lease.until);
      setHealth(c.id, false, errCode(e));
      warn('integration webhook handler failed', c, e);
      return { status: 500, body: { error: { code: 'INTERNAL', message: 'handler failed' } } };
    }
    done();
    setHealth(c.id, true);
    return { status: 200, body: { ok: true } };
  }

  // ── OAuth / app-install connect ─────────────────────────────────────────
  // `state` = payload.HMAC(hub secret): the admin, their team, the provider,
  // 10 minutes, single use, and two bindings to whoever started it: the hash
  // of an HttpOnly cookie nonce (same browser) and the hash of a complete
  // token only the starting app holds (the desktop's separate connect window).

  const mac = (payload) => createHmac('sha256', hub.secret).update(`integration-state|${payload}`).digest();
  const redirectFor = (publicUrl, provider) => `${publicUrl}/integrations/${provider}/callback`;
  const bindCookieName = (provider) => `board_int_${provider}`;

  function oauthStart({ member, provider, publicUrl }) {
    const conn = connectors.get(provider);
    if (!conn || conn.connect.kind === 'token') throw new HubError('NOT_FOUND', 'no such integration');
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    const bind = randomBytes(24).toString('base64url');
    const completeToken = randomBytes(24).toString('base64url');
    const payload = b64(JSON.stringify({
      m: member.id, o: member.org_id, p: provider, n: randomBytes(16).toString('base64url'), e: Date.now() + STATE_TTL_MS, b: sha(bind), c: sha(completeToken),
    }));
    const state = `${payload}.${mac(payload).toString('base64url')}`;
    return {
      url: conn.connect.authorizeUrl({ state, redirectUri: redirectFor(publicUrl, provider), config: {} }),
      complete_token: completeToken,
      cookie: { name: bindCookieName(provider), value: bind, max_age_s: STATE_TTL_MS / 1000 },
    };
  }

  /**
   * → {ok:true, connection} (cookie matched) | {ok:true, pending:true} (no
   * cookie: waits for POST …/complete) | {ok:false, error} (error is safe to show).
   */
  async function oauthCallback({ provider, query, publicUrl, bindCookie = null }) {
    const conn = connectors.get(provider);
    if (!conn || conn.connect.kind === 'token') return { ok: false, error: 'Unknown integration.' };
    const parts = String(query.get('state') ?? '').split('.');
    const [payload, sig] = parts;
    const invalid = { ok: false, error: 'This link is not valid. Start again from Buddy.' };
    if (parts.length !== 2 || !payload || !/^[A-Za-z0-9_-]+$/.test(sig ?? '')) return invalid;
    const got = Buffer.from(sig, 'base64url');
    const want = mac(payload);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return invalid;
    const st = safeJson(Buffer.from(payload, 'base64url').toString('utf8'), null);
    if (!st || st.p !== provider || typeof st.n !== 'string' || !(Date.now() <= st.e)) return { ok: false, error: 'This link has expired. Start again from Buddy.' };
    const first = db.run("INSERT OR IGNORE INTO inbound_dedupe (provider, dedupe_key, received_at, state) VALUES ('oauth_state', ?, ?, 'done')", st.n, now());
    if (Number(first.changes) !== 1) return { ok: false, error: 'This link was already used. Start again from Buddy.' };
    const member = hub.member(st.m);
    if (!member || member.removed_at || member.org_id !== st.o || !['owner', 'admin'].includes(member.role)) return { ok: false, error: 'Only a team admin can connect this.' };
    if (query.get('error')) return { ok: false, error: 'The connection was cancelled.' };
    if (bindCookie != null && !safeEq(sha(bindCookie), st.b)) return { ok: false, error: 'This connection was started in another browser. Start again from Buddy.' };
    let v;
    try {
      v = await conn.connect.exchange({ query, redirectUri: redirectFor(publicUrl, provider), config: {}, fetch: restrictedFetch(conn) });
    } catch (e) {
      warn('integration connect failed', conn, e);
      return { ok: false, error: 'The provider did not accept the connection. Try again.' };
    }
    if (bindCookie == null) {
      const t = Date.now();
      for (const [k, p] of pending) if (p.exp < t) pending.delete(k);
      if (pending.size >= PENDING_MAX) return { ok: false, error: 'Too many connections are waiting. Try again in a few minutes.' };
      pending.set(st.c, { m: member.id, o: member.org_id, p: provider, v, exp: t + PENDING_TTL_MS });
      return { ok: true, pending: true };
    }
    try {
      return { ok: true, connection: createConnection({ ...v, orgId: member.org_id, memberId: member.id, provider }) };
    } catch (e) {
      return { ok: false, error: e instanceof HubError ? e.message : 'Could not save the connection.' };
    }
  }

  /** POST /api/integrations/:provider/complete: only the admin who started it, within 10 minutes, once. */
  function oauthComplete({ member, provider, completeToken }) {
    const k = sha(completeToken);
    const p = pending.get(k);
    if (!p || p.exp < Date.now() || p.p !== provider || p.m !== member.id || p.o !== member.org_id) {
      throw new HubError('NOT_FOUND', 'nothing to finish: it may have expired, start again');
    }
    pending.delete(k);
    return createConnection({ ...p.v, orgId: member.org_id, memberId: member.id, provider });
  }

  // ── the bus: one consumer per connection (a stuck team never stalls another) ──

  function subscribe(c) {
    const conn = connectors.get(c.provider);
    if (!bus || !conn?.consumes.length || c.status !== 'active' || bus.has(consumerName(c))) return;
    bus.subscribe(consumerName(c), async (r) => {
      // Hub-wide rows (no board) and rows of another team never reach a connection.
      const orgOf = r.board_id ? hub.board(r.board_id)?.org_id : null;
      if (!orgOf || orgOf !== c.org_id) return;
      const cur = row(c.id);
      if (!cur || cur.status !== 'active') return;
      try {
        await withTimeout(Promise.resolve().then(() => conn.onEvent(r, ctxFor(cur))), handlerTimeoutMs);
      } catch (e) {
        const code = errCode(e);
        setHealth(c.id, false, code);
        if (e instanceof ActorUnavailable) { warn('integration acts as a removed member', c, e); return; }
        throw new Error(`${code}: ${redact(e?.message ?? e)}`);
      }
    }, { kinds: conn.consumes });
  }

  // ── registration ────────────────────────────────────────────────────────

  function register(conn) {
    if (connectors.has(conn.id)) throw new Error(`integration ${conn.id} registered twice`);
    connectors.set(conn.id, conn);
    for (const c of db.all("SELECT * FROM connections WHERE provider = ? AND status = 'active'", conn.id)) subscribe(c);
  }

  return {
    register,
    connectors: () => [...connectors.values()].map((c) => ({ id: c.id, name: c.name, scopes: c.scopes, connect: c.connect.kind, actions: c.actions })),
    list: (orgId) => db.all("SELECT * FROM connections WHERE org_id = ? AND status != 'revoked' ORDER BY created_at", orgId).map(publicConnection),
    get: (id) => { const c = row(id); return c ? publicConnection(c) : null; },
    orgOf: (id) => row(id)?.org_id ?? null,
    createConnection,
    revokeConnection,
    /** Token-style connect: the connector checks the token with its provider. */
    async verifyToken(provider, token) {
      const c = connectors.get(provider);
      if (!c || c.connect.kind !== 'token') throw new HubError('NOT_FOUND', 'no such token integration');
      return c.connect.verifyToken({ token, fetch: restrictedFetch(c) });
    },
    setSettings(id, patch) {
      const c = row(id);
      if (!c || c.status === 'revoked') throw new HubError('NOT_FOUND', 'no such integration');
      const conn = connectors.get(c.provider);
      if (!conn) throw new HubError('NOT_FOUND', 'no such integration');
      if (patch.autonomy !== undefined && !isPlainObject(patch.autonomy)) throw new HubError('VALIDATION', 'autonomy must be an object');
      if (patch.config !== undefined) {
        if (!isPlainObject(patch.config)) throw new HubError('VALIDATION', 'config must be an object');
        if (Buffer.byteLength(JSON.stringify(patch.config)) > CONFIG_MAX_BYTES) throw new HubError('VALIDATION', 'config is over 8 KB');
      }
      const next = { ...safeJson(c.settings, {}), ...patch };
      for (const [a, m] of Object.entries(next.autonomy ?? {})) {
        if (!Object.hasOwn(conn.actions, a)) throw new HubError('VALIDATION', `${conn.name} has no action ${a}`);
        if (!AUTONOMY.includes(m)) throw new HubError('VALIDATION', 'autonomy must be auto, ask or off');
      }
      db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify(next), id);
      return publicConnection(row(id));
    },
    audit: (id, { limit = 100 } = {}) => db.all('SELECT id, action, decision, error, card_id, external_ref, detail, undo, at FROM integration_audit WHERE connection_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', id, Math.min(500, Math.max(1, Number(limit) || 100)))
      .map((a) => ({ ...a, detail: safeJson(a.detail, {}), undo: safeJson(a.undo, null) })),
    webhookTarget,
    webhook,
    sweepDedupe,
    oauthStart,
    oauthCallback,
    oauthComplete,
    bindCookieName,
    ctxFor: (id) => { const c = row(id); return c ? ctxFor(c) : null; },
  };
}
