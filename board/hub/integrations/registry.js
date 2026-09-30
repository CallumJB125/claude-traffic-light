// The integrations registry (I1): holds the connectors and does everything
// around them, so a connector only speaks its provider's language.
//
//   - connections: create (secrets sealed in the vault), list (never secrets), revoke
//   - inbound webhooks: POST /integrations/<connection id>/webhook → verify the
//     provider signature over the raw body → replay-dedupe → handleWebhook
//   - the bus: each connector consumes the journal kinds it asked for
//   - ctx: sealed secrets, a retrying fetch, actAs(member) through the same Api
//     methods (and the same rate limit + D8 replay cache) as HTTP routes,
//     act() for the autonomy policy + audit log, health
//
// A connector never gets the DB, the vault key, or another connection's secrets.

import { randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { limitOrThrow } from '../ratelimit.js';
import { AUTONOMY } from './connector.js';

const MAX_BODY = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_TRIES = 4;

const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export function createIntegrations({ hub, api, bus = null, log, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const connectors = new Map();
  const db = hub.db;
  const now = () => hub.iso();

  // ── connections ─────────────────────────────────────────────────────────

  const row = (id) => db.get('SELECT * FROM connections WHERE id = ?', id);
  const publicConnection = (c) => ({
    id: c.id, provider: c.provider, external_id: c.external_id, display_name: c.display_name,
    scopes: safeJson(c.scopes, []), status: c.status, health: safeJson(c.health, null),
    settings: safeJson(c.settings, {}), created_at: c.created_at,
  });

  function createConnection({ orgId, memberId, provider, external_id, display_name, scopes = [], secrets = {}, settings = {} }) {
    const conn = connectors.get(provider);
    if (!conn) throw new HubError('VALIDATION', `unknown integration ${provider}`);
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    for (const k of Object.keys(secrets)) if (!conn.secrets.includes(k)) throw new HubError('VALIDATION', `${provider} does not declare secret ${k}`);
    const id = randomUUID();
    db.tx(() => {
      const existing = db.get("SELECT id FROM connections WHERE provider = ? AND external_id = ? AND status != 'revoked'", provider, String(external_id));
      if (existing) throw new HubError('CONFLICT', `this ${conn.name} is already connected`);
      db.run("DELETE FROM connections WHERE provider = ? AND external_id = ? AND status = 'revoked'", provider, String(external_id));
      db.insert('connections', {
        id, org_id: orgId, provider, external_id: String(external_id), display_name: display_name ?? null,
        scopes: JSON.stringify(scopes), status: 'active', settings: JSON.stringify(settings), created_by: memberId, created_at: now(),
      });
      for (const [kind, value] of Object.entries(secrets)) {
        const s = hub.vault.seal(id, kind, value);
        db.insert('connection_secrets', { connection_id: id, kind, key_id: s.key_id, nonce: s.nonce, ciphertext: s.ciphertext, created_at: now() });
      }
      hub.journal({ board_id: null, actor_kind: memberId ? 'member' : 'system', actor_id: memberId, kind: 'integration.connect', payload: { connection_id: id, provider } });
    });
    return publicConnection(row(id));
  }

  function revokeConnection(id, memberId) {
    const c = row(id);
    if (!c) throw new HubError('NOT_FOUND', 'no such integration');
    db.tx(() => {
      db.run("UPDATE connections SET status = 'revoked', revoked_at = ? WHERE id = ?", now(), id);
      db.run('DELETE FROM connection_secrets WHERE connection_id = ?', id);
      hub.journal({ board_id: null, actor_kind: memberId ? 'member' : 'system', actor_id: memberId, kind: 'integration.disconnect', payload: { connection_id: id, provider: c.provider } });
    });
  }

  function secretsOf(c) {
    const out = {};
    for (const r of db.all('SELECT * FROM connection_secrets WHERE connection_id = ?', c.id)) out[r.kind] = hub.vault.open(c.id, r.kind, r);
    return out;
  }

  function setHealth(id, ok, detail) {
    const c = row(id);
    if (!c) return;
    const h = safeJson(c.health, {}) ?? {};
    const t = now();
    const next = ok ? { ...h, ok: true, last_ok_at: t } : { ...h, ok: false, last_error: String(detail ?? 'error').slice(0, 300), last_error_at: t };
    db.run('UPDATE connections SET health = ? WHERE id = ?', JSON.stringify(next), id);
  }

  // ── ctx given to a connector for one connection ─────────────────────────

  function ctxFor(c) {
    const conn = connectors.get(c.provider);
    const settings = safeJson(c.settings, {});
    const secrets = () => secretsOf(c);

    // Retries with backoff on network errors, 5xx and 429 (honouring Retry-After);
    // records health. Never logs bodies or headers.
    async function retryingFetch(url, init = {}) {
      let last;
      for (let i = 0; i < FETCH_TRIES; i += 1) {
        try {
          const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (res.status === 429 || res.status >= 500) {
            last = new Error(`${new URL(url).host} answered ${res.status}`);
            const ra = Number(res.headers?.get?.('retry-after'));
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 500 * 2 ** i);
            continue;
          }
          setHealth(c.id, true);
          return res;
        } catch (e) {
          last = e;
          await sleep(500 * 2 ** i);
        }
      }
      setHealth(c.id, false, last?.message);
      throw last;
    }

    // The member an integration acts as goes through the same Api methods,
    // per-member rate limit and D8 replay cache as a browser would.
    function actAs(memberId) {
      const member = hub.member(memberId);
      if (!member || member.removed_at || member.org_id !== c.org_id) throw new HubError('FORBIDDEN', 'not a member of this team');
      const call = async (requestId, fn) => {
        if (requestId) {
          const hit = hub.cachedResponse(member.id, requestId);
          if (hit) return hit.body;
        }
        limitOrThrow(hub, 'mutate_member', member.id);
        const out = await fn();
        if (requestId) hub.cacheResponse(member.id, requestId, 200, out);
        return out;
      };
      return {
        member: { id: member.id, role: member.role },
        createCard: (boardId, body) => call(body.request_id, () => api.createCard(member, boardId, body)),
        comment: (cardId, body) => call(body.request_id, () => api.comment(member, cardId, body)),
        action: (cardId, action, body) => call(body.request_id, () => api.action(member, cardId, action, body)),
        answerPermission: (id, body) => call(body.request_id, () => api.answerPermission(member, id, body)),
      };
    }

    function autonomyOf(action) {
      const def = conn.actions[action]?.default;
      if (!def) throw new Error(`${conn.id} did not declare action ${action}`);
      const set = settings?.autonomy?.[action];
      return AUTONOMY.includes(set) ? set : def;
    }

    /**
     * act(action, {card_id?, external_ref?, detail?, undo?}, run) — the
     * autonomy gate. 'auto' runs and audits; 'ask' records a suggestion and
     * does not run (the UI turns it into a one-tap approval); 'off' skips.
     */
    async function act(action, meta, run) {
      const mode = autonomyOf(action);
      const audit = (decision) => db.insert('integration_audit', {
        id: randomUUID(), connection_id: c.id, action, decision, card_id: meta?.card_id ?? null,
        external_ref: meta?.external_ref == null ? null : String(meta.external_ref).slice(0, 200),
        detail: JSON.stringify(meta?.detail ?? {}), undo: meta?.undo ? JSON.stringify(meta.undo) : null, at: now(),
      });
      if (mode === 'off') { audit('skipped'); return { done: false, decision: 'skipped' }; }
      if (mode === 'ask') { audit('asked'); return { done: false, decision: 'asked' }; }
      const out = await run();
      audit('auto');
      return { done: true, decision: 'auto', result: out };
    }

    return {
      connection: { id: c.id, org_id: c.org_id, external_id: c.external_id, settings, created_by: c.created_by },
      secret: (kind) => secrets()[kind] ?? null,
      fetch: retryingFetch,
      actAs,
      act,
      autonomyOf,
      link: (cardId, kind, externalId, url = null) => db.run('INSERT OR IGNORE INTO external_links (card_id, connection_id, kind, external_id, url, created_at) VALUES (?, ?, ?, ?, ?, ?)', cardId, c.id, kind, String(externalId), url, now()),
      linked: (kind, externalId) => db.get('SELECT card_id FROM external_links WHERE connection_id = ? AND kind = ? AND external_id = ?', c.id, kind, String(externalId))?.card_id ?? null,
      boardIds: () => db.all('SELECT id FROM boards WHERE org_id = ?', c.org_id).map((b) => b.id),
      log: (msg, extra = {}) => log?.info?.(msg, { integration: c.provider, connection_id: c.id, ...extra }),
    };
  }

  // ── inbound webhooks ────────────────────────────────────────────────────

  /** → {status, body}. Never echoes why a signature failed to the caller. */
  async function webhook(connectionId, { headers, rawBody }) {
    const c = row(connectionId);
    const conn = c && connectors.get(c.provider);
    if (!c || c.status !== 'active' || !conn?.handleWebhook) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } };
    if (rawBody.length > MAX_BODY) return { status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'too large' } } };
    let v;
    try { v = conn.verify({ headers, rawBody, secrets: secretsOf(c), now: Date.now() }); } catch (e) { v = { ok: false, reason: e.message }; }
    if (!v?.ok || !v.dedupe_key) {
      log?.warn?.('integration webhook rejected', { integration: c.provider, connection_id: c.id, reason: v?.reason ?? 'no dedupe key' });
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'bad signature' } } };
    }
    const key = `${c.id}:${v.dedupe_key}`;
    if (db.get('SELECT 1 FROM inbound_dedupe WHERE provider = ? AND dedupe_key = ?', c.provider, key)) return { status: 200, body: { ok: true, duplicate: true } };
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: { code: 'VALIDATION', message: 'body must be JSON' } } }; }
    try {
      await conn.handleWebhook({ headers, payload, ctx: ctxFor(c) });
    } catch (e) {
      setHealth(c.id, false, e.message);
      log?.warn?.('integration webhook handler failed', { integration: c.provider, connection_id: c.id, err: e.message });
      // Not deduped: the provider's retry gets another go.
      return { status: 500, body: { error: { code: 'INTERNAL', message: 'handler failed' } } };
    }
    db.run('INSERT OR IGNORE INTO inbound_dedupe (provider, dedupe_key, received_at) VALUES (?, ?, ?)', c.provider, key, now());
    setHealth(c.id, true);
    return { status: 200, body: { ok: true } };
  }

  // ── registration ────────────────────────────────────────────────────────

  function register(conn) {
    if (connectors.has(conn.id)) throw new Error(`integration ${conn.id} registered twice`);
    connectors.set(conn.id, conn);
    if (bus && conn.consumes.length) {
      bus.subscribe(`integration:${conn.id}`, async (r) => {
        const orgOf = r.board_id ? hub.board(r.board_id)?.org_id : null;
        for (const c of db.all("SELECT * FROM connections WHERE provider = ? AND status = 'active'", conn.id)) {
          if (orgOf && c.org_id !== orgOf) continue; // a team's events never reach another team's connection
          await conn.onEvent(r, ctxFor(c));
        }
      }, { kinds: conn.consumes });
    }
  }

  return {
    register,
    connectors: () => [...connectors.values()].map((c) => ({ id: c.id, name: c.name, scopes: c.scopes, connect: c.connect.kind, actions: c.actions })),
    list: (orgId) => db.all("SELECT * FROM connections WHERE org_id = ? AND status != 'revoked' ORDER BY created_at", orgId).map(publicConnection),
    get: (id) => { const c = row(id); return c ? publicConnection(c) : null; },
    createConnection,
    revokeConnection,
    /** Token-style connect: the connector checks the token with its provider. */
    async verifyToken(provider, token) {
      const c = connectors.get(provider);
      if (!c || c.connect.kind !== 'token') throw new HubError('NOT_FOUND', 'no such token integration');
      return c.connect.verifyToken({ token, fetch: fetchImpl });
    },
    setSettings(id, patch) {
      const c = row(id);
      if (!c) throw new HubError('NOT_FOUND', 'no such integration');
      const conn = connectors.get(c.provider);
      const next = { ...safeJson(c.settings, {}), ...patch };
      for (const [a, m] of Object.entries(next.autonomy ?? {})) {
        if (!conn.actions[a]) throw new HubError('VALIDATION', `${conn.name} has no action ${a}`);
        if (!AUTONOMY.includes(m)) throw new HubError('VALIDATION', 'autonomy must be auto, ask or off');
      }
      db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify(next), id);
      return publicConnection(row(id));
    },
    audit: (id, { limit = 100 } = {}) => db.all('SELECT id, action, decision, card_id, external_ref, detail, undo, at FROM integration_audit WHERE connection_id = ? ORDER BY at DESC LIMIT ?', id, Math.min(500, limit))
      .map((a) => ({ ...a, detail: safeJson(a.detail, {}), undo: safeJson(a.undo, null) })),
    webhook,
    ctxFor: (id) => { const c = row(id); return c ? ctxFor(c) : null; },
  };
}
