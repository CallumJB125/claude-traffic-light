// Team API tokens (docs/PUBLIC-API.md, migration 070). A team owner or admin
// makes one with a name, a few scopes and an expiry; the hub keeps only its
// sha256 and shows the token once. It acts as the member who made it, only in
// that team, and stops working when it expires, is revoked, or that member
// leaves the team or stops being able to write (for the write scope).

import { randomBytes, randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { sha256hex } from '../auth.js';
import { limitOrThrow } from '../ratelimit.js';

export const TOKEN_PREFIX = 'plx_pat_';
export const SCOPES = Object.freeze(['read:boards', 'read:cards', 'write:cards-comment']);
export const MAX_TOKENS_PER_TEAM = 25;
export const EXPIRY_DAYS = Object.freeze({ min: 1, max: 365, default: 90 });
// A use is audited at most this often per token (every request updates last_used_at).
const USE_AUDIT_MS = 60 * 60_000;
const TOKEN_RE = /^plx_pat_[A-Za-z0-9_-]{43}$/;

const bad = (message) => new HubError('VALIDATION', message);
const unauthenticated = () => new HubError('UNAUTHENTICATED', 'missing, unknown, expired or revoked API token');

export const publicToken = (r) => ({
  id: r.id, name: r.name, hint: r.hint, scopes: JSON.parse(r.scopes), created_at: r.created_at, expires_at: r.expires_at,
  last_used_at: r.last_used_at ?? null, revoked_at: r.revoked_at ?? null,
});

export class ApiTokens {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
  }

  audit(action, { member, target, detail = null, ip = null }) {
    this.hub.accounts.audit(action, { user: member?.user_id ?? null, org: member?.org_id ?? null, target, detail, ip });
  }

  list(member) {
    return { scopes: SCOPES, tokens: this.db.all('SELECT * FROM api_tokens WHERE org_id = ? ORDER BY created_at DESC, id', member.org_id).map(publicToken) };
  }

  /** POST {name, scopes, expires_days?} → {token, secret}: the secret is never shown again. */
  create(member, body, { ip }) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || /[\p{C}]/u.test(name)) throw bad('name must be 1–80 characters, no control characters');
    const scopes = body.scopes;
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw bad(`scopes must be a non-empty list of: ${SCOPES.join(', ')}`);
    const days = body.expires_days ?? EXPIRY_DAYS.default;
    if (!Number.isInteger(days) || days < EXPIRY_DAYS.min || days > EXPIRY_DAYS.max) throw bad(`expires_days must be a whole number from ${EXPIRY_DAYS.min} to ${EXPIRY_DAYS.max}`);
    const live = this.db.get('SELECT COUNT(*) AS n FROM api_tokens WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ?', member.org_id, this.hub.iso()).n;
    if (live >= MAX_TOKENS_PER_TEAM) throw new HubError('QUOTA_EXCEEDED', `at most ${MAX_TOKENS_PER_TEAM} live API tokens per team: revoke one first`, { resource: 'api_tokens', limit: MAX_TOKENS_PER_TEAM });
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = this.hub.iso();
    const row = {
      id: randomUUID(), org_id: member.org_id, name, token_hash: sha256hex(secret), hint: secret.slice(-4), scopes: JSON.stringify([...new Set(scopes)]),
      created_by: member.id, created_at: now, expires_at: new Date(this.hub.wallMs() + days * 86_400_000).toISOString(),
    };
    this.hub.txn(() => {
      this.db.insert('api_tokens', row);
      this.audit('api_token.create', { member, target: row.id, detail: { name, scopes: JSON.parse(row.scopes), expires_at: row.expires_at }, ip });
    });
    return { token: publicToken(row), secret };
  }

  revoke(member, id, { ip }) {
    const row = this.db.get('SELECT * FROM api_tokens WHERE id = ? AND org_id = ?', id, member.org_id);
    if (!row) throw new HubError('NOT_FOUND', 'no such API token');
    if (!row.revoked_at) {
      this.hub.txn(() => {
        this.db.run('UPDATE api_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?', this.hub.iso(), member.id, id);
        this.audit('api_token.revoke', { member, target: id, ip });
      });
    }
    return { token: publicToken(this.db.get('SELECT * FROM api_tokens WHERE id = ?', id)) };
  }

  /**
   * Authorization: Bearer plx_pat_… → {token, member}. Failed attempts are
   * limited per client network; a good token is limited on its own bucket.
   */
  authenticate(req, { ipKey }) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const secret = m?.[1] ?? '';
    const fail = () => {
      limitOrThrow(this.hub, 'public_api_fail_ip', ipKey);
      return unauthenticated();
    };
    if (!TOKEN_RE.test(secret)) throw fail();
    const row = this.db.get('SELECT t.* FROM api_tokens t JOIN orgs o ON o.id = t.org_id WHERE t.token_hash = ? AND o.deleted_at IS NULL', sha256hex(secret));
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= this.hub.wallMs()) throw fail();
    const member = this.hub.activeMember(row.created_by);
    const user = member?.user_id && this.db.get('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL', member.user_id);
    if (!member || member.org_id !== row.org_id || !user) throw fail();
    limitOrThrow(this.hub, 'public_api_token', row.id);
    return { token: { ...row, scopes: JSON.parse(row.scopes) }, member };
  }

  /** After a request was authorised: last-used time, and an audit row at most hourly. */
  noteUse(token, member, { ip, route }) {
    const now = this.hub.iso();
    const audit = !token.last_audit_at || this.hub.wallMs() - Date.parse(token.last_audit_at) >= USE_AUDIT_MS;
    this.hub.txn(() => {
      this.db.run(`UPDATE api_tokens SET last_used_at = ?${audit ? ', last_audit_at = ?' : ''} WHERE id = ?`, ...(audit ? [now, now] : [now]), token.id);
      if (audit) this.audit('api_token.use', { member, target: token.id, detail: { route }, ip });
    });
  }
}
