import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { can } from '../permissions.js';
import { cleanPacketText } from '../../shared/packet-text.js';
import { requireCredentialOwner } from '../identity/credential-owner.js';
import { redact } from '../../shared/scope.js';
import { closed, invalid, unauthorized, UUID, name, origin, redirect, registeredRedirect } from './validation.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = prefix => prefix + randomBytes(32).toString('base64url');
const DAY = 86_400_000, ACCESS = 900_000;
const scopes = mode => mode === 'collaborate' ? 'boards:read boards:collaborate' : 'boards:read';
const limitError = () => new HubError('QUOTA_EXCEEDED', 'remote connection storage limit reached');
export class RemoteAuthority {
  constructor(hub) { this.hub = hub; this.db = hub.db; }
  epoch() { return this.hub.accounts.epoch(); }
  issuer() { return origin(this.hub.config.publicUrl); }
  audience(kind = 'integration') {
    if (!['mcp', 'integration'].includes(kind)) throw invalid();
    return `${this.issuer()}/api/${kind === 'mcp' ? 'mcp' : 'integration/v1'}`;
  }
  after(ms) { return new Date(this.hub.wallMs() + ms).toISOString(); }
  limit(key, maximum) {
    const value = this.hub.config.remoteLimits?.[key];
    return Number.isSafeInteger(value) ? Math.max(1, Math.min(maximum, value)) : maximum;
  }
  cleanup() {
    const now = this.hub.iso();
    for (const table of ['remote_codes', 'remote_intents', 'remote_gestures']) this.db.run(`DELETE FROM ${table} WHERE expires_at <= ?`, now);
    this.db.run("DELETE FROM remote_tokens WHERE kind = 'access' AND expires_at <= ?", now);
    // Consumed refresh hashes remain until the absolute family expiry, so
    // rotation reuse cannot become an unrecognised token after access expiry.
    this.db.run('DELETE FROM remote_tokens WHERE grant_id IN (SELECT id FROM remote_grants WHERE expires_at <= ?)', now);
  }
  session(user, cred) {
    if (!cred || cred.kind !== 'session' || !this.hub.accounts?.liveUser(user?.id)) throw unauthorized();
    requireCredentialOwner(this.hub, cred, user.id);
  }
  credential(member, cred, write = false) {
    this.session({ id: member?.user_id }, cred);
    return this.currentMember(member?.id, member?.user_id, member?.org_id, write);
  }
  currentMember(id, userId, orgId, write = false) {
    const member = this.hub.activeMember(id);
    if (!member || member.user_id !== userId || member.org_id !== orgId || !this.hub.accounts?.liveUser(userId)
      || !this.db.get('SELECT 1 x FROM orgs WHERE id = ? AND deleted_at IS NULL', orgId)) throw unauthorized();
    if (!can(member, write ? 'card.write' : 'board.read')) throw new HubError('FORBIDDEN', 'current staff role cannot use this remote operation');
    return member;
  }
  boards(member, ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw invalid();
    for (const id of ids) {
      const board = this.hub.board(id);
      if (!board || board.org_id !== member.org_id || board.archived_at) throw new HubError('NOT_FOUND', 'selected board unavailable');
    }
    return [...ids].sort();
  }
  application(id) {
    const grant = this.db.get('SELECT application FROM remote_grants WHERE id = ?', id);
    return grant ? cleanPacketText(grant.application, 100) : null;
  }
  gesture(member, cred, body) {
    closed(body, ['purpose']);
    if (!['create', 'revoke'].includes(body.purpose)) throw invalid();
    member = this.credential(member, cred);
    this.cleanup();
    if (this.db.get('SELECT count(*) n FROM remote_gestures WHERE user_id = ?', member.user_id).n >= 16
      || this.db.get('SELECT count(*) n FROM remote_gestures').n >= 10_000) throw limitError();
    const id = randomUUID(), expires_at = this.after(300_000);
    this.db.insert('remote_gestures', { id, user_id: member.user_id, org_id: member.org_id,
      cred_id: cred.id, purpose: body.purpose, session_epoch: this.epoch(), created_at: this.hub.iso(), expires_at, consumed_at: null });
    return { gesture_id: id, expires_at };
  }
  consumeGesture(member, cred, id, purpose) {
    const gesture = typeof id === 'string' && this.db.get('SELECT * FROM remote_gestures WHERE id = ?', id);
    if (!gesture || gesture.user_id !== member.user_id || gesture.org_id !== member.org_id || gesture.cred_id !== cred.id
      || gesture.purpose !== purpose || gesture.session_epoch !== this.epoch() || gesture.consumed_at || gesture.expires_at <= this.hub.iso()) {
      throw new HubError('FORBIDDEN', 'remote connection change expired; try again');
    }
    this.db.run('UPDATE remote_gestures SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', this.hub.iso(), id);
  }
  makeGrant(member, { application, boardIds, mode, expiresAt, clientId = null }) {
    if (!['read', 'collaborate'].includes(mode) || typeof expiresAt !== 'string'
      || !Number.isFinite(Date.parse(expiresAt)) || expiresAt <= this.hub.iso() || expiresAt > this.after(30 * DAY)) throw invalid();
    member = this.currentMember(member.id, member.user_id, member.org_id, mode === 'collaborate');
    this.cleanup();
    if (this.db.get('SELECT count(*) n FROM remote_grants WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', member.user_id, this.hub.iso()).n >= this.limit('activeGrants', 32)
      || this.db.get('SELECT count(*) n FROM remote_grants WHERE user_id = ?', member.user_id).n >= this.limit('storedGrants', 128)
      || this.db.get('SELECT count(*) n FROM remote_grants').n >= this.limit('totalGrants', 10_000)) throw limitError();
    if (clientId && !this.db.get('SELECT 1 x FROM remote_clients WHERE id = ? AND revoked_at IS NULL', clientId)) throw unauthorized();
    const grant = { id: randomUUID(), user_id: member.user_id, member_id: member.id, org_id: member.org_id,
      application: name(application), audience: this.audience(clientId ? 'mcp' : 'integration'), mode,
      board_ids: JSON.stringify(this.boards(member, boardIds)), session_epoch: this.epoch(), created_at: this.hub.iso(),
      expires_at: expiresAt, revoked_at: null, client_id: clientId, family_id: clientId ? randomUUID() : null };
    this.db.insert('remote_grants', grant);
    return grant;
  }
  mint(grant, kind = 'access', expiry = null) {
    this.cleanup();
    if (!['access', 'refresh'].includes(kind) || kind === 'refresh' && !grant.client_id) throw invalid();
    if (this.db.get('SELECT count(*) n FROM remote_tokens WHERE grant_id = ?', grant.id).n >= this.limit('familyTokens', 8192)
      || this.db.get('SELECT count(*) n FROM remote_tokens').n >= this.limit('totalTokens', 200_000)) throw limitError();
    const token = secret(kind === 'refresh' ? 'pfr_' : grant.client_id ? 'pfm_' : 'pfi_');
    const requested = expiry ?? this.after(kind === 'refresh' ? 7 * DAY : ACCESS);
    this.db.insert('remote_tokens', { token_hash: hash(token), grant_id: grant.id, kind,
      created_at: this.hub.iso(), expires_at: requested < grant.expires_at ? requested : grant.expires_at, consumed_at: null, revoked_at: null });
    return token;
  }
  create(member, cred, body) {
    closed(body, ['gesture_id', 'name', 'board_ids', 'mode', 'expires_days']);
    if (!Number.isSafeInteger(body.expires_days) || body.expires_days < 1 || body.expires_days > 30) throw invalid();
    member = this.credential(member, cred, body.mode === 'collaborate');
    return this.db.tx(() => {
      this.consumeGesture(member, cred, body.gesture_id, 'create');
      const grant = this.makeGrant(member, { application: body.name, boardIds: body.board_ids,
        mode: body.mode, expiresAt: this.after(body.expires_days * DAY) });
      return { grant: this.projection(grant), token: this.mint(grant, 'access', grant.expires_at) };
    });
  }
  projection(grant) {
    return { id: grant.id, name: grant.application, application_verified: false, mode: grant.mode,
      board_ids: JSON.parse(grant.board_ids), kind: grant.client_id ? 'mcp' : 'integration',
      created_at: grant.created_at, expires_at: grant.expires_at, revoked_at: grant.revoked_at };
  }
  list(member, cred) {
    member = this.credential(member, cred);
    return { grants: this.db.all('SELECT * FROM remote_grants WHERE user_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 128', member.user_id, member.org_id).map(grant => this.projection(grant)) };
  }
  revoke(member, cred, id, body) {
    closed(body, ['gesture_id']); member = this.credential(member, cred);
    return this.db.tx(() => {
      const grant = this.db.get('SELECT * FROM remote_grants WHERE id = ? AND user_id = ? AND org_id = ?', id, member.user_id, member.org_id);
      if (!grant) throw new HubError('NOT_FOUND', 'connection unavailable');
      this.consumeGesture(member, cred, body.gesture_id, 'revoke');
      this.revokeFamily(grant.id);
      return { ok: true };
    });
  }
  revokeFamily(id) {
    this.db.run('UPDATE remote_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', this.hub.iso(), id);
    this.db.run('UPDATE remote_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?', this.hub.iso(), id);
  }
  liveGrant(id, audience, write = false) {
    const grant = this.db.get('SELECT * FROM remote_grants WHERE id = ?', id);
    if (!grant || ![this.audience('mcp'), this.audience('integration')].includes(audience) || grant.audience !== audience
      || grant.revoked_at || grant.session_epoch !== this.epoch() || grant.expires_at <= this.hub.iso()) throw unauthorized();
    if (grant.client_id && !this.db.get('SELECT 1 x FROM remote_clients WHERE id = ? AND revoked_at IS NULL', grant.client_id)) throw unauthorized();
    const member = this.currentMember(grant.member_id, grant.user_id, grant.org_id, write);
    if (write && grant.mode !== 'collaborate') throw new HubError('FORBIDDEN', 'connection grants read access only');
    let ids; try { ids = JSON.parse(grant.board_ids); } catch { throw unauthorized(); }
    return { grant, member, boardIds: this.boards(member, ids), actor_key: `remote:${grant.id}`,
      mode: grant.mode === 'collaborate' && can(member, 'card.write') ? 'collaborate' : 'read' };
  }
  authenticate(token, kind = 'integration', write = false) {
    if (!['mcp', 'integration'].includes(kind) || typeof token !== 'string'
      || !(kind === 'mcp' ? /^pfm_[A-Za-z0-9_-]{43}$/ : /^pfi_[A-Za-z0-9_-]{43}$/).test(token)) throw unauthorized();
    const tokenHash = hash(token), row = this.db.get("SELECT * FROM remote_tokens WHERE token_hash = ? AND kind = 'access'", tokenHash);
    if (!row || row.revoked_at || row.consumed_at || row.expires_at <= this.hub.iso()) throw unauthorized();
    return { ...this.liveGrant(row.grant_id, this.audience(kind), write), tokenHash };
  }
  register(body, { ip = 'local' } = {}) {
    closed(body, ['client_name', 'redirect_uris', 'token_endpoint_auth_method', 'grant_types', 'response_types'], ['client_name', 'redirect_uris']);
    if (body.token_endpoint_auth_method != null && body.token_endpoint_auth_method !== 'none'
      || body.grant_types != null && JSON.stringify(body.grant_types) !== JSON.stringify(['authorization_code', 'refresh_token'])
      || body.response_types != null && JSON.stringify(body.response_types) !== JSON.stringify(['code'])) throw invalid();
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 3) throw invalid();
    const redirects = body.redirect_uris.map(redirect);
    if (new Set(redirects).size !== redirects.length || typeof ip !== 'string' || ip.length > 100) throw invalid();
    const ipHash = this.hub.refHash(ip);
    if (this.db.get('SELECT count(*) n FROM remote_clients').n >= this.limit('registeredClients', 1000)
      || this.db.get('SELECT count(*) n FROM remote_clients WHERE registered_ip_hash = ? AND created_at > ?', ipHash, this.after(-DAY)).n >= this.limit('registeredClientsPerIP', 32)) throw limitError();
    const id = randomUUID(), clientName = name(body.client_name);
    this.db.insert('remote_clients', { id, name: clientName, redirects: JSON.stringify(redirects),
      registered_ip_hash: ipHash, created_at: this.hub.iso(), revoked_at: null });
    return { client_id: id, client_name: clientName, redirect_uris: redirects, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }
  authorize(params) {
    closed(params, ['client_id', 'redirect_uri', 'response_type', 'state', 'resource', 'code_challenge', 'code_challenge_method', 'scope']);
    if (typeof params.client_id !== 'string' || !UUID.test(params.client_id)) throw invalid();
    const client = this.db.get('SELECT * FROM remote_clients WHERE id = ? AND revoked_at IS NULL', params.client_id);
    if (!client || !registeredRedirect(JSON.parse(client.redirects), params.redirect_uri) || params.response_type !== 'code'
      || params.resource !== this.audience('mcp') || params.code_challenge_method !== 'S256'
      || typeof params.code_challenge !== 'string' || !/^[-_A-Za-z0-9]{43}$/.test(params.code_challenge)
      || typeof params.state !== 'string' || params.state.length < 1 || params.state.length > 512 || /[\x00-\x1f\x7f]/.test(params.state) || redact(params.state, null) !== params.state
      || !['boards:read', 'boards:read boards:collaborate'].includes(params.scope)) throw invalid();
    this.cleanup();
    if (this.db.get('SELECT count(*) n FROM remote_intents').n >= this.limit('pendingIntents', 1000)) throw limitError();
    const id = randomUUID(), browser = secret('pfc_');
    this.db.insert('remote_intents', { id, client_id: client.id, browser_hash: hash(browser), data: JSON.stringify(params),
      session_epoch: this.epoch(), created_at: this.hub.iso(), expires_at: this.after(600_000),
      approving_user_id: null, approving_session_id: null, consumed_at: null });
    return { intent_id: id, browser };
  }
  intent(id, browser) {
    const intent = typeof id === 'string' && this.db.get('SELECT i.*, c.name FROM remote_intents i JOIN remote_clients c ON c.id = i.client_id WHERE i.id = ? AND c.revoked_at IS NULL', id);
    if (!intent || typeof browser !== 'string' || !/^pfc_[A-Za-z0-9_-]{43}$/.test(browser) || hash(browser) !== intent.browser_hash
      || intent.consumed_at || intent.session_epoch !== this.epoch() || intent.expires_at <= this.hub.iso()) throw new HubError('FORBIDDEN', 'authorization expired; reconnect');
    return intent;
  }
  preview(id, browser, identity = null) {
    return this.db.tx(() => {
      const intent = this.intent(id, browser), params = JSON.parse(intent.data);
      if (identity) {
        this.session(identity.user, identity.cred);
        if (intent.approving_user_id && (intent.approving_user_id !== identity.user.id || intent.approving_session_id !== identity.cred.id)) throw unauthorized();
        if (!intent.approving_user_id) this.db.run('UPDATE remote_intents SET approving_user_id = ?, approving_session_id = ? WHERE id = ?', identity.user.id, identity.cred.id, id);
      }
      return { intent_id: id, name: cleanPacketText(intent.name, 100), application_verified: false, scope: params.scope, expires_at: intent.expires_at };
    });
  }
  consent(member, cred, id, browser, body) {
    closed(body, ['approve', 'board_ids', 'mode']);
    if (typeof body.approve !== 'boolean') throw invalid();
    member = this.credential(member, cred);
    return this.db.tx(() => {
      const intent = this.intent(id, browser), params = JSON.parse(intent.data), target = new URL(params.redirect_uri);
      if (intent.approving_user_id !== member.user_id || intent.approving_session_id !== cred.id) throw unauthorized();
      if (body.approve) {
        if (body.mode === 'collaborate' && !params.scope.includes('boards:collaborate')) throw invalid();
        const grant = this.makeGrant(member, { application: intent.name, boardIds: body.board_ids, mode: body.mode,
          expiresAt: this.after(30 * DAY), clientId: intent.client_id });
        const code = secret('pfcode_');
        this.db.insert('remote_codes', { code_hash: hash(code), grant_id: grant.id, redirect_uri: params.redirect_uri,
          challenge: params.code_challenge, created_at: this.hub.iso(), expires_at: this.after(60_000), consumed_at: null });
        target.searchParams.set('code', code);
      } else target.searchParams.set('error', 'access_denied');
      this.db.run('UPDATE remote_intents SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', this.hub.iso(), id);
      target.searchParams.set('iss', this.issuer()); target.searchParams.set('state', params.state);
      return { redirect_uri: target.href };
    });
  }
  tokens(grant) {
    return { access_token: this.mint(grant), refresh_token: this.mint(grant, 'refresh'), token_type: 'Bearer',
      expires_in: Math.max(0, Math.min(ACCESS, Date.parse(grant.expires_at) - this.hub.wallMs()) / 1000), scope: scopes(grant.mode) };
  }
  token(body) {
    if (body?.grant_type === 'authorization_code') {
      closed(body, ['grant_type', 'code', 'redirect_uri', 'client_id', 'code_verifier', 'resource']);
      if (typeof body.code_verifier !== 'string' || !/^[-._~A-Za-z0-9]{43,128}$/.test(body.code_verifier)
        || typeof body.code !== 'string' || !/^pfcode_[A-Za-z0-9_-]{43}$/.test(body.code)) throw unauthorized();
      return this.db.tx(() => {
        const code = this.db.get('SELECT * FROM remote_codes WHERE code_hash = ?', hash(body.code));
        const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
        if (!code || code.consumed_at || code.expires_at <= this.hub.iso() || code.redirect_uri !== body.redirect_uri || code.challenge !== challenge) throw unauthorized();
        const { grant } = this.liveGrant(code.grant_id, this.audience('mcp'));
        if (grant.client_id !== body.client_id || body.resource !== this.audience('mcp')) throw unauthorized();
        this.db.run('UPDATE remote_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL', this.hub.iso(), code.code_hash);
        return this.tokens(grant);
      });
    }
    if (body?.grant_type === 'refresh_token') {
      closed(body, ['grant_type', 'refresh_token', 'client_id', 'resource']);
      if (typeof body.refresh_token !== 'string' || !/^pfr_[A-Za-z0-9_-]{43}$/.test(body.refresh_token)) throw unauthorized();
      // A reuse refusal must commit revocation instead of rolling it back.
      const result = this.db.tx(() => {
        const token = this.db.get("SELECT * FROM remote_tokens WHERE token_hash = ? AND kind = 'refresh'", hash(body.refresh_token));
        const grant = token && this.db.get('SELECT * FROM remote_grants WHERE id = ?', token.grant_id);
        if (!grant || grant.client_id !== body.client_id || grant.audience !== body.resource || body.resource !== this.audience('mcp')) throw unauthorized();
        if (token.consumed_at) { this.revokeFamily(grant.id); return null; }
        if (token.revoked_at || token.expires_at <= this.hub.iso()) throw unauthorized();
        this.liveGrant(grant.id, body.resource);
        this.db.run('UPDATE remote_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL', this.hub.iso(), token.token_hash);
        return this.tokens(grant);
      });
      if (!result) throw unauthorized();
      return result;
    }
    throw invalid();
  }
  revokeToken(body) {
    closed(body, ['token', 'client_id', 'token_type_hint'], ['token', 'client_id']);
    if (typeof body.token !== 'string' || body.token.length > 128 || typeof body.client_id !== 'string'
      || body.token_type_hint != null && !['access_token', 'refresh_token'].includes(body.token_type_hint)) throw invalid();
    return this.db.tx(() => {
      const grant = this.db.get('SELECT g.* FROM remote_grants g JOIN remote_tokens t ON t.grant_id = g.id WHERE t.token_hash = ? AND g.client_id = ?', hash(body.token), body.client_id);
      if (grant) this.revokeFamily(grant.id);
      return {};
    });
  }
}
