// The integrations registry (I1): holds the connectors and does everything
// around them, so a connector only speaks its provider's language.
//
//   - connections: create (secrets sealed in the vault), list (never secrets), revoke
//   - inbound webhooks: POST /integrations/<connection id>/webhook → verify the
//     provider signature over the raw body → lease the delivery id → handleWebhook
//   - the bus: one consumer per connection, only its own team's rows
//   - ctx: sealed secrets, a host-restricted retrying fetch, act() for the
//     autonomy policy + audit log, whose scope is the only way to act on the
//     board (actAs a member, link a card), health, an AbortSignal
//
// A connector never gets the DB, the vault key, or another connection's secrets.

import { randomUUID, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HubError } from '../db.js';
import { limitOrThrow } from '../ratelimit.js';
import { redact } from '../log.js';
import { httpStatus } from '../../shared/protocol.js';
import { normalizeRemoteUrl, matchRepo } from '../../shared/scope.js';
import { AUTONOMY, cleanLinkStatus, parseCidr, configKeyOk } from './connector.js';
import { isLoopback } from '../config.js';
import { BlockList, isIP } from 'node:net'; // privacy-flow: hub-server
import { prNumberOf } from '../github.js';
import { createJwks, readCapped, verifyRs256 } from '../jwt.js';

const MAX_BODY = 1024 * 1024;
const STATE_TTL_MS = 10 * 60_000;
const b64 = (x) => Buffer.from(x).toString('base64url');
const sha = (x) => createHash('sha256').update(String(x)).digest('base64url');
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_TRIES = 4;
const HANDLER_TIMEOUT_MS = 60_000;
const DEDUPE_KEEP_MS = 30 * 24 * 3600_000;
const CONFIG_MAX_BYTES = 8 * 1024;
const CONFIG_DEPTH = 4;
const PROVIDER_MAX = 4096; // exchange ⊕ prepare (≤ 2 KB) plus the pinned match and hub_url
// What a connection is created with: autonomy and config are an admin's, set
// later through setSettings and its validators only.
const INSERT_NAMESPACES = ['provider', 'pinned'];
const SECRET_MAX_BYTES = 16 * 1024; // a PEM private key fits
const AUDIT_JSON_MAX = 2048;
const AUDIT_STR_MAX = 128;
const REQUEST_ID_MAX = 200;
const SUBJECT_MAX = 128;
const BOARDS_MAX = 100;
const AUDIT_KEEP_MS = 90 * 24 * 3600_000;
const AUDIT_REF_MAX = 80;
// An id (PR number, issue key, branch, sha, slug): never free text, which a
// connector could pass by mistake and admins would then read as ours.
const AUDIT_ID = /^[\w.:#\/@-]{1,128}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const BRANCH_MAX = 255;
// Unicode spaces, controls and invisible format characters: never in a board branch.
const BRANCH_BAD = /[\s\p{Cc}\p{Cf}]/u;
// An allowlist, not a denylist: anything that starts a paid run, hands work
// on, answers an agent or feeds it text stays a person's action.
const ALLOWED_ACTIONS = new Set(['cancel', 'stop', 'approve_done']);
// Accepting work speaks for a person: only under an act() action the
// connector declared 'ask', so it runs only once an admin switched it to auto.
const ASK_GATED_ACTIONS = new Set(['approve_done']);

const LINK_STATUS_MAX = 512;
const EXCHANGE_SETTINGS_MAX = 2048;
const FORM_MAX = 64 * 1024;
const ACK_MAX = 4096;
const ACKED_FAILURE_MS = 10_000;
const SHORT_CODE = /^[a-z0-9_]{1,40}$/;
// A pending id's only answer (D97): Slack's challenge, nothing that could carry markup.
const HANDSHAKE_ACK = /^[\x20-\x7e]{1,256}$/;
// Keys the HMAC an id with no answering pending row runs over the body, as a
// real verify() would (amendment 4): fresh per process, never used to check anything.
const DUMMY_HMAC_KEY = randomBytes(32);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Pending connections (D97).
const PENDING_TTL_MS = 3_600_000;
const PENDING_SWEEP_MS = 60_000;
const PREPARE_TIMEOUT_MS = 30_000;
const PREPARE_INPUT_MAX = 4096;
const START_INPUT_MAX = 256;
const AUTHORIZE_MAX = 5;
const MATCH_MAX = 8;
const MATCH_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MATCH_STR_MAX = 200;
const CREATE_URL_MAX = 8 * 1024;
const NOT_ACCEPTED = 'That was not accepted. Check it and try again.';
// exchange's coded NOT_OWNED (D42 addendum "start inputs"): this text, never the connector's.
const notOwnedText = (name) => `${name} created this app under a different owner than the organization you named. Delete that app on ${name} and start again.`;
const SETUP_EXPIRED = 'This setup has expired. Start again from Buddy.';
// Identity links (D98).
const JWKS_TTL_MS = 3_600_000;
const JWKS_REFETCH_MS = 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_MAX = 64 * 1024;
const ID_TOKEN_MAX = 16 * 1024;
const LINK_INVALID = 'This link is not valid. Start again from Buddy.';
const LINK_GONE = 'This link can no longer be used. Start again from Buddy.';
const LINK_FAILED = 'The provider did not confirm your account. Start again from Buddy.';
const LINK_UNAVAILABLE = 'The provider could not be reached. Try again in a minute from Buddy.';

const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// parseBody's result: a literal-like object only (a Promise, Map or class
// instance is refused, so a forgotten `async` can't slip through).
const isBareObject = (v) => isPlainObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const POISON_KEYS = ['__proto__', 'constructor', 'prototype'];
// A structured copy, or null when it can't be copied (a function, a symbol…).
const copyOf = (v) => { try { return structuredClone(v); } catch { return null; } };
// An https URL on one of `hosts`, no port or credentials; else null.
function urlOn(u, hosts) {
  let url;
  try { url = new URL(String(u)); } catch { return null; }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && hosts.includes(url.hostname) ? url : null;
}
// 'owner/name' (github.com) or 'host/owner/name' → canonical 'host/owner/name', else null.
function canonRepo(repo) {
  if (typeof repo !== 'string' || repo.length > 300 || !/^[A-Za-z0-9_./-]+$/.test(repo)) return null;
  return normalizeRemoteUrl(`https://${repo.split('/').length === 2 ? `github.com/${repo}` : repo}`);
}
// Only a link closed without merging frees the card's PR slot for relink(). A
// merged one is final: otherwise anyone with push access could open another PR
// from the board branch after the merge and take the done card's status. A
// closed one can be reopened, and if it is the card's verified PR, relink()
// takes the slot back for it.
const PR_ENDED = new Set(['closed']);
// {number, repo: canonical} from an https '<repo>/pull/<n>' URL, else null.
function prOfUrl(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  const at = u.lastIndexOf('/pull/');
  const number = prNumberOf(u);
  if (!/^https:\/\//i.test(u) || at === -1 || number == null) return null;
  const repo = normalizeRemoteUrl(u.slice(0, at));
  return repo ? { number, repo } : null;
}
const HEAD_SHA = /^[0-9a-f]{40}$/;
// A link's stored status: the card-face keys (cleanLinkStatus) plus the PR
// head_sha, which only the connector reads back (to drop a check suite for
// an older head); cardView never shows it.
function cleanStatus(v) {
  const out = cleanLinkStatus(v);
  if (isPlainObject(v) && typeof v.head_sha === 'string' && HEAD_SHA.test(v.head_sha)) out.head_sha = v.head_sha;
  return out;
}
const shortRepo = (canon) => (canon.startsWith('github.com/') ? canon.slice('github.com/'.length) : canon);
// ctx.hubUrl (D42 addendum C1): BOARD_PUBLIC_URL's origin when it is nothing
// more than an https origin (http only on loopback for a dev/local hub); else null.
function hubUrlOf(v, devHub) {
  if (typeof v !== 'string' || /[?#]/.test(v)) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password || u.pathname !== '/') return null;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && devHub && isLoopback(u.hostname.replace(/^\[|\]$/g, '')))) return u.origin;
  return null;
}

// An admin's settings.config value: JSON scalars, or lists and objects of
// them a few levels deep, never a prototype key.
function configValue(v, depth = 0) {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth >= CONFIG_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => x === null || configValue(x, depth + 1));
  return isBareObject(v) && Object.entries(v).every(([k, x]) => !POISON_KEYS.includes(k) && (x === null || configValue(x, depth + 1)));
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The member an integration acts as was removed or can no longer write:
 * retrying won't help. scope 'connection': connections.created_by (an admin
 * must reconnect); 'member': a linked member (that act only, D42 addendum C2).
 */
export class ActorUnavailable extends Error {
  constructor(scope = 'connection') {
    super('the member this integration acts as was removed or can no longer write');
    this.code = 'ACTOR_UNAVAILABLE';
    this.scope = scope === 'member' ? 'member' : 'connection';
  }
}

const tagged = (message, healthCode) => Object.assign(new Error(message), { healthCode });
const handlerEnded = () => new Error('this handler has ended');

// Health and audit keep a short code (members can read them), never provider text.
function errCode(e) {
  if (e instanceof ActorUnavailable) return 'actor_unavailable';
  if (e?.code === 'TIMEOUT') return 'handler_timeout';
  if (e?.healthCode) return e.healthCode;
  if (e instanceof HubError) return String(e.code).toLowerCase();
  return 'handler_failed';
}

function withTimeout(promise, ms, controller = null) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = Object.assign(new Error(`handler did not finish within ${ms} ms`), { code: 'TIMEOUT' });
      controller?.abort(e);
      reject(e);
    }, ms);
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
    else if (typeof x === 'string' && x.length <= AUDIT_STR_MAX && AUDIT_ID.test(x)) out[k] = x;
  }
  const s = JSON.stringify(out);
  return Buffer.byteLength(s) <= AUDIT_JSON_MAX ? s : JSON.stringify({ truncated: true });
}

// external_ref as the Activity list shows it: control, format (bidi) and
// line-separator characters can't reorder or hide what an admin reads.
function auditRef(v) {
  if (v == null) return null;
  const t = String(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, AUDIT_REF_MAX);
  return t || null;
}

export function createIntegrations({
  hub, api, bus = null, log, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), // privacy-flow: integrations-hub
  handlerTimeoutMs = HANDLER_TIMEOUT_MS, random = Math.random, publicUrl = null,
}) {
  // Read once: no setting, payload or request can move where links point.
  const hubUrl = hubUrlOf(publicUrl, ['dev', 'local'].includes(hub.config?.auth));
  const connectors = new Map();
  const ingress = new Map(); // provider → BlockList of its ingressCidrs
  const db = hub.db;
  const now = () => hub.iso();
  const inflight = new Map(); // consumer name → {seq, running}: the onEvent call still running after its timeout
  // consumer name → the seq whose timed-out call later succeeded: its retry
  // must not repeat the side effects.
  const lateOk = new Map();

  const warn = (msg, c, e) => log?.warn?.(msg, { integration: c?.provider ?? c?.id, connection_id: c?.id, err: redact(e?.message ?? e) });

  // ── connections ─────────────────────────────────────────────────────────

  const row = (id) => db.get('SELECT * FROM connections WHERE id = ?', id);
  const publicConnection = (c) => ({
    id: c.id, provider: c.provider, external_id: c.external_id, display_name: c.display_name,
    scopes: safeJson(c.scopes, []), status: c.status, health: safeJson(c.health, null),
    settings: safeJson(c.settings, {}), created_at: c.created_at,
    target_board_id: c.target_board_id ?? null,
  });
  const consumerName = (c) => `integration:${c.provider}:${c.id}`;

  // `pending` (D97): promote that pending row, which must be live, this
  // member's and have this id; its sealed rows are copied as they are.
  function createConnection({ orgId, memberId, provider, external_id, display_name, scopes = [], secrets = {}, settings = {}, id = randomUUID(), pending = null }) {
    const conn = connectors.get(provider);
    if (!conn) throw new HubError('VALIDATION', `unknown integration ${provider}`);
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    const ext = String(external_id ?? '');
    if (!ext || ext.length > 200) throw new HubError('VALIDATION', 'the provider did not name the workspace');
    if (!isPlainObject(secrets) || !isPlainObject(settings)) throw new HubError('VALIDATION', 'bad connection data');
    if (Object.entries(settings).some(([k, v]) => !INSERT_NAMESPACES.includes(k) || !isPlainObject(v))) throw new HubError('VALIDATION', 'bad connection settings');
    const stored = { ...settings };
    // provider (D42 addendum C1): what the provider said, every pinned key, and
    // the hub's own origin; written here, in the insert, and never again (026).
    if (settings.provider !== undefined || settings.pinned !== undefined) {
      const facts = exchangeConfig(Object.fromEntries(Object.entries(settings.provider ?? {}).filter(([k]) => k !== 'hub_url')));
      if (facts === null) throw new HubError('VALIDATION', `${conn.name} returned settings this hub will not store`);
      stored.provider = { ...facts, ...(settings.pinned ?? {}), ...(hubUrl ? { hub_url: hubUrl } : {}) };
      if (Buffer.byteLength(JSON.stringify(stored.provider)) > PROVIDER_MAX) throw new HubError('VALIDATION', `${conn.name} returned settings this hub will not store`);
    }
    for (const k of Object.keys(secrets)) if (!conn.secrets.includes(k)) throw new HubError('VALIDATION', `${provider} does not declare secret ${k}`);
    // Anything else would be sealed as its String() ("[object Object]"); the
    // message never carries the value, and nothing is written.
    for (const v of Object.values(secrets)) {
      if (typeof v !== 'string' || !v || Buffer.byteLength(v) > SECRET_MAX_BYTES) throw new HubError('VALIDATION', `${conn.name} returned a secret this hub will not store`);
    }
    hub.txn(() => {
      let copied = [];
      if (pending) {
        const p = livePending(id);
        if (!p || p.id !== pending.id || p.org_id !== orgId || p.provider !== provider || p.created_by !== memberId) throw new HubError('NOT_FOUND', SETUP_EXPIRED);
        // The callback checked the role before exchange() ran; it may have changed since.
        const m = db.get('SELECT org_id, role, removed_at FROM members WHERE id = ?', memberId);
        if (!m || m.removed_at || m.org_id !== orgId || !['owner', 'admin'].includes(m.role)) throw new HubError('NOT_FOUND', SETUP_EXPIRED);
        copied = db.all('SELECT kind, key_id, nonce, ciphertext FROM integration_pending_secrets WHERE pending_id = ?', id);
        if (copied.some((r) => Object.hasOwn(secrets, r.kind))) throw new HubError('VALIDATION', 'Could not save the connection.');
      }
      // Unique per org among live rows (partial index); revoked rows stay for
      // their audit history. A workspaceUnique provider (one install per
      // workspace) is unique across every org, with the same answer, so the
      // message never tells another team that workspace is taken elsewhere.
      const clash = conn.workspaceUnique
        ? db.get("SELECT id FROM connections WHERE provider = ? AND external_id = ? AND status != 'revoked'", provider, ext)
        : db.get("SELECT id FROM connections WHERE org_id = ? AND provider = ? AND external_id = ? AND status != 'revoked'", orgId, provider, ext);
      if (clash) {
        throw new HubError('CONFLICT', `this ${conn.name} is already connected`);
      }
      // First: connection_id_not_pending aborts the insert while the row exists.
      if (pending) db.run('DELETE FROM integration_pending WHERE id = ?', id);
      db.insert('connections', {
        id, org_id: orgId, provider, external_id: ext, display_name: display_name == null ? null : String(display_name).slice(0, 200),
        scopes: JSON.stringify(Array.isArray(scopes) ? scopes.map(String) : []), status: 'active', settings: JSON.stringify(stored), created_by: memberId, created_at: now(),
        target_board_id: db.get('SELECT id FROM boards WHERE org_id = ? AND archived_at IS NULL ORDER BY rowid LIMIT 1', orgId)?.id ?? null,
      });
      // Their AAD is `<id>|<kind>|<key_id>` already: they open here and nowhere else.
      for (const r of copied) db.insert('connection_secrets', { connection_id: id, kind: r.kind, key_id: r.key_id, nonce: r.nonce, ciphertext: r.ciphertext, created_at: now() });
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
    for (const r of db.all('SELECT * FROM connection_secrets WHERE connection_id = ?', c.id)) {
      out[r.kind] = hub.vault.open(c.id, r.kind, r);
      if (hub.vault.stale(r)) {
        const s = hub.vault.seal(c.id, r.kind, out[r.kind]);
        db.run('UPDATE connection_secrets SET key_id = ?, nonce = ?, ciphertext = ? WHERE connection_id = ? AND kind = ? AND key_id = ?', s.key_id, s.nonce, s.ciphertext, c.id, r.kind, r.key_id);
      }
    }
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
        const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const res = await fetchImpl(url.href, { ...opts, redirect: 'manual', signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout }); // privacy-flow: integrations-hub
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

  function ctxFor(c, signal = null) {
    const conn = connectors.get(c.provider);
    const settings = safeJson(c.settings, {});
    const secrets = () => secretsOf(c);
    const fetchOnce = restrictedFetch(conn);

    // Retries with backoff on network errors, 5xx and 429 (honouring Retry-After);
    // records health. Never logs bodies or headers.
    async function retryingFetch(url, init = {}) {
      if (signal?.aborted) throw handlerEnded();
      let last;
      if (signal && !init.signal) init = { ...init, signal };
      for (let i = 0; i < FETCH_TRIES; i += 1) {
        if (init.signal?.aborted) throw init.signal.reason;
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

    // D98: the member a provider user acts as, linked on this connection, of
    // its team and able to write; else null (a viewer acts as nobody). Only
    // while the connection is active, re-read: a ctx can outlive a pause.
    function memberFor(subject) {
      if (typeof subject !== 'string' || !subject || subject.length > SUBJECT_MAX) return null;
      if (db.get('SELECT status FROM connections WHERE id = ?', c.id)?.status !== 'active') return null;
      const l = db.get('SELECT member_id FROM external_identities WHERE connection_id = ? AND subject = ?', c.id, subject);
      const m = l && hub.member(l.member_id);
      return m && m.org_id === c.org_id && !m.removed_at && hub.canWrite(m) ? m.id : null;
    }
    // The member a subject is linked to on this connection, whatever their state.
    const linkedMember = (subject) => (typeof subject === 'string' && subject && subject.length <= SUBJECT_MAX
      ? db.get('SELECT member_id FROM external_identities WHERE connection_id = ? AND subject = ?', c.id, subject)?.member_id ?? null
      : null);
    // C2: what a connector may tell the user, never who the member is.
    const linkState = (subject) => {
      if (!linkedMember(subject)) return 'none';
      return memberFor(subject) ? 'active' : 'unavailable';
    };
    const scopeOf = (memberId) => (memberId === c.created_by ? 'connection' : 'member');
    // …and back, for reaching a member (a viewer too) on the provider.
    function subjectFor(memberId) {
      const l = typeof memberId === 'string' ? db.get('SELECT subject FROM external_identities WHERE connection_id = ? AND member_id = ?', c.id, memberId) : null;
      const m = l && hub.member(memberId);
      return m && m.org_id === c.org_id && !m.removed_at ? l.subject : null;
    }

    // Re-read on every call: a handle must not outlive a removal or demotion.
    function actor(memberId) {
      const m = hub.member(memberId);
      if (!m || m.org_id !== c.org_id) throw new HubError('FORBIDDEN', 'this integration may not act as that member');
      if (m.removed_at || !hub.canWrite(m)) throw new ActorUnavailable(scopeOf(memberId));
      // Admin rights never pass to a tool (Api uses role for "involved" checks).
      return hub.isAdmin(m) ? { ...m, role: 'member' } : m;
    }

    // The member an integration acts as goes through the same Api methods
    // and D8 replay cache as a browser would (limits per connection); the
    // journal and feed name the integration (D42, §15). `live()` is the
    // act() scope: every call on the handle checks it, so a stashed handle
    // is dead once run() returns.
    // A budget lets a card spend more once a person gives it to Claude: that
    // stays a person's call. via:<provider> shows where the card came from
    // (to people and, in its envelope source, to the agent); a connector
    // can't claim another provider.
    const cardBody = (body) => {
      const via = `via:${conn.id}`;
      const labels = Array.isArray(body.labels) ? [...body.labels.filter((l) => !(typeof l === 'string' && l.startsWith('via:'))), via] : (body.labels ?? [via]);
      // Nor a column: a card from outside starts in todo, like a person's.
      return { ...body, budget_usd: undefined, column: undefined, column_name: undefined, labels };
    };

    function actAs(memberId, { live, action: actName, track, external_ref, subjectKey, subject = null }) {
      // An act() for a provider user acts only as that user's linked member,
      // never as whoever connected the tool; one without a subject only as
      // the member who connected it, never as some other linked member.
      // Checked again on every call.
      const bound = () => {
        const forbidden = () => new HubError('FORBIDDEN', 'this integration may not act as that member');
        if (subject == null) {
          if (memberId !== c.created_by) throw forbidden();
          return;
        }
        if (memberFor(subject) === memberId) return;
        // Still that subject's member (or its link went with the member's
        // removal, 023), who can't act now: unavailable, not someone else.
        const m = typeof memberId === 'string' ? hub.member(memberId) : null;
        const linked = linkedMember(subject);
        if (m && m.org_id === c.org_id && (m.removed_at || !hub.canWrite(m)) && (linked === memberId || (linked == null && m.removed_at))) {
          throw new ActorUnavailable(scopeOf(memberId));
        }
        throw forbidden();
      };
      bound();
      const first = actor(memberId);
      const via = { connection_id: c.id, member_id: first.id, name: conn.name, external_ref };
      const call = (body, fn, rules = [], pre = null) => {
        if (!live()) return Promise.reject(new Error('this act() scope has ended'));
        return track(callLive(body, fn, rules, pre));
      };
      const callLive = async (body, fn, rules, pre) => {
        bound();
        const member = actor(first.id);
        // Required so a handler retried after a timeout replays instead of acting twice (D8).
        if (typeof body?.request_id !== 'string' || !body.request_id) throw new HubError('VALIDATION', 'request_id required');
        // Never cut: two ids sharing 200 chars would be one request (integration_requests).
        if (body.request_id.length > REQUEST_ID_MAX) throw new HubError('VALIDATION', `request_id is at most ${REQUEST_ID_MAX} chars`);
        // Namespaced per connection: never collides with the member's own browser request ids.
        const rid = `int:${c.id}:${body.request_id}`;
        const hit = hub.cachedResponse(member.id, rid);
        if (hit) {
          if (hit.status >= 400) { const { code, message, ...extra } = hit.body.error; throw new HubError(code, message, extra); }
          return hit.body;
        }
        const cacheError = (e) => { if (e instanceof HubError) hub.cacheResponse(member.id, rid, httpStatus(e.code), { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } }); };
        try { pre?.(); } catch (e) { cacheError(e); throw e; }
        // The connection's own buckets, never mutate_member: a public source
        // (any Slack user, issues on a public repo) must not 429 the person's own browser.
        limitOrThrow(hub, 'integration_conn', c.id);
        for (const [rule, key] of typeof rules === 'function' ? rules() : rules) limitOrThrow(hub, rule, key);
        let out;
        try {
          out = await hub.actVia(via, () => fn(member));
        } catch (e) {
          cacheError(e);
          throw e;
        }
        hub.cacheResponse(member.id, rid, 200, out);
        return out;
      };
      // A board of another team (or none) is the Api's own NOT_FOUND, but
      // before any rate token: probing board ids must not drain the budget.
      // The provider user's bucket first: one past it spends none of the
      // connection's, so a single user can't use up everyone's cards.
      const cardRules = [...(subjectKey ? [['integration_card_subject', subjectKey]] : []), ['integration_card_conn', c.id]];
      const boardOfOrg = (boardId) => () => {
        if (typeof boardId !== 'string' || hub.board(boardId)?.org_id !== c.org_id) throw new HubError('NOT_FOUND', 'board not found');
      };
      return {
        member: { id: first.id, role: first.role },
        // A D8 replay answers with the first card whatever board it names: the
        // same request on another board is a conflict, not that card.
        // A request that already made its card (integration_requests) spends no
        // card token: a repeat can't probe or drain a bucket (C2, F-2).
        createCard: (boardId, body = {}) => call(body, (m) => api.createCard(m, boardId, cardBody(body)),
          () => (db.get('SELECT 1 AS x FROM integration_requests WHERE connection_id = ? AND request_id = ?', c.id, body.request_id) ? [] : cardRules), boardOfOrg(boardId)).then((out) => {
          const on = hub.card(out?.card?.id)?.board_id;
          if (on != null && on !== boardId) throw new HubError('CONFLICT', 'this request_id already created a card on another board');
          return out;
        }),
        comment: (cardId, body = {}) => {
          if (body.for_agent === true) throw new HubError('POLICY_DENIED', 'an integration never writes to the agent');
          return call(body, (m) => api.comment(m, cardId, { ...body, for_agent: false }));
        },
        action: (cardId, action, body = {}) => {
          if (!ALLOWED_ACTIONS.has(action)) throw new HubError('POLICY_DENIED', 'an integration may only cancel, stop or approve; a person does the rest from the card');
          if (ASK_GATED_ACTIONS.has(action) && conn.actions[actName]?.default !== 'ask') {
            throw new HubError('POLICY_DENIED', `${action} needs an action declared 'ask', switched to auto by an admin`);
          }
          return call(body, (m) => api.action(m, cardId, action, body));
        },
        answerPermission: () => { throw new HubError('POLICY_DENIED', 'an integration never answers a permission request'); },
      };
    }

    /**
     * The only way a PR finds its card. `repo` ('owner/name' on github.com, or
     * 'host/owner/name') and `branch` come from a payload any PR author
     * controls, forks included, so nothing is parsed out of them: the branch
     * must equal a branch the board recorded for a run (runs.branch, from
     * fence.js branchName) in that repo, on a board of this connection's org,
     * linked to that repo. Anything ambiguous is null.
     */
    function cardForBranch(repo, branch) {
      if (typeof branch !== 'string' || !branch || branch.length > BRANCH_MAX || BRANCH_BAD.test(branch)) return null;
      const canon = canonRepo(repo);
      if (!canon) return null;
      const repoIds = db.all(`SELECT DISTINCT r.id AS repo_id, r.canonical_url, r.aliases FROM repos r
        JOIN board_repos br ON br.repo_id = r.id JOIN boards b ON b.id = br.board_id WHERE b.org_id = ? AND r.org_id = ?`, c.org_id, c.org_id)
        .filter((r) => matchRepo(`https://${canon}`, [{ ...r, aliases: safeJson(r.aliases, []) }]))
        .map((r) => r.repo_id);
      if (!repoIds.length) return null;
      const inRepos = repoIds.map(() => '?').join(',');
      // card id → the base branch its run recorded (a PR into any other base is not the card's).
      const found = new Map(db.all(`SELECT cards.id, runs.base_ref FROM runs JOIN cards ON cards.id = runs.card_id JOIN boards ON boards.id = cards.board_id
        WHERE runs.branch = ? AND boards.org_id = ? AND runs.repo_id IN (${inRepos})`, branch, c.org_id, ...repoIds).map((r) => [r.id, r.base_ref]));
      // Extension point for self-driven (auto-tracked) cards, owned by that
      // work: a branch a card claims without a run. Consulted only once such a
      // column exists; the same exact-match, same-org, same-repo rules apply.
      if (db.get("SELECT 1 AS x FROM pragma_table_info('cards') WHERE name = 'self_driven_branch'")) {
        for (const r of db.all(`SELECT cards.id, COALESCE(cards.base_ref, repos.default_branch) AS base_ref FROM cards JOIN boards ON boards.id = cards.board_id
          JOIN repos ON repos.id = cards.repo_id WHERE cards.self_driven_branch = ? AND boards.org_id = ? AND cards.repo_id IN (${inRepos})`, branch, c.org_id, ...repoIds)) {
          if (!found.has(r.id)) found.set(r.id, r.base_ref);
        }
      }
      if (found.size !== 1) return null;
      const [[cardId, baseRef]] = found;
      return { card_id: cardId, base_ref: baseRef ?? null };
    }

    const cardInOrg = (cardId) => {
      const card = cardId ? hub.card(cardId) : null;
      return card && hub.board(card.board_id)?.org_id === c.org_id ? card : null;
    };
    const writableCard = (cardId) => {
      const card = cardInOrg(cardId);
      if (!card) throw new HubError('NOT_FOUND', 'card not found');
      api.writableBoard(card.board_id);
    };

    // The newest link of `kind` this connection has on a card of its org.
    const linkedByCard = (cardId, kind) => (cardInOrg(cardId)
      ? db.get('SELECT external_id FROM external_links WHERE connection_id = ? AND card_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id, cardId, String(kind))?.external_id ?? null
      : null);

    // The newest link of `kind` this connection has on a card of its org, with
    // its stored status: {external_id, state?, checks?, review?, head_sha?} | null.
    function linkStatusFor(cardId, kind) {
      if (!cardInOrg(cardId)) return null;
      const l = db.get('SELECT external_id, status FROM external_links WHERE connection_id = ? AND card_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id, cardId, String(kind));
      return l ? { external_id: l.external_id, ...cleanStatus(safeJson(l.status, null)) } : null;
    }

    /**
     * The card's newest hub_verified PR evidence (what the merge poll acts
     * on): {number, repo, url} | null. The number is the one the hub checked;
     * `repo` ('owner/name' on github.com, else 'host/owner/name') and `url`
     * come from the card's repo on the hub, never from the runner's text.
     */
    function verifiedPr(cardId) {
      const card = cardInOrg(cardId);
      if (!card) return null;
      const ref = String(db.get("SELECT ref FROM evidence WHERE card_id = ? AND kind = 'pr' AND verification = 'hub_verified' ORDER BY created_at DESC, rowid DESC LIMIT 1", cardId)?.ref ?? '').trim();
      const number = prNumberOf(ref);
      const canon = hub.repo(card.repo_id)?.canonical_url;
      if (number == null || !canon) return null;
      return { number, repo: shortRepo(canon), url: `https://${canon}/pull/${number}` };
    }

    // Why PR `prN` in `repo` is not the card's verified PR, or null when it is.
    function notVerified(cardId, prN, repo) {
      const v = verifiedPr(cardId);
      if (!v) return 'no_verified_pr';
      if (prN !== v.number) return 'not_the_verified_pr';
      // v.repo is the card's own repo row, never one of its aliases (an alias
      // may be another GitHub repo, a mirror where anyone can open a PR #12).
      const want = canonRepo(v.repo);
      if (!want || canonRepo(repo) !== want) return 'not_the_verified_pr';
      return null;
    }

    // Once the hub verified the card's PR, its pr slot takes only that PR,
    // named by `url` (number and repo; the external id is never read, it
    // could be anything): the one rule for link() and relink().
    const slotTakes = (cardId, url) => {
      if (!verifiedPr(cardId)) return true;
      const pr = prOfUrl(url);
      return !!pr && !notVerified(cardId, pr.number, pr.repo);
    };

    function link(cardId, kind, externalId, url = null) {
      writableCard(cardId);
      if (!cardInOrg(cardId)) throw new HubError('NOT_FOUND', 'card not found');
      // One PR per card per connection: a second one (a decoy from the same
      // branch into another base) must not become a handle on the card.
      if (String(kind) === 'pr') {
        const have = linkedByCard(cardId, 'pr');
        if (have === String(externalId)) return;
        if (!slotTakes(cardId, url)) throw new HubError('CONFLICT', 'only the card\'s verified PR may be linked');
        if (have != null) throw new HubError('CONFLICT', 'this card already has a PR linked from this integration');
      }
      db.run('INSERT OR IGNORE INTO external_links (card_id, connection_id, kind, external_id, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        cardId, c.id, String(kind), String(externalId), url == null ? null : String(url).slice(0, 500), now());
    }

    /**
     * Swap the card's one pr link from `oldExternalId` to `newExternalId`:
     * once the card has a verified PR, only to it (slotTakes); before that,
     * only off a link whose state is one of PR_ENDED. The old row stays, as
     * kind 'pr_superseded', with its status.
     */
    function relink(cardId, kind, oldExternalId, newExternalId, url = null) {
      writableCard(cardId);
      if (!cardInOrg(cardId)) throw new HubError('NOT_FOUND', 'card not found');
      if (String(kind) !== 'pr') throw new HubError('VALIDATION', 'only a pr link is relinked');
      const from = String(oldExternalId);
      const to = String(newExternalId);
      const changed = hub.txn(() => {
        const have = linkedByCard(cardId, 'pr');
        if (have === to) return false;
        if (have == null) throw new HubError('NOT_FOUND', 'this integration has no PR linked on that card');
        if (have !== from) throw new HubError('CONFLICT', 'the card\'s PR link is not that one');
        if (db.get("SELECT 1 AS x FROM external_links WHERE connection_id = ? AND kind = 'pr' AND external_id = ?", c.id, to)) {
          throw new HubError('CONFLICT', 'that PR is linked to another card');
        }
        const old = db.get("SELECT status FROM external_links WHERE connection_id = ? AND kind = 'pr' AND external_id = ? AND card_id = ?", c.id, from, cardId);
        if (verifiedPr(cardId)) {
          if (!slotTakes(cardId, url)) throw new HubError('CONFLICT', 'only the card\'s verified PR may be linked');
        } else if (!PR_ENDED.has(cleanLinkStatus(safeJson(old.status, null)).state)) {
          throw new HubError('CONFLICT', 'the linked PR has not ended and the card has no verified PR');
        }
        // One superseded row per external id: a PR relinked away twice keeps its latest.
        db.run("DELETE FROM external_links WHERE connection_id = ? AND kind = 'pr_superseded' AND external_id = ?", c.id, from);
        db.run("UPDATE external_links SET kind = 'pr_superseded' WHERE connection_id = ? AND kind = 'pr' AND external_id = ? AND card_id = ?", c.id, from, cardId);
        db.run("INSERT INTO external_links (card_id, connection_id, kind, external_id, url, created_at) VALUES (?, ?, 'pr', ?, ?, ?)",
          cardId, c.id, to, url == null ? null : String(url).slice(0, 500), now());
        return true;
      });
      if (changed) hub.later(() => hub.broadcastCard(cardId));
    }

    // Partial updates merge: a PR event knows the state, a check suite the
    // checks, a review the review; none may clobber the others.
    function linkStatus(cardId, kind, externalId, patch) {
      writableCard(cardId);
      if (!cardInOrg(cardId)) throw new HubError('NOT_FOUND', 'card not found');
      const link = db.get('SELECT status FROM external_links WHERE connection_id = ? AND kind = ? AND external_id = ? AND card_id = ?', c.id, String(kind), String(externalId), cardId);
      if (!link) throw new HubError('NOT_FOUND', 'this integration has no such link on that card');
      const next = cleanStatus(patch);
      if (!Object.keys(next).length) throw new HubError('VALIDATION', 'no valid status field');
      const merged = JSON.stringify({ ...cleanStatus(safeJson(link.status, null)), ...next });
      if (Buffer.byteLength(merged) > LINK_STATUS_MAX) throw new HubError('VALIDATION', 'status over 512 bytes');
      db.run('UPDATE external_links SET status = ? WHERE connection_id = ? AND kind = ? AND external_id = ?', merged, c.id, String(kind), String(externalId));
      hub.later(() => hub.broadcastCard(cardId));
    }

    function autonomyOf(action) {
      if (!Object.hasOwn(conn.actions, action)) throw new Error(`${conn.id} did not declare action ${action}`);
      const def = conn.actions[action].default;
      // Read fresh: an admin's change applies to the very next action.
      const set = safeJson(row(c.id)?.settings, {})?.autonomy?.[action];
      return AUTONOMY.includes(set) ? set : def;
    }

    /**
     * act(action, {card_id?, external_ref?, detail?, undo?, subject?}, run(scope)) — the
     * autonomy gate and the only way to act. 'auto' writes an 'attempted'
     * audit row, runs, then marks it 'auto' or 'failed' (+ code); 'ask'
     * records a suggestion and does not run; 'off' skips. `scope`
     * ({actAs, link, relink, linkStatus}) and every handle actAs returns work only while run()
     * is running and the handler's signal has not aborted.
     */
    async function act(action, meta, run) {
      if (signal?.aborted) throw handlerEnded();
      const subject = meta?.subject;
      if (subject != null && (typeof subject !== 'string' || !subject || subject.length > SUBJECT_MAX)) {
        throw new HubError('VALIDATION', `subject is a provider user id of at most ${SUBJECT_MAX} characters`);
      }
      // Keyed hash only (hub.refHash): the provider user id is never kept or logged.
      const subjectKey = subject ? `${c.id}|${hub.refHash(subject)}` : null;
      const mode = autonomyOf(action);
      const base = {
        connection_id: c.id, action, card_id: cardInOrg(meta?.card_id)?.id ?? null,
        external_ref: auditRef(meta?.external_ref),
        detail: auditJson(meta?.detail) ?? '{}', undo: auditJson(meta?.undo),
      };
      const audit = (decision, error = null) => { const id = randomUUID(); db.insert('integration_audit', { id, ...base, decision, error, at: now() }); return id; };
      // An archived card is read-only until a person restores it (D94): never applied, and never auto-restored.
      const skippedArchived = () => ({ done: false, decision: 'skipped', reason: 'archived' });
      if (base.card_id && hub.card(base.card_id)?.archived_at) { audit('skipped', 'archived'); return skippedArchived(); }
      if (mode === 'off') { audit('skipped'); return { done: false, decision: 'skipped' }; }
      if (mode === 'ask') { audit('asked'); return { done: false, decision: 'asked' }; }
      const auditId = audit('attempted');
      let open = true;
      const live = () => open && !signal?.aborted;
      const guard = (fn) => (...args) => { if (!live()) throw new Error('this act() scope has ended'); return fn(...args); };
      // Calls run() started without awaiting: settled before the scope closes,
      // so none of them lands on the board after act() returned.
      const pending = new Set();
      const track = (p) => { pending.add(p); return p; };
      const scope = {
        actAs: guard((memberId) => actAs(memberId, { live, action, track, external_ref: base.external_ref, subjectKey, subject: subject ?? null })), link: guard(link), relink: guard(relink), linkStatus: guard(linkStatus),
      };
      let decision = 'failed';
      let error = 'handler_failed';
      try {
        let out;
        try {
          out = await run(scope);
        } finally {
          open = false;
        }
        for (const r of await Promise.allSettled(pending)) if (r.status === 'rejected') throw r.reason;
        decision = 'auto';
        error = null;
        return { done: true, decision: 'auto', result: out };
      } catch (e) {
        if (e instanceof HubError && e.extra?.reason === 'ARCHIVED') {
          decision = 'skipped';
          error = 'archived';
          return skippedArchived();
        }
        error = errCode(e);
        throw e;
      } finally {
        open = false;
        db.run('UPDATE integration_audit SET decision = ?, error = ? WHERE id = ?', decision, error, auditId);
      }
    }

    /**
     * Raise a state-machine fact as the integration (D42): `type` must be one
     * the connector declared; the card comes only from this connection's own
     * link. Applied like the merge poll, audited in the same transaction.
     * Never call it from inside a withBoard callback on the same board.
     */
    async function systemEvent(type, { kind, external_id, pr = null, by = null, repo = null, external_ref = null }) {
      if (signal?.aborted) throw handlerEnded();
      if (!conn.systemEvents.includes(type)) throw new Error(`${conn.id} may not raise ${type}`);
      const prN = Number.isSafeInteger(pr) && pr > 0 ? pr : null;
      const byLogin = typeof by === 'string' && GITHUB_LOGIN.test(by) ? by : null;
      const cardId = db.get('SELECT card_id FROM external_links WHERE connection_id = ? AND kind = ? AND external_id = ?', c.id, String(kind), String(external_id))?.card_id;
      const card = cardInOrg(cardId);
      if (!card) return { done: false, reason: 'not linked' };
      if (hub.inBoard(card.board_id)) throw new Error('ctx.system.event was called inside the board queue of its own card (it would deadlock)');
      const action = `system.${type}`;
      const mode = autonomyOf(action);
      const audit = (decision, error = null) => db.insert('integration_audit', {
        id: randomUUID(), connection_id: c.id, action, decision, error, card_id: card.id,
        external_ref: auditRef(external_ref ?? external_id), detail: JSON.stringify({ pr: prN }), undo: null, at: now(),
      });
      // Bound to the PR the hub verified, like the merge poll: any other PR
      // from the card's branch (another base, a decoy closed unmerged) is not
      // the card's review.
      if (card.archived_at || hub.board(card.board_id)?.archived_at) { audit('skipped', 'archived'); return { done: false, decision: 'skipped', reason: 'archived' }; }
      const refusal = () => notVerified(card.id, prN, repo);
      const refused = refusal();
      if (refused) { audit('failed', refused); return { done: false, reason: refused }; }
      if (mode !== 'auto') { audit(mode === 'ask' ? 'asked' : 'skipped'); return { done: false, decision: mode === 'ask' ? 'asked' : 'skipped' }; }
      const via = { connection_id: c.id, member_id: null, name: conn.name };
      // hub.txn (not db.tx): the outermost transaction flushes apply()'s
      // after-commit work (broadcasts, notifies, the bus poke).
      return hub.withBoard(card.board_id, () => hub.actVia(via, () => hub.txn(() => {
        // Evidence may have changed while this waited on the board queue.
        const late = refusal();
        if (late) { audit('failed', late); return { done: false, reason: late }; }
        if (hub.card(card.id).archived_at || hub.board(card.board_id)?.archived_at) { audit('skipped', 'archived'); return { done: false, decision: 'skipped', reason: 'archived' }; }
        const r = hub.apply(card.id, { type, pr: prN, by: byLogin }, { actor: c.id });
        if (!r.ok) return { done: false, reason: r.error.code };
        audit('auto');
        return { done: true, decision: 'auto', to: r.to };
      })));
    }

    const ctx = {
      connection: { id: c.id, org_id: c.org_id, external_id: c.external_id, settings, created_by: c.created_by, target_board_id: c.target_board_id ?? null },
      system: conn.systemEvents.length ? { event: systemEvent } : null,
      secret: (kind) => secrets()[kind] ?? null,
      fetch: retryingFetch,
      act,
      autonomyOf,
      signal,
      // A pure read (writes nothing, links nothing), so it lives on ctx, not
      // in an act() scope: the handler links what it finds inside act().
      cardForBranch,
      verifiedPr,
      memberFor,
      subjectFor,
      linkState,
      linkedByCard,
      linkStatusFor,
      linked: (kind, externalId) => db.get('SELECT card_id FROM external_links WHERE connection_id = ? AND kind = ? AND external_id = ?', c.id, String(kind), String(externalId))?.card_id ?? null,
      // Existing connectors taking boardIds()[0] respect this connection's
      // selected target. An archived target pauses intake; never reroute it.
      boardIds: () => {
        const current = row(c.id);
        if (!current || current.status !== 'active') return [];
        const ids = db.all('SELECT id FROM boards WHERE org_id = ? AND archived_at IS NULL ORDER BY rowid', c.org_id).map((b) => b.id);
        if (current.target_board_id == null) return ids;
        return ids.includes(current.target_board_id) ? [current.target_board_id, ...ids.filter((id) => id !== current.target_board_id)] : [];
      },
      // What a chat picker shows: never settings, repos or anything secret.
      boards: () => db.all(`SELECT b.id, b.name FROM boards b JOIN orgs o ON o.id = b.org_id
        WHERE b.org_id = ? AND o.deleted_at IS NULL AND b.archived_at IS NULL ORDER BY b.name, b.id LIMIT ${BOARDS_MAX}`, c.org_id).map((b) => ({ id: b.id, title: b.name })),
      // A card's face only: never its body, acceptance, labels or budget,
      // which a connector would otherwise echo into a shared channel.
      card: (cardId) => {
        const card = typeof cardId === 'string' ? cardInOrg(cardId) : null;
        return card ? { id: card.id, key: card.key, title: card.title, board_id: card.board_id, column_name: card.column_name } : null;
      },
      log: (msg, extra = {}) => log?.info?.(msg, { integration: c.provider, connection_id: c.id, ...extra }),
    };
    // The only base for a link to the hub; a handler can't repoint it for later calls.
    Object.defineProperty(ctx, 'hubUrl', { value: hubUrl, enumerable: true, writable: false, configurable: false });
    return ctx;
  }

  // ── inbound webhooks ────────────────────────────────────────────────────

  function sweepDedupe() {
    sweepPending();
    db.run('DELETE FROM inbound_dedupe WHERE received_at < ?', new Date(hub.wallMs() - DEDUPE_KEEP_MS).toISOString());
    db.run('DELETE FROM integration_audit WHERE at < ?', new Date(hub.wallMs() - AUDIT_KEEP_MS).toISOString());
  }

  /**
   * Lease a delivery under all its keys: → {ok:true, until} (we run it),
   * {dup:'done'} when any key is done, {dup:'busy', until} when any is leased.
   * A lease that outlived its handler (crash, hang) is taken over.
   */
  function reserve(provider, keys) {
    if (random() < 0.01) sweepDedupe();
    const t = now();
    const until = new Date(hub.wallMs() + handlerTimeoutMs + 30_000).toISOString();
    return db.tx(() => {
      const rows = keys.map((k) => db.get('SELECT state, lease_until FROM inbound_dedupe WHERE provider = ? AND dedupe_key = ?', provider, k));
      if (rows.some((r) => r?.state === 'done')) return { dup: 'done' };
      const busy = rows.filter((r) => r && !(r.lease_until < t)).map((r) => r.lease_until).sort();
      if (busy.length) return { dup: 'busy', until: busy.at(-1) };
      for (const k of keys) {
        db.run(`INSERT INTO inbound_dedupe (provider, dedupe_key, received_at, state, lease_until) VALUES (?, ?, ?, 'processing', ?)
          ON CONFLICT (provider, dedupe_key) DO UPDATE SET received_at = excluded.received_at, lease_until = excluded.lease_until`, provider, k, t, until);
      }
      return { ok: true, until };
    });
  }

  /** A client address inside the connector's declared ingressCidrs (the provider's own senders). */
  function trustedIngress(connectionId, ip) {
    const list = ingress.get(row(connectionId)?.provider);
    const a = String(ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    const family = isIP(a);
    return !!(list && family && list.check(a, family === 4 ? 'ipv4' : 'ipv6'));
  }

  /**
   * The HTTP layer asks this before reading a body: true only for a live
   * connection. Any other id (unknown, inactive, revoked, pending) is read
   * under the same caps and gets webhook()'s one 404, so its failures are
   * counted per client address, not per id (D97, amendment 4).
   */
  function webhookTarget(connectionId) {
    const c = row(connectionId);
    return !!(c && c.status === 'active' && connectors.get(c.provider)?.handleWebhook);
  }

  /**
   * → {status, body, headers?, verified?, live?}. Never echoes why a signature failed to the
   * caller. `verified`: the signature checked out and the delivery was new to
   * this hub (the HTTP layer trusts that sender's network a little more).
   * `live`: answered as a live connection (the id may have been promoted or
   * revoked since the HTTP layer asked webhookTarget()).
   */
  async function webhook(connectionId, { headers, rawBody }) {
    const c = row(connectionId);
    const conn = c && connectors.get(c.provider);
    if (!c || c.status !== 'active' || !conn?.handleWebhook) return pendingWebhook(connectionId, { headers, rawBody });
    if (rawBody.length > MAX_BODY) return { status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'too large' } }, live: true };
    // A key problem is the hub's, not the caller's: 500, and no failure spent.
    let secrets;
    try { secrets = secretsOf(c); } catch (e) {
      // Recorded once a minute per connection: a broken key must not turn
      // every delivery (anyone can post one) into a DB write and a log line.
      if (hub.limiter.take('vault_health_conn', c.id).ok) {
        setHealth(c.id, false, 'vault_error');
        warn('integration secrets could not be opened', c, e);
      }
      return { status: 500, body: { error: { code: 'INTERNAL', message: 'internal error' } }, live: true };
    }
    let v;
    try { v = conn.verify({ headers, rawBody, secrets, now: Date.now() }); } catch (e) { v = { ok: false, reason: e.message }; }
    if (!v?.ok || !v.dedupe_key) {
      log?.warn?.('integration webhook rejected', { integration: c.provider, connection_id: c.id, reason: redact(v?.reason ?? 'no dedupe key') });
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'bad signature' } }, live: true };
    }
    const out = await verifiedWebhook(c, conn, { headers, rawBody, v });
    // Only a delivery that took a fresh lease vets its sender: anyone holding
    // a captured signed request can replay it as a duplicate.
    return { ...out, verified: !out.body?.duplicate && !out.body?.in_progress, live: true };
  }

  const webhookNotFound = () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } });

  /**
   * Any id that is not a live connection (D97, slice B3). A ready pending row
   * of a handshake connector answers exactly one delivery, its verified
   * handshake, with ackBody's short string; nothing else is done for it (no
   * lease, rate token, audit, log or promotion). Everything else, and every
   * error, is the unknown-connection 404. Every path takes the same pending
   * lookup and an HMAC over the body (equal status, bytes and buckets; no
   * timing claim, D97).
   */
  function pendingWebhook(id, { headers, rawBody }) {
    // Paid by every path, before anything can return early (a ready row's
    // verify() may refuse a missing timestamp without hashing the body).
    createHmac('sha256', DUMMY_HMAC_KEY).update(rawBody).digest();
    const p = livePending(id);
    const conn = p && p.match !== '{}' && rawBody.length <= MAX_BODY ? connectors.get(p.provider) : null;
    let secrets = null;
    if (conn?.connect?.handshake) {
      try { secrets = pendingSecretsOf(p.id); } catch { secrets = null; }
    }
    if (!secrets || !Object.keys(secrets).length) return webhookNotFound();
    try {
      if (conn.verify({ headers, rawBody, secrets, now: Date.now() })?.ok !== true) return webhookNotFound();
      const payload = conn.parseBody ? conn.parseBody({ rawBody, headers }) : JSON.parse(rawBody.toString('utf8'));
      if (!isBareObject(payload) || POISON_KEYS.some((k) => Object.hasOwn(payload, k))) return webhookNotFound();
      if (conn.connect.handshake({ payload, headers }) !== true) return webhookNotFound();
      const ack = conn.ackBody({ payload, headers });
      return typeof ack === 'string' && HANDSHAKE_ACK.test(ack) ? { status: 200, raw: ack, type: 'text/plain; charset=utf-8' } : webhookNotFound();
    } catch {
      return webhookNotFound();
    }
  }

  async function verifiedWebhook(c, conn, { headers, rawBody, v }) {
    // The connector's key alone may rest on an unsigned delivery header: the
    // hash of the signed body is a second key, so a captured request replayed
    // under a new delivery id is still a duplicate. Taken before parseBody,
    // which then can't change it.
    const keys = [`${c.id}:${String(v.dedupe_key).slice(0, 200)}`, `${c.id}:body:${createHash('sha256').update(rawBody).digest('hex')}`];
    let payload;
    if (conn.parseBody) {
      // Connector code sees only a body whose signature verify() checked.
      try { payload = conn.parseBody({ rawBody, headers }); } catch { payload = undefined; }
      if (!isBareObject(payload) || POISON_KEYS.some((k) => Object.hasOwn(payload, k))) return { status: 400, body: { error: { code: 'VALIDATION', message: 'body could not be read' } } };
    } else {
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: { code: 'VALIDATION', message: 'body must be JSON' } } }; }
    }
    const lease = reserve(c.provider, keys);
    if (lease.dup === 'done') return { status: 200, body: { ok: true, duplicate: true } };
    // Never 200: the first attempt may still fail and release the delivery,
    // and a provider that got 200 for the retry would never send it again.
    if (lease.dup === 'busy') {
      const left = Math.ceil((Date.parse(lease.until) - hub.wallMs()) / 1000);
      const s = Number.isFinite(left) ? Math.min(60, Math.max(1, left)) : 60;
      return { status: 503, body: { ok: false, in_progress: true, retry_after_s: s }, headers: { 'retry-after': String(s) } };
    }
    const done = () => db.run("UPDATE inbound_dedupe SET state = 'done', lease_until = NULL WHERE provider = ? AND dedupe_key IN (?, ?) AND lease_until = ?", c.provider, ...keys, lease.until);
    const release = () => db.run('DELETE FROM inbound_dedupe WHERE provider = ? AND dedupe_key IN (?, ?) AND lease_until = ?', c.provider, ...keys, lease.until);
    // One provider user's commands (C3): only a fresh lease spends it, so a
    // replayed capture can't drain a user's bucket; over it nothing runs and
    // the lease goes, so the same bytes can run once the user is under it.
    const subject = conn.rateSubject ? rateSubjectOf(conn, payload, headers) : null;
    if (subject) {
      const t = hub.limiter.take('integration_user_cmd', `${c.id}|${hub.refHash(subject)}`);
      if (!t.ok) {
        release();
        rateRefused(c);
        // ackBody's answer is a 200 the provider never retries: only for a
        // delivery that would have been acknowledged early anyway.
        if (conn.ackBody && isEarly(conn, payload, headers)) return { status: 200, ...earlyAck(conn, payload, headers, true) };
        const s = Math.max(1, Math.ceil(t.retry_after_ms / 1000));
        throw new HubError('RATE_LIMITED', `too many requests; retry in ${s} s`, { retry_after_s: s });
      }
    }
    // Spent only by verified deliveries that will run: whoever merely knows
    // the URL, or replays a finished delivery, can't drain it.
    try { limitOrThrow(hub, 'webhook_conn', c.id); } catch (e) { release(); throw e; }
    // Before the handler starts, so it can't see what the handler did to payload.
    const early = isEarly(conn, payload, headers);
    const ack = early ? earlyAck(conn, payload, headers) : null;
    const asParsed = early && conn.onAckedFailure ? copyOf({ payload, headers }) : null;
    const controller = new AbortController();
    // Aborted when the handler ends, not only on timeout: a ctx it stashed is dead after.
    const running = Promise.resolve().then(() => conn.handleWebhook({ headers, payload, ctx: ctxFor(c, controller.signal) }))
      .finally(() => controller.abort(handlerEnded()));
    // → the answer; with ackEarly nobody hears it, so a failure is also audited.
    const settle = async () => {
      try {
        await withTimeout(running, handlerTimeoutMs, controller);
      } catch (e) {
        const out = failed(e);
        if (early) await ackedFailure(conn, asParsed, e);
        return out;
      }
      done();
      setHealth(c.id, true);
      return { status: 200, body: { ok: true } };
    };
    const failed = (e) => {
      // A linked member who can't act (C2): that act was audited; the answer is
      // a success's, and nothing marks the connection broken.
      if (e instanceof ActorUnavailable && e.scope === 'member') {
        done();
        log?.info?.('integration act skipped', { integration: c.provider, connection_id: c.id, code: 'actor_unavailable' });
        return { status: 200, body: { ok: true } };
      }
      if (early) deadLetter(c, e);
      if (e?.code === 'TIMEOUT') {
        // After an early ack: done now. No provider retry is coming, and a
        // handler that never settles must not leave a lease that a captured
        // copy could take over once it expires. Late: the handler may still be
        // running, so the lease stays (a retry answers in_progress) and the
        // row settles when it really ends, or the lease expires and a later
        // retry takes it over.
        if (early) done();
        else running.then(done, release);
        setHealth(c.id, false, 'handler_timeout');
        warn('integration webhook handler timed out', c, e);
        return { status: 500, body: { error: { code: 'INTERNAL', message: 'handler failed' } } };
      }
      if (e instanceof ActorUnavailable) {
        // An admin has to reconnect it; the provider's retries would fail the same way.
        done();
        setHealth(c.id, false, 'actor_unavailable');
        warn('integration acts as a removed member', c, e);
        return { status: 200, body: { ok: true, skipped: true } };
      }
      // Late: released, so the provider's retry gets another go. Early: done
      // (C2), so a replay within the provider's window can't run it again.
      if (early) done();
      else release();
      setHealth(c.id, false, errCode(e));
      warn('integration webhook handler failed', c, e);
      return { status: 500, body: { error: { code: 'INTERNAL', message: 'handler failed' } } };
    };
    if (!early) return settle();
    // Acknowledged before the handler runs (a provider that needs an answer
    // within seconds); the hub waits for it on shutdown like a board queue.
    const bg = settle().catch((e) => warn('integration webhook settle failed', c, e));
    hub.inflight.add(bg);
    bg.finally(() => hub.inflight.delete(bg));
    return { status: 200, ...ack };
  }

  // Only a plain `true` is early: a throw or a Promise answers late, which
  // keeps the provider's retry.
  function askEarly(conn, payload, headers) {
    try { return conn.ackEarly({ payload, headers }) === true; } catch { return false; }
  }
  const isEarly = (conn, payload, headers) => conn.ackEarly === true || (typeof conn.ackEarly === 'function' && askEarly(conn, payload, headers));

  // The early answer: the default JSON, or the connector's ackBody as an
  // empty body, short text or small JSON. Anything else, over ACK_MAX, or a
  // throw is an empty 200 (the provider only needs the 200 in time).
  function earlyAck(conn, payload, headers, rateLimited = false) {
    if (!conn.ackBody) return { body: { ok: true, accepted: true } };
    const empty = { raw: '', type: 'text/plain; charset=utf-8' };
    let v;
    try { v = conn.ackBody(rateLimited ? { payload, headers, rateLimited: true } : { payload, headers }); } catch { return empty; }
    let out;
    if (typeof v === 'string') out = { raw: v, type: 'text/plain; charset=utf-8' };
    else if (isBareObject(v)) {
      try { out = { raw: JSON.stringify(v), type: 'application/json; charset=utf-8' }; } catch { return empty; }
    } else return empty;
    return typeof out.raw === 'string' && Buffer.byteLength(out.raw) <= ACK_MAX ? out : empty;
  }

  // rateSubject's answer when it is a usable subject; a throw or anything else is none.
  function rateSubjectOf(conn, payload, headers) {
    let s;
    try { s = conn.rateSubject({ payload, headers }); } catch { return null; }
    return typeof s === 'string' && s.length >= 1 && s.length <= SUBJECT_MAX ? s : null;
  }

  // Audited a few times a minute per connection, so a flood is no DB write per
  // delivery; every refusal is one log line with a code (never the subject).
  function rateRefused(c) {
    if (hub.limiter.take('integration_rate_audit_conn', c.id).ok) {
      db.insert('integration_audit', { id: randomUUID(), connection_id: c.id, action: 'webhook', decision: 'failed', error: 'rate_limited', card_id: null, external_ref: null, detail: '{}', undo: null, at: now() });
    }
    log?.info?.('integration webhook refused', { integration: c.provider, connection_id: c.id, code: 'rate_limited' });
  }

  // The connector's fixed-text "couldn't do that" (C2): a short code, never the
  // error; the restricted fetch without retries, cut after 10 s; it can't
  // change the answer, which was already sent.
  async function ackedFailure(conn, parsed, e) {
    if (!conn.onAckedFailure || !parsed) return;
    const code = SHORT_CODE.test(errCode(e)) ? errCode(e) : 'handler_failed';
    const controller = new AbortController();
    const once = restrictedFetch(conn);
    const fetch = (u, init = {}) => once(u, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
    try {
      await withTimeout(Promise.resolve().then(() => conn.onAckedFailure({ payload: parsed.payload, headers: parsed.headers, error_code: code, fetch })), ACKED_FAILURE_MS, controller);
    } catch {
      log?.warn?.('integration onAckedFailure failed', { integration: conn.id, err: 'connector_error' });
    } finally {
      controller.abort();
    }
  }

  // A delivery acknowledged early whose handler failed: no provider retry is
  // coming, so the audit log is where an admin sees it (a short code only).
  function deadLetter(c, e) {
    try {
      db.insert('integration_audit', {
        id: randomUUID(), connection_id: c.id, action: 'webhook', decision: 'failed', error: errCode(e), card_id: null, external_ref: null, detail: '{}', undo: null, at: now(),
      });
    } catch (err) { warn('integration dead letter not recorded', c, err); }
  }

  // ── OAuth / app-install connect ─────────────────────────────────────────
  // `state` = payload.HMAC(hub secret): the admin, their team, the provider,
  // 10 minutes, single use, and the hash of a bind nonce that must come back
  // as the HttpOnly bind cookie (bindCookie). The binding is to the browser
  // that consents: a victim who consents in a browser without that cookie
  // connects nothing (so nobody can send the link to someone else and collect
  // their workspace). The desktop app sets the cookie in its connect window
  // from the window name the web page gives it (D42).

  const mac = (payload) => createHmac('sha256', hub.secret).update(`integration-state|${payload}`).digest();
  const redirectFor = (publicUrl, provider) => `${publicUrl}/integrations/${provider}/callback`;
  const webhookFor = (publicUrl, id) => `${publicUrl}/integrations/${id}/webhook`;
  // The one place the identity callback URL is made (D97 prepare now, D98's identity flow later).
  const identityRedirectFor = (publicUrl, provider) => `${publicUrl}/integrations/${provider}/identity/callback`;
  // A reconnect hands the connector what it stored last time (app id, slug…),
  // from the org's newest active connection of that provider: its provider
  // facts as `provider` and an admin's config (the declared configKeys only)
  // apart as `config`, so a connector can't mistake admin input for a provider
  // fact. A row from before 026 kept exchange's answer in config: that is its
  // only record of them, so it comes as `provider`.
  const configFor = (orgId, provider) => {
    const s = safeJson(db.get("SELECT settings FROM connections WHERE org_id = ? AND provider = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1", orgId, provider)?.settings, {});
    const config = isPlainObject(s?.config) ? s.config : {};
    if (!isPlainObject(s?.provider)) return { provider: { ...config }, config: {} };
    const keys = connectors.get(provider)?.configKeys;
    return { provider: { ...s.provider }, config: keys ? Object.fromEntries(Object.entries(config).filter(([k]) => keys.includes(k))) : { ...config } };
  };

  // The web posts this form as a real <form>: its action may only be the
  // connector's declared formHost (the CSP form-action names it too).
  function manifestFormOf(conn, f) {
    const refuse = () => new HubError('POLICY_DENIED', `${conn.name} gave a connect form this hub will not post`);
    const url = isPlainObject(f) ? urlOn(f.action, [conn.connect.formHost]) : null;
    if (!url || !isPlainObject(f.fields)) throw refuse();
    const fields = {};
    for (const [k, v] of Object.entries(f.fields)) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || typeof v !== 'string') throw refuse();
      fields[k] = v;
    }
    if (Buffer.byteLength(JSON.stringify(fields)) > FORM_MAX) throw refuse();
    return { action: url.href, fields };
  }

  // exchange() may keep non-secret scalars (app id, slug) as settings.provider;
  // never autonomy, which stays an admin's. null: over the cap.
  function exchangeConfig(v) {
    const out = {};
    if (!isPlainObject(v)) return out;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'autonomy' || k.length > 64) continue;
      if ((typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean' || x === null || typeof x === 'string') out[k] = x;
    }
    return Buffer.byteLength(JSON.stringify(out)) <= EXCHANGE_SETTINGS_MAX ? out : null;
  }
  // https: a __Host- cookie (Secure, Path=/, no Domain), which neither plain
  // http nor a sibling host can set, so nobody can plant their own bind.
  const bindCookie = (provider, publicUrl) => (String(publicUrl).startsWith('https:')
    ? { name: `__Host-board_int_${provider}`, path: '/', secure: true }
    : { name: `board_int_${provider}`, path: '/integrations/', secure: false });

  // A signed state for (member, provider, connection id), its bind and the bind cookie.
  function mintState(member, provider, id, publicUrl, extra = {}) {
    const bind = randomBytes(24).toString('base64url');
    const payload = b64(JSON.stringify({
      m: member.id, o: member.org_id, p: provider, n: randomBytes(16).toString('base64url'), e: Date.now() + STATE_TTL_MS, b: sha(bind), i: id, ...extra,
    }));
    return { state: `${payload}.${mac(payload).toString('base64url')}`, bind, cookie: { ...bindCookie(provider, publicUrl), value: bind, max_age_s: STATE_TTL_MS / 1000 } };
  }

  // D42 addendum "start inputs": the declared keys only, each through the
  // connector's own rule; the fixed texts never repeat a value.
  function startInputOf(conn, input) {
    if (input === undefined) return {};
    const noSuch = () => new HubError('VALIDATION', 'this connection takes no such input');
    if (!isPlainObject(input)) throw noSuch();
    const names = conn.connect.startInputs ?? [];
    const out = {};
    for (const k of Object.keys(input)) {
      if (!names.includes(k)) throw noSuch();
      const v = input[k];
      let n = null;
      if (typeof v === 'string' && v && Buffer.byteLength(v) <= START_INPUT_MAX) {
        try { n = conn.connect.startInput(k, v); } catch { n = null; }
      }
      if (typeof n !== 'string' || !n || Buffer.byteLength(n) > START_INPUT_MAX) throw new HubError('VALIDATION', 'that value is not valid here: check it and try again');
      out[k] = n;
    }
    return out;
  }

  // A callback state's `si`: the MAC vouches for it, but the connector's rule
  // must still take every value unchanged. null: refuse.
  function signedStartInput(conn, si) {
    if (si === undefined) return {};
    if (!isPlainObject(si) || !Object.keys(si).length || !Array.isArray(conn.connect.startInputs)) return null;
    for (const [k, v] of Object.entries(si)) {
      if (!conn.connect.startInputs.includes(k) || typeof v !== 'string') return null;
      try { if (conn.connect.startInput(k, v) !== v) return null; } catch { return null; }
    }
    return { ...si };
  }

  function oauthStart({ member, provider, publicUrl, input }) {
    const conn = connectors.get(provider);
    // A prepare connector connects only through its pending row (D97): the
    // plain flow would skip the match check and never pin the app.
    if (!conn || conn.connect.kind === 'token' || conn.connect.prepare) throw new HubError('NOT_FOUND', 'no such integration');
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    // The connection id is minted now: a manifest must name its webhook URL
    // before the app (and so the connection) exists.
    const si = startInputOf(conn, input);
    const id = randomUUID();
    const { state, bind, cookie } = mintState(member, provider, id, publicUrl, Object.keys(si).length ? { si } : {});
    const args = { state, redirectUri: redirectFor(publicUrl, provider), webhookUrl: webhookFor(publicUrl, id), ...configFor(member.org_id, provider), input: { ...si } };
    if (conn.connect.manifestForm) return { form: manifestFormOf(conn, conn.connect.manifestForm(args)), bind, cookie };
    return { url: conn.connect.authorizeUrl(args), bind, cookie };
  }

  /** → {ok:true, connection, provider_name, next_url} | {ok:false, error} (error is safe to show). */
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
    if (!st || st.p !== provider || typeof st.n !== 'string' || typeof st.b !== 'string' || !UUID_RE.test(st.i ?? '') || !(Date.now() <= st.e)) return { ok: false, error: 'This link has expired. Start again from Buddy.' };
    // A state from before the connector declared prepare, or minted by /start.
    if (conn.connect.prepare && st.pd !== 1) return invalid;
    const startInput = signedStartInput(conn, st.si);
    if (!startInput) return invalid;
    // Before the nonce is spent: a browser without the cookie can't burn the admin's attempt.
    if (typeof bindCookie !== 'string' || !safeEq(sha(bindCookie), st.b)) return { ok: false, error: 'Open this link in the window Plexiform opened. Start again.' };
    const first = db.run("INSERT OR IGNORE INTO inbound_dedupe (provider, dedupe_key, received_at, state) VALUES ('oauth_state', ?, ?, 'done')", st.n, now());
    if (Number(first.changes) !== 1) return { ok: false, error: 'This link was already used. Start again from Buddy.' };
    const member = hub.member(st.m);
    if (!member || member.removed_at || member.org_id !== st.o || !['owner', 'admin'].includes(member.role)) return { ok: false, error: 'Only a team admin can connect this.' };
    if (query.get('error')) return { ok: false, error: 'The connection was cancelled.' };
    // A pending row (D97) is finished only by the member who prepared it.
    const pending = st.pd === 1 ? livePending(st.i) : null;
    if (st.pd === 1 && (!pending || pending.org_id !== st.o || pending.provider !== provider || pending.created_by !== st.m || pending.match === '{}')) return { ok: false, error: SETUP_EXPIRED };
    let held = {};
    if (pending) {
      try { held = pendingSecretsOf(pending.id); } catch (e) {
        warn('integration pending secrets could not be opened', conn, e);
        return { ok: false, error: 'Could not save the connection.' };
      }
    }
    let v;
    try {
      v = await conn.connect.exchange({
        query, redirectUri: redirectFor(publicUrl, provider), webhookUrl: webhookFor(publicUrl, st.i),
        ...(pending ? pendingConfig(pending) : configFor(member.org_id, provider)), secrets: { ...held }, fetch: restrictedFetch(conn), startInput,
      });
    } catch (e) {
      warn('integration connect failed', conn, e);
      // Only after an owner was named at /start: the sentence says so. The app
      // exists at the provider (webhook URL and all), so the admin is sent to delete it.
      let notOwned = false;
      let app = null;
      try {
        notOwned = e?.code === 'NOT_OWNED' && Object.keys(startInput).length > 0;
        app = notOwned && typeof e.url === 'string' ? urlOn(e.url, conn.hosts) : null;
      } catch { app = null; }
      if (notOwned) return { ok: false, code: 'NOT_OWNED', error: notOwnedText(conn.name), ...(app ? { link: { url: app.href, text: `Open that app on ${conn.name}` } } : {}) };
      return { ok: false, error: 'The provider did not accept the connection. Try again.' };
    }
    if (pending) {
      const want = safeJson(pending.match, {});
      const got = isPlainObject(v?.match) ? v.match : null;
      const keys = Object.keys(want);
      const same = !!got && Object.keys(got).length === keys.length && keys.every((k) => Object.hasOwn(got, k) && got[k] === want[k]);
      if (!same || (pending.external_id != null && String(v?.external_id ?? '') !== pending.external_id)) {
        return { ok: false, error: 'This app does not match the one being set up. Start again.' };
      }
      if (isPlainObject(v?.secrets) && Object.keys(v.secrets).some((k) => Object.hasOwn(held, k))) return { ok: false, error: 'Could not save the connection.' };
    }
    let facts = v?.settings === undefined ? {} : exchangeConfig(v.settings);
    // The pending settings win: exchange can't move the app it was pinned to.
    if (pending && facts) facts = exchangeConfig({ ...facts, ...safeJson(pending.settings, {}) });
    if (facts === null) return { ok: false, error: 'Could not save the connection.' };
    const next = v?.next_url == null ? null : urlOn(v.next_url, conn.hosts);
    if (v?.next_url != null && !next) warn('integration next_url refused', conn, 'not https on a declared host');
    try {
      // Named fields only: exchange() can't pick the id, org, member or autonomy.
      const connection = createConnection({
        external_id: v?.external_id, display_name: v?.display_name, scopes: v?.scopes, secrets: v?.secrets ?? {},
        settings: { provider: facts, ...(pending ? { pinned: safeJson(pending.match, {}) } : {}) },
        id: st.i, orgId: member.org_id, memberId: member.id, provider, pending,
      });
      return { ok: true, connection, provider_name: conn.name, next_url: next?.href ?? null };
    } catch (e) {
      // The app exists at the provider but can't be connected here: the row goes, and the admin deletes the app.
      if (pending && e instanceof HubError && e.code === 'CONFLICT') {
        hub.txn(() => dropPending(db.all('SELECT id, provider FROM integration_pending WHERE id = ?', pending.id), 'integration.prepare_cancel', member.id));
        return { ok: false, error: `${e.message}. Delete the app this setup created on ${conn.name}.` };
      }
      return { ok: false, error: e instanceof HubError ? e.message : 'Could not save the connection.' };
    }
  }

  // ── pending connections (D97) ───────────────────────────────────────────
  // A row of integration_pending, never a connection: no query above sees it.
  // Expired rows are invisible at once (expires_at in every read) and purged
  // by sweepPending. The admin's pasted input lives only in callPrepare's
  // memory: nothing derived from it is logged, thrown, cached or stored except
  // what the connector returns as secrets (sealed) or settings/match.

  const livePending = (id) => (typeof id === 'string' ? db.get('SELECT * FROM integration_pending WHERE id = ? AND expires_at > ?', id, now()) : null);
  const publicPending = (p) => ({ id: p.id, provider: p.provider, status: 'pending', created_by: p.created_by, created_at: p.created_at, expires_at: p.expires_at, ready: p.match !== '{}' });
  // prepare's settings are provider facts of the app being made.
  const pendingConfig = (p) => {
    const c = configFor(p.org_id, p.provider);
    return { provider: { ...c.provider, ...safeJson(p.settings, {}) }, config: c.config };
  };
  const notAccepted = () => new HubError('VALIDATION', NOT_ACCEPTED);
  const pendingNotFound = () => new HubError('NOT_FOUND', 'no such integration');
  const preparing = new Set(); // pending ids whose prepare (first or second step) is at the provider
  let lastSweep = -Infinity;

  function pendingSecretsOf(id) {
    const out = {};
    for (const r of db.all('SELECT * FROM integration_pending_secrets WHERE pending_id = ?', id)) out[r.kind] = hub.vault.open(id, r.kind, r);
    return out;
  }

  // Inside a transaction. The secrets go with each row (integration_pending_secrets_purge).
  function dropPending(rows, kind, memberId = null) {
    for (const p of rows) {
      db.run('DELETE FROM integration_pending WHERE id = ?', p.id);
      hub.journal({ board_id: null, actor_kind: memberId ? 'member' : 'system', actor_id: memberId, kind, payload: { pending_id: p.id, provider: p.provider } });
    }
  }

  /** Delete expired pending rows; at most once a minute (the reaper calls it every tick). */
  function sweepPending() {
    const t = hub.wallMs();
    if (t - lastSweep < PENDING_SWEEP_MS) return 0;
    lastSweep = t;
    const rows = db.all('SELECT id, provider FROM integration_pending WHERE expires_at <= ?', now());
    if (rows.length) hub.txn(() => dropPending(rows, 'integration.prepare_expire'));
    return rows.length;
  }

  // The declared keys only; never echoes a value.
  function prepareInput(conn, input) {
    if (input === undefined) return {};
    if (!isPlainObject(input)) throw new HubError('VALIDATION', 'input must be an object');
    const out = {};
    for (const k of conn.connect.prepareInputs) {
      if (!Object.hasOwn(input, k)) continue;
      const v = input[k];
      if (typeof v !== 'string' || !v || Buffer.byteLength(v) > PREPARE_INPUT_MAX) throw new HubError('VALIDATION', `each input is text of 1 to ${PREPARE_INPUT_MAX} bytes`);
      out[k] = v;
    }
    return out;
  }

  // 1–8 scalar entries, else null.
  function cleanMatch(m) {
    if (!isPlainObject(m)) return null;
    const entries = Object.entries(m);
    if (!entries.length || entries.length > MATCH_MAX) return null;
    // hub_url is the registry's own provider key: a pinned one could not be copied there.
    const ok = ([k, x]) => MATCH_KEY.test(k) && k !== 'hub_url' && ((typeof x === 'string' && x.length <= MATCH_STR_MAX) || (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean');
    return entries.every(ok) ? Object.fromEntries(entries) : null;
  }

  // prepare's answer, copied into plain values; anything off is the fixed VALIDATION.
  function prepareAnswer(conn, v) {
    if (!isPlainObject(v)) throw notAccepted();
    if (v.needs !== undefined) {
      const n = v.needs;
      if (!isPlainObject(n) || !Array.isArray(n.fields) || !n.fields.length || n.fields.length > MATCH_MAX) throw notAccepted();
      const fields = [...n.fields];
      if (new Set(fields).size !== fields.length || fields.some((f) => typeof f !== 'string' || !conn.connect.prepareInputs.includes(f))) throw notAccepted();
      const url = typeof n.create_url === 'string' && Buffer.byteLength(n.create_url) <= CREATE_URL_MAX ? urlOn(n.create_url, conn.hosts) : null;
      if (!url) throw notAccepted();
      return { needs: { fields, create_url: url.href } };
    }
    if (!isPlainObject(v.secrets)) throw notAccepted();
    const secrets = {};
    for (const [k, x] of Object.entries(v.secrets)) {
      if (!conn.secrets.includes(k) || typeof x !== 'string' || !x || Buffer.byteLength(x) > SECRET_MAX_BYTES) throw notAccepted();
      secrets[k] = x;
    }
    if (!Object.keys(secrets).length) throw notAccepted();
    const settings = v.settings === undefined ? {} : exchangeConfig(v.settings);
    const match = cleanMatch(v.match);
    if (settings === null || !match) throw notAccepted();
    const ext = v.external_id ?? null;
    if (ext !== null && (typeof ext !== 'string' || !ext || ext.length > 200)) throw notAccepted();
    return { secrets, settings, match, external_id: ext };
  }

  // The restricted fetch without retries (creating an app is not idempotent).
  // Its errors are rebuilt with fixed text and no cause: a fetch error's cause
  // can carry the request, headers and all (the pasted token as a Bearer).
  function prepareFetch(conn, signal) {
    const once = restrictedFetch(conn);
    return async (u, init = {}) => {
      let refused = false;
      try {
        return await once(u, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
      } catch (e) {
        refused = e?.healthCode === 'host_refused';
      }
      throw refused ? tagged('that host is not declared', 'host_refused') : tagged('the request failed', 'provider_unreachable');
    };
  }

  // Never touches what the connector threw: its message, cause or fields may hold the input.
  async function callPrepare(conn, args) {
    const controller = new AbortController();
    try {
      const v = await withTimeout(Promise.resolve().then(() => conn.connect.prepare({ ...args, fetch: prepareFetch(conn, controller.signal) })), PREPARE_TIMEOUT_MS, controller);
      return prepareAnswer(conn, v);
    } catch {
      log?.warn?.('integration prepare failed', { integration: conn.id, err: 'connector_error' });
      throw notAccepted();
    } finally {
      controller.abort();
    }
  }

  const prepareArgs = (orgId, provider, id, input, publicUrl) => ({
    input, webhookUrl: webhookFor(publicUrl, id), redirectUri: redirectFor(publicUrl, provider),
    identityRedirectUri: identityRedirectFor(publicUrl, provider), ...configFor(orgId, provider),
  });

  function authorizeFor(conn, p, member, publicUrl) {
    const { state, bind, cookie } = mintState(member, p.provider, p.id, publicUrl, { pd: 1 });
    const url = conn.connect.authorizeUrl({ state, redirectUri: redirectFor(publicUrl, p.provider), webhookUrl: webhookFor(publicUrl, p.id), ...pendingConfig(p) });
    return { url, bind, cookie };
  }

  // Seals the answer on the row (still live and still this member's). Once the
  // provider made an app, failing to keep it here orphans it there: the row
  // goes and the admin is told, in fixed text, to delete that app.
  function finishPrepare(conn, member, id, answer, publicUrl) {
    let p = null;
    try {
      p = hub.txn(() => {
        const cur = livePending(id);
        if (!cur || cur.created_by !== member.id || cur.match !== '{}') return null;
        // Until the paste, settings holds only the fields asked for: the second
        // step takes those keys and no others; the answer then replaces it.
        if (answer.needs) db.run('UPDATE integration_pending SET settings = ? WHERE id = ?', JSON.stringify({ needs_fields: answer.needs.fields }), id);
        else {
          db.run('UPDATE integration_pending SET match = ?, settings = ?, external_id = ? WHERE id = ?', JSON.stringify(answer.match), JSON.stringify(answer.settings), answer.external_id, id);
          for (const [kind, value] of Object.entries(answer.secrets)) {
            const s = hub.vault.seal(id, kind, value);
            db.insert('integration_pending_secrets', { pending_id: id, kind, key_id: s.key_id, nonce: s.nonce, ciphertext: s.ciphertext, created_at: now() });
          }
        }
        hub.journal({ board_id: null, actor_kind: 'member', actor_id: member.id, kind: 'integration.prepare', payload: { pending_id: id, provider: conn.id } });
        return livePending(id);
      });
    } catch (e) {
      if (answer.needs) throw e;
      log?.warn?.('integration prepare could not be saved', { integration: conn.id, err: 'save_failed' });
    }
    if (!p && !answer.needs) {
      hub.txn(() => dropPending(db.all("SELECT id, provider FROM integration_pending WHERE id = ? AND match = '{}'", id), 'integration.prepare_cancel', member.id));
      throw new HubError('CONFLICT', `Could not save this setup. Delete the app it created on ${conn.name}.`);
    }
    if (!p) throw pendingNotFound();
    if (answer.needs) return { pending: publicPending(p), needs: answer.needs };
    return { pending: publicPending(p), ...authorizeFor(conn, p, member, publicUrl) };
  }

  /** POST /api/integrations/:provider/prepare → {pending, needs} | {pending, url, bind, cookie}. */
  async function pendingCreate({ member, provider, input, publicUrl }) {
    const conn = connectors.get(provider);
    if (!conn?.connect.prepare) throw new HubError('NOT_FOUND', 'no such integration');
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    const clean = prepareInput(conn, input);
    const id = randomUUID();
    // The row is reserved before the provider is called: the unique indexes let
    // one prepare per (org, provider) and per admin reach it.
    hub.txn(() => {
      const t = now();
      dropPending(db.all('SELECT id, provider FROM integration_pending WHERE (created_by = ? OR (org_id = ? AND provider = ?)) AND expires_at <= ?', member.id, member.org_id, provider, t), 'integration.prepare_expire');
      const live = db.get('SELECT id FROM integration_pending WHERE created_by = ? OR (org_id = ? AND provider = ?)', member.id, member.org_id, provider);
      if (live) throw new HubError('CONFLICT', 'a setup is already pending: continue or delete it first', { reason: 'PENDING_EXISTS', pending_id: live.id });
      limitOrThrow(hub, 'integration_prepare_member', member.id);
      limitOrThrow(hub, 'integration_prepare_org', member.org_id);
      db.insert('integration_pending', { id, org_id: member.org_id, provider, created_by: member.id, created_at: t, expires_at: new Date(hub.wallMs() + PENDING_TTL_MS).toISOString() });
    });
    // A second step for this row must wait: it would make a second app, and
    // this call's cleanup below would delete the row it finished.
    preparing.add(id);
    try {
      let answer;
      try {
        answer = await callPrepare(conn, prepareArgs(member.org_id, provider, id, clean, publicUrl));
      } catch (e) {
        db.run('DELETE FROM integration_pending WHERE id = ?', id);
        throw e;
      }
      return finishPrepare(conn, member, id, answer, publicUrl);
    } finally {
      preparing.delete(id);
    }
  }

  /** POST /api/integrations/:id/prepare: the pasted fields for a row with no secrets yet (its creator only). */
  async function pendingPrepare({ member, id, input, publicUrl }) {
    const p = livePending(id);
    const conn = p && connectors.get(p.provider);
    if (!p || p.org_id !== member.org_id || p.created_by !== member.id || !conn?.connect.prepare) throw pendingNotFound();
    if (p.match !== '{}') throw new HubError('CONFLICT', 'this setup already has its app', { reason: 'PENDING_READY' });
    if (preparing.has(id)) throw new HubError('CONFLICT', 'this setup is already being prepared', { reason: 'PENDING_BUSY' });
    const asked = safeJson(p.settings, {})?.needs_fields;
    if (isPlainObject(input) && Object.keys(input).some((k) => !Array.isArray(asked) || !asked.includes(k))) throw new HubError('VALIDATION', 'send only the fields this setup asked for');
    const clean = prepareInput(conn, input);
    limitOrThrow(hub, 'integration_prepare_member', member.id);
    limitOrThrow(hub, 'integration_prepare_org', member.org_id);
    preparing.add(id);
    try {
      const answer = await callPrepare(conn, prepareArgs(p.org_id, p.provider, id, clean, publicUrl));
      if (answer.needs) throw notAccepted();
      return finishPrepare(conn, member, id, answer, publicUrl);
    } finally {
      preparing.delete(id);
    }
  }

  /** POST /api/integrations/:id/authorize: a fresh state and bind, ≤ 5 per row, never a longer life. */
  function pendingAuthorize({ member, id, publicUrl }) {
    const p = livePending(id);
    const conn = p && connectors.get(p.provider);
    if (!p || p.org_id !== member.org_id || p.created_by !== member.id || !conn?.connect.prepare) throw pendingNotFound();
    if (p.match === '{}') throw new HubError('CONFLICT', 'this setup has no app yet', { reason: 'PENDING_NOT_READY' });
    const took = db.run('UPDATE integration_pending SET authorize_count = authorize_count + 1 WHERE id = ? AND authorize_count < ?', id, AUTHORIZE_MAX);
    if (Number(took.changes) !== 1) throw new HubError('RATE_LIMITED', 'this setup was resumed too often: delete it and start again');
    return authorizeFor(conn, p, member, publicUrl);
  }

  /** DELETE on a live pending row of the member's org → true; anything else → false (the caller tries a connection). */
  function pendingDelete({ member, id }) {
    return hub.txn(() => {
      const p = livePending(id);
      if (!p || p.org_id !== member.org_id) return false;
      dropPending([p], 'integration.prepare_cancel', member.id);
      return true;
    });
  }

  // ── identity links (D98) ────────────────────────────────────────────────
  // A member links their own provider account. The state is MAC'd under its
  // own domain (a connect state never verifies here, nor the reverse), names
  // the member, team, connection and the credential that started it, and is
  // bound to the browser by the D42 bind cookie. The connector only builds the
  // URL and trades the code for the raw id_token; it is verified here. Nothing
  // the connector or provider says is ever logged or shown: fixed codes only.

  const idMac = (payload) => createHmac('sha256', hub.secret).update(`integration-identity|${payload}`).digest();
  const accountsMode = () => hub.config?.auth === 'accounts';
  const credHash = (cred) => sha(`${cred.kind}:${cred.id}`);
  // The audience: the client id promotion pinned (D97), never admin-editable config.
  const pinnedClientId = (c) => { const v = safeJson(c.settings, {})?.pinned?.client_id; return typeof v === 'string' && v ? v : null; };
  // Fixed namespaces only (their values are scalars, so a shallow freeze is deep): never config.
  const linkConnection = (c) => {
    const s = safeJson(c.settings, {}) ?? {};
    const fixed = (v) => (isPlainObject(v) ? Object.freeze({ ...v }) : undefined);
    return Object.freeze({ external_id: c.external_id, settings: Object.freeze({ pinned: fixed(s.pinned), provider: fixed(s.provider) }) });
  };
  const jwksCaches = new Map(); // provider → its JWKS cache

  function jwksFor(conn) {
    let j = jwksCaches.get(conn.id);
    if (!j) {
      const fetchOnce = restrictedFetch(conn);
      j = createJwks({
        load: () => {
          const controller = new AbortController();
          return withTimeout((async () => {
            const res = await fetchOnce(conn.identity.jwksUrl, { headers: { accept: 'application/json' }, signal: controller.signal });
            if (!res.ok) throw new Error('jwks unavailable');
            return JSON.parse(await readCapped(res, JWKS_MAX));
          })(), JWKS_TIMEOUT_MS, controller);
        },
        now: () => hub.mono(), ttlMs: JWKS_TTL_MS, kidRefetchMs: JWKS_REFETCH_MS, retryMs: JWKS_REFETCH_MS,
      });
      jwksCaches.set(conn.id, j);
    }
    return j;
  }

  /** POST /api/integrations/:id/identity/start → {url, bind, cookie}. `cred`: the accounts credential, else null. */
  async function identityStart({ member, connectionId, cred = null, publicUrl }) {
    const c = row(connectionId);
    const conn = c && connectors.get(c.provider);
    if (!c || !conn || c.status !== 'active' || c.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'no such integration');
    if (!hub.canWrite(member)) throw new HubError('FORBIDDEN', 'viewers cannot link an account');
    if (!conn.identity) throw new HubError('POLICY_DENIED', `${conn.name} does not link accounts`);
    if (!pinnedClientId(c)) throw new HubError('POLICY_DENIED', 'this connection cannot link accounts: connect it again');
    if (!hub.vault.available) throw new HubError('POLICY_DENIED', 'integrations need the hub encryption key first');
    if (accountsMode() && !cred) throw new HubError('UNAUTHENTICATED', 'not signed in');
    limitOrThrow(hub, 'integration_identity_member', member.id);
    const bind = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const payload = b64(JSON.stringify({
      m: member.id, o: member.org_id, c: c.id, p: c.provider, s: cred ? credHash(cred) : null,
      n: randomBytes(16).toString('base64url'), k: nonce, e: hub.wallMs() + STATE_TTL_MS, b: sha(bind),
    }));
    const state = `${payload}.${idMac(payload).toString('base64url')}`;
    let url = null;
    try {
      url = urlOn(await conn.identity.authorizeUrl({
        state, nonce, redirectUri: identityRedirectFor(publicUrl, c.provider), connection: linkConnection(c), secrets: secretsOf(c), fetch: restrictedFetch(conn),
      }), conn.hosts);
    } catch { url = null; }
    if (!url) {
      log?.warn?.('integration identity start refused', { integration: conn.id, connection_id: c.id, err: 'connector_error' });
      throw new HubError('POLICY_DENIED', `${conn.name} could not start the link`);
    }
    return { url: url.href, bind, cookie: { ...bindCookie(c.provider, publicUrl), value: bind, max_age_s: STATE_TTL_MS / 1000 } };
  }

  /**
   * GET /integrations/:provider/identity/callback → {ok:true, provider_name} |
   * {ok:false, status, error} (error is fixed text). `ip`: the client's
   * network key; `cred`: the request's own accounts credential
   * ({user_id, kind, id}) or null; `credInvalid`: it sent one that is not.
   */
  async function identityCallback({ provider, query, publicUrl, bindCookie: bindValue = null, ip = null, cred = null, credInvalid = false }) {
    const failKey = String(ip ?? '');
    if (!hub.limiter.peek('integration_link_fail_ip', failKey).ok) return { ok: false, status: 429, error: 'Too many attempts. Try again later.' };
    const refuse = (error, code = null) => {
      hub.limiter.take('integration_link_fail_ip', failKey);
      if (code) log?.warn?.('integration identity link refused', { integration: provider, err: code });
      return { ok: false, status: 400, error };
    };
    const conn = connectors.get(provider);
    if (!conn?.identity) return refuse('Unknown integration.');
    const parts = String(query.get('state') ?? '').split('.');
    const [payload, sig] = parts;
    if (parts.length !== 2 || !payload || !/^[A-Za-z0-9_-]+$/.test(sig ?? '')) return refuse(LINK_INVALID);
    const got = Buffer.from(sig, 'base64url');
    const want = idMac(payload);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return refuse(LINK_INVALID);
    const st = safeJson(Buffer.from(payload, 'base64url').toString('utf8'), null);
    if (!isPlainObject(st) || st.p !== provider || !UUID_RE.test(st.c ?? '') || typeof st.n !== 'string' || typeof st.k !== 'string' || !st.k
      || typeof st.b !== 'string' || !(hub.wallMs() <= st.e)) return refuse('This link has expired. Start again from Buddy.');
    // Before the nonce is spent: a browser without the cookie burns nothing.
    if (typeof bindValue !== 'string' || !safeEq(sha(bindValue), st.b)) return refuse('Open this link in the window Plexiform opened. Start again.');
    const first = db.run("INSERT OR IGNORE INTO inbound_dedupe (provider, dedupe_key, received_at, state) VALUES ('identity_state', ?, ?, 'done')", st.n, now());
    if (Number(first.changes) !== 1) return refuse('This link was already used. Start again from Buddy.');
    // The credential that started it still live, and no other one at the callback.
    const credOk = () => {
      if (credInvalid) return false;
      if (!accountsMode()) return st.s == null;
      const m = hub.member(st.m);
      if (typeof st.s !== 'string' || !m?.user_id) return false;
      if (cred && (cred.user_id !== m.user_id || (cred.kind === 'session' && !safeEq(credHash(cred), st.s)))) return false;
      const creds = [
        ...db.all('SELECT id FROM sessions WHERE user_id = ?', m.user_id).map((r) => ({ kind: 'session', id: r.id })),
        ...db.all('SELECT id FROM user_devices WHERE user_id = ? AND revoked_at IS NULL', m.user_id).map((r) => ({ kind: 'device', id: r.id })),
      ];
      return creds.some((x) => safeEq(credHash(x), st.s) && hub.accounts.credValid(x));
    };
    // The member (live, of the team, able to write) and the connection (active, of the team).
    const current = () => {
      const m = hub.member(st.m);
      const c = row(st.c);
      if (!m || m.removed_at || m.org_id !== st.o || !hub.canWrite(m)) return null;
      return c && c.status === 'active' && c.org_id === st.o && c.provider === provider && pinnedClientId(c) ? c : null;
    };
    const c = credOk() ? current() : null;
    if (!c) return refuse(LINK_GONE);
    if (query.get('error')) return refuse('The link was cancelled.');
    let idToken = null;
    try {
      const v = await conn.identity.exchange({
        query, state: query.get('state'), redirectUri: identityRedirectFor(publicUrl, provider), connection: linkConnection(c), secrets: secretsOf(c), fetch: restrictedFetch(conn),
      });
      idToken = typeof v?.id_token === 'string' && v.id_token && v.id_token.length <= ID_TOKEN_MAX ? v.id_token : null;
    } catch { idToken = null; }
    if (!idToken) return refuse(LINK_FAILED, 'exchange_failed');
    let claims;
    let outage = false;
    const { keyFor } = jwksFor(conn);
    try {
      claims = await verifyRs256(idToken, {
        keyFor: (kid) => keyFor(kid).catch((e) => { outage = true; throw e; }),
        issuers: [conn.identity.issuer], audience: pinnedClientId(c), nonce: st.k, nowS: hub.wallMs() / 1000,
      });
    } catch { claims = null; }
    idToken = null;
    // The provider's key set being unreachable is not the caller's failure:
    // it spends nothing, so an outage can't lock members out of linking.
    if (!claims && outage) {
      log?.warn?.('integration identity link refused', { integration: provider, err: 'jwks_unavailable' });
      return { ok: false, status: 503, error: LINK_UNAVAILABLE };
    }
    if (!claims) return refuse(LINK_FAILED, 'id_token_refused');
    if (claims[conn.identity.workspaceClaim] !== c.external_id) return refuse('That account is in another workspace. Sign in to the connected workspace and start again.', 'other_workspace');
    const sub = claims.sub;
    if (sub.length > SUBJECT_MAX || !conn.identity.subjectRe.test(sub)) return refuse(LINK_FAILED, 'bad_subject');
    let out;
    try {
      out = hub.txn(() => {
        const cur = current();
        if (!cur || cur.id !== c.id) return { error: LINK_GONE };
        const mine = db.get('SELECT subject FROM external_identities WHERE provider = ? AND workspace_id = ? AND member_id = ?', c.provider, c.external_id, st.m);
        if (mine) return mine.subject === sub ? { same: true } : { error: 'You already linked another account. Unlink it first.' };
        if (db.get('SELECT 1 AS x FROM external_identities WHERE provider = ? AND workspace_id = ? AND subject = ?', c.provider, c.external_id, sub)) {
          return { error: 'That account is already linked to another member. They or an admin can unlink it.' };
        }
        db.insert('external_identities', { provider: c.provider, workspace_id: c.external_id, subject: sub, member_id: st.m, connection_id: c.id, verified_via: 'oauth_link', linked_at: now() });
        hub.journal({ board_id: null, actor_kind: 'member', actor_id: st.m, kind: 'integration.identity_link', payload: { connection_id: c.id, provider: c.provider, member_id: st.m } });
        db.insert('integration_audit', { id: randomUUID(), connection_id: c.id, action: 'identity.link', decision: 'auto', error: null, card_id: null, external_ref: null, detail: auditJson({ member_id: st.m }), undo: null, at: now() });
        return { linked: true };
      });
    } catch {
      return refuse('Could not save the link. Start again from Buddy.', 'write_failed');
    }
    if (out.error) return refuse(out.error);
    return { ok: true, provider_name: conn.name };
  }

  /** A member's link on a connection, removed by themself ('self') or an admin ('admin') → {ok, removed}. */
  function identityUnlink({ connectionId, memberId, by, actorId }) {
    const c = row(connectionId);
    if (!c) throw new HubError('NOT_FOUND', 'no such integration');
    return hub.txn(() => {
      const removed = Number(db.run('DELETE FROM external_identities WHERE connection_id = ? AND member_id = ?', c.id, memberId).changes) > 0;
      if (removed) {
        hub.journal({ board_id: null, actor_kind: 'member', actor_id: actorId, kind: 'integration.identity_unlink', payload: { connection_id: c.id, provider: c.provider, member_id: memberId, by } });
        db.insert('integration_audit', { id: randomUUID(), connection_id: c.id, action: 'identity.unlink', decision: 'auto', error: null, card_id: null, external_ref: null, detail: auditJson({ member_id: memberId, by }), undo: null, at: now() });
      }
      return { ok: true, removed };
    });
  }

  const linkOf = (connectionId, memberId) => db.get('SELECT linked_at FROM external_identities WHERE connection_id = ? AND member_id = ?', connectionId, memberId);

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
      const name = consumerName(c);
      if (lateOk.has(name)) {
        const seq = lateOk.get(name);
        lateOk.delete(name);
        if (seq === r.seq) return;
      }
      const prev = inflight.get(name);
      // A timed-out call may still be acting: never run the row again beside it.
      // The bus moved past its row only by dead-lettering it (handler_stuck):
      // that call's signal aborted long ago, so it can no longer act; forget it.
      if (prev?.seq === r.seq) throw Object.assign(new Error('handler_busy: the previous call has not ended'), { busy: true });
      if (prev) inflight.delete(name);
      const controller = new AbortController();
      const running = Promise.resolve().then(() => conn.onEvent(r, ctxFor(cur, controller.signal)))
        .finally(() => controller.abort(handlerEnded()));
      const entry = { seq: r.seq, running, timedOut: false };
      inflight.set(name, entry);
      const settled = () => { if (inflight.get(name) === entry) inflight.delete(name); };
      running.then(() => { if (entry.timedOut && inflight.get(name) === entry) lateOk.set(name, r.seq); settled(); }, settled);
      try {
        await withTimeout(running, handlerTimeoutMs, controller);
      } catch (e) {
        if (e?.code === 'TIMEOUT') entry.timedOut = true;
        const code = errCode(e);
        // A linked member who can't act: that act was audited; the connection is fine.
        if (e instanceof ActorUnavailable && e.scope === 'member') {
          log?.info?.('integration act skipped', { integration: c.provider, connection_id: c.id, code });
          return;
        }
        setHealth(c.id, false, code);
        if (e instanceof ActorUnavailable) { warn('integration acts as a removed member', c, e); return; }
        throw new Error(`${code}: ${redact(e?.message ?? e)}`);
      }
    }, { kinds: conn.consumes, orgId: c.org_id });
  }

  // ── registration ────────────────────────────────────────────────────────

  function register(conn) {
    if (connectors.has(conn.id)) throw new Error(`integration ${conn.id} registered twice`);
    connectors.set(conn.id, conn);
    if (conn.ingressCidrs?.length) {
      const list = new BlockList();
      for (const r of conn.ingressCidrs.map(parseCidr)) if (r) list.addSubnet(r.address, r.prefix, r.type);
      ingress.set(conn.id, list);
    }
    for (const c of db.all("SELECT * FROM connections WHERE provider = ? AND status = 'active'", conn.id)) subscribe(c);
  }

  return {
    register,
    /** Hosts a manifest connect form may post to (the web's CSP form-action). */
    formHosts: () => [...new Set([...connectors.values()].filter((c) => c.connect.manifestForm).map((c) => c.connect.formHost))],
    connectors: () => [...connectors.values()].map((c) => ({ id: c.id, name: c.name, scopes: c.scopes, connect: c.connect.kind, actions: c.actions, prepare: c.connect.prepareInputs ? [...c.connect.prepareInputs] : null, identity: !!c.identity, start: c.connect.startInputs ? [...c.connect.startInputs] : null })),
    list: (orgId) => db.all("SELECT * FROM connections WHERE org_id = ? AND status != 'revoked' ORDER BY created_at", orgId).map(publicConnection),
    get: (id) => { const c = row(id); return c ? publicConnection(c) : null; },
    orgOf: (id) => row(id)?.org_id ?? livePending(id)?.org_id ?? null,
    pendingList: (orgId) => db.all('SELECT * FROM integration_pending WHERE org_id = ? AND expires_at > ? ORDER BY created_at, id', orgId, now()).map(publicPending),
    pendingCreate,
    pendingPrepare,
    pendingAuthorize,
    pendingDelete,
    sweepPending,
    /** The identity callback URL for a connection (D97 prepare got the same string). */
    identityRedirectUri: (publicUrl, connectionId) => { const c = row(connectionId); return c ? identityRedirectFor(publicUrl, c.provider) : null; },
    identityStart,
    identityCallback,
    identityUnlink,
    /** The caller's own link: {linked, linked_at}. Never the subject. */
    identityStatus: (connectionId, memberId) => { const l = linkOf(connectionId, memberId); return { linked: !!l, linked_at: l?.linked_at ?? null }; },
    isLinked: (connectionId, memberId) => !!linkOf(connectionId, memberId),
    /** Admin list: who is linked, never the subject. */
    identities: (connectionId) => db.all(`SELECT e.member_id, m.display_name, e.linked_at FROM external_identities e JOIN members m ON m.id = e.member_id
      WHERE e.connection_id = ? ORDER BY e.linked_at, e.member_id`, connectionId).map((r) => ({ member_id: r.member_id, display_name: r.display_name, linked_at: r.linked_at })),
    createConnection,
    revokeConnection,
    /** Token-style connect: the connector checks the token with its provider. */
    async verifyToken(provider, token) {
      const c = connectors.get(provider);
      if (!c || c.connect.kind !== 'token') throw new HubError('NOT_FOUND', 'no such token integration');
      const v = await c.connect.verifyToken({ token, fetch: restrictedFetch(c) });
      // Named fields only; its settings are provider facts, never autonomy, config or pinned.
      const facts = v?.settings === undefined ? {} : exchangeConfig(v.settings);
      if (facts === null) throw new Error('verifyToken settings over the cap');
      return { external_id: v?.external_id, display_name: v?.display_name, scopes: v?.scopes, secrets: v?.secrets ?? {}, settings: { provider: facts } };
    },
    /**
     * PATCH (D42 addendum C1): `autonomy` and `config` merged key by key in one
     * transaction (null deletes); provider and pinned are never reachable. One
     * journal row names the changed keys, never a value. `target_board_id`
     * selects an active board of this team outside the provider settings.
     */
    setSettings(id, patch, { memberId = null } = {}) {
      if (!isPlainObject(patch) || Object.keys(patch).some((k) => !['autonomy', 'config', 'target_board_id'].includes(k))) throw new HubError('VALIDATION', 'settings take autonomy, config and target_board_id only');
      if (patch.autonomy !== undefined && !isPlainObject(patch.autonomy)) throw new HubError('VALIDATION', 'autonomy must be an object');
      if (patch.config !== undefined && !isPlainObject(patch.config)) throw new HubError('VALIDATION', 'config must be an object');
      return hub.txn(() => {
        const c = row(id);
        if (!c || c.status === 'revoked') throw new HubError('NOT_FOUND', 'no such integration');
        const conn = connectors.get(c.provider);
        if (!conn) throw new HubError('NOT_FOUND', 'no such integration');
        const cur = safeJson(c.settings, {}) ?? {};
        const changed = { autonomy: [], config: [] };
        const target = patch.target_board_id === undefined ? c.target_board_id : patch.target_board_id;
        if (target !== c.target_board_id) {
          if (typeof target !== 'string' || !db.get('SELECT 1 AS x FROM boards WHERE id = ? AND org_id = ? AND archived_at IS NULL', target, c.org_id)) throw new HubError('NOT_FOUND', 'active board not found');
          changed.target_board_id = true;
        }
        const autonomy = isPlainObject(cur.autonomy) ? { ...cur.autonomy } : {};
        for (const [a, m] of Object.entries(patch.autonomy ?? {})) {
          if (POISON_KEYS.includes(a)) throw new HubError('VALIDATION', `${conn.name} has no such action`);
          // Undeclared and null: nothing to reset, and no answer that differs from {}.
          if (!Object.hasOwn(conn.actions, a)) {
            if (m === null) continue;
            throw new HubError('VALIDATION', `${conn.name} has no action ${a}`);
          }
          if (m === null) {
            if (Object.hasOwn(autonomy, a)) { delete autonomy[a]; changed.autonomy.push(a); }
            continue;
          }
          if (!AUTONOMY.includes(m)) throw new HubError('VALIDATION', 'autonomy must be auto, ask or off');
          if (autonomy[a] !== m) { autonomy[a] = m; changed.autonomy.push(a); }
        }
        const config = isPlainObject(cur.config) ? { ...cur.config } : {};
        const held = new Set(Object.keys(isPlainObject(cur.provider) ? cur.provider : {}).map((k) => k.toLowerCase()));
        for (const [k, v] of Object.entries(patch.config ?? {})) {
          if (!configKeyOk(k)) throw new HubError('VALIDATION', 'a config key is 1–64 letters, digits, _ or -, starting with a letter, and not a settings namespace');
          if (held.has(k.toLowerCase())) throw new HubError('VALIDATION', `that value comes from ${conn.name} and can't be changed here`);
          if (conn.configKeys && !conn.configKeys.includes(k)) {
            if (v === null) continue;
            throw new HubError('VALIDATION', `${conn.name} has no setting ${k}`);
          }
          if (v === null) {
            if (Object.hasOwn(config, k)) { delete config[k]; changed.config.push(k); }
            continue;
          }
          if (!configValue(v)) throw new HubError('VALIDATION', 'a config value is text, a number, true or false, or a list or object of those');
          if (JSON.stringify(config[k]) !== JSON.stringify(v)) { config[k] = v; changed.config.push(k); }
        }
        if (patch.config !== undefined && Buffer.byteLength(JSON.stringify(config)) > CONFIG_MAX_BYTES) throw new HubError('VALIDATION', 'config is over 8 KB');
        if (!changed.autonomy.length && !changed.config.length && !changed.target_board_id) return publicConnection(c);
        const next = { ...cur, ...(changed.autonomy.length ? { autonomy } : {}), ...(changed.config.length ? { config } : {}) };
        db.run('UPDATE connections SET settings = ?, target_board_id = ? WHERE id = ?', JSON.stringify(next), target, id);
        hub.journal({ board_id: null, actor_kind: memberId ? 'member' : 'system', actor_id: memberId, kind: 'integration.settings', payload: { connection_id: c.id, provider: c.provider, changed } });
        return publicConnection(row(id));
      });
    },
    audit: (id, { limit = 100 } = {}) => db.all('SELECT id, action, decision, error, card_id, external_ref, detail, undo, at FROM integration_audit WHERE connection_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', id, Math.min(500, Math.max(1, Number(limit) || 100)))
      .map((a) => ({ ...a, detail: safeJson(a.detail, {}), undo: safeJson(a.undo, null) })),
    webhookTarget,
    trustedIngress,
    webhook,
    sweepDedupe,
    oauthStart,
    oauthCallback,
    bindCookie,
    ctxFor: (id) => { const c = row(id); return c ? ctxFor(c) : null; },
  };
}
