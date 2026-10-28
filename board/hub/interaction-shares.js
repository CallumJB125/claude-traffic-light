// Team session sharing over the interaction relay (accounts mode only).
//
// The relay (interaction-relay.js) keeps every account to itself: a device
// reaches only hosts of its own user. A share is the one narrow exception:
// the owner's HOST device (the Mac holding the session, never another
// device, never the body) names one of its sessions, one team it belongs to,
// a scope and an optional expiry. Members of that team may then, from their
// own client device:
//   watch    → 'state', 'watch'   (the session's messages and responses)
//   interact → also 'send' (new turn or steer) and 'interrupt', but only for
//              members whose team role may act (owner, admin, member); a
//              team 'viewer' gets watch-only whatever the share's scope
// A teammate sees only what was sent from the moment the share was created
// (deliveries are filtered here and on the host): sharing never discloses
// earlier history, also not when the session is shared again with another team.
// Never 'list', 'launch', 'close' or 'capabilities': a teammate never sees
// the owner's other sessions, data or devices, and only the owner closes.
//
// Every shared call is re-checked before it is forwarded AND before its
// answer is returned: the caller's device token, its 'client' role, the share
// (live, unexpired, this session), the caller's and the owner's active
// membership of the share's team (team not deleted), the scope, and the
// owner's host (live, valid token, still 'host'). So removing a member,
// leaving or deleting the team, revoking either device, revoking the share
// or letting it expire cuts access at once, also mid long-poll. Unknown,
// foreign, revoked, expired and not-a-member shares all look the same (404).
//
// The frame names the caller (stamped here: user id, display name; never
// from the body) and the share; the host enforces its own copy of the share
// (src/remote-interaction.js) and refuses anything else, so a hub alone
// cannot widen a share. Per-user and per-team rate limits, the relay's
// request_id replay refusal and size limits apply. No message text is
// logged or stored by live relay calls (the separate reviewed-proposal flow
// retains its exact request for seven days); session ids are Plexiform's own, never provider
// thread ids.

import { randomUUID } from 'node:crypto';
import { InteractionProposals } from './interaction-proposals.js';
import { HubError } from './db.js';
import { limitOrThrow } from './ratelimit.js';
import { PRESENCE_MIN_MS, PRESENCE_TTL_MS } from '../shared/liveness.js';

export const SCOPES = Object.freeze({ watch: ['state', 'watch'], interact: ['state', 'watch', 'send', 'interrupt'] });
export const SHARE_LIMITS = Object.freeze({ perHost: 64, minExpiryS: 60, maxExpiryS: 30 * 86_400, viewersPerShare: 50 });
// T4d: the owner lets one acting teammate send, steer and stop in a watch share for a set time.
export const ALLOWANCE_LIMITS = Object.freeze({ minS: 60, maxS: 4 * 3600, perShare: 50 });
// Team roles that may send/steer/interrupt on an interact share; any other role watches only.
export const ACTING_ROLES = Object.freeze(['owner', 'admin', 'member']);
const MUTATING = new Set(['send', 'interrupt']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARGS = { state: ['session'], watch: ['session', 'after'], send: ['session', 'generation', 'text', 'expectedTurn'], interrupt: ['session', 'generation', 'turn'] };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const invalid = () => new HubError('VALIDATION', 'invalid share request');
const noShare = () => new HubError('NOT_FOUND', 'that shared session is not available');
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029\u2060-\u2064]/g;
// Deliveries sent before the share was created never leave the hub (the host filters too).
// A steer after the share joins a turn that may have begun before it: that turn's
// response carries pre-share output, so it is withheld unless the turn began after.
function sinceShared(result, since) {
  if (!object(result)) return result;
  if (!object(result.state) || !Array.isArray(result.state.deliveries)) return Object.hasOwn(result, 'delivery') ? { ...result, delivery: null } : result;
  const after = (d) => object(d) && Number.isFinite(d.sentAt) && d.sentAt > since;
  const fresh = new Set(result.state.deliveries.filter((d) => after(d) && d.mode === 'new-turn' && d.turn != null).map((d) => d.turn));
  const deliveries = result.state.deliveries.filter(after)
    .map((d) => (d.mode === 'new-turn' || fresh.has(d.turn) ? d : { ...d, response: '' }));
  return { ...result, state: { ...result.state, deliveries }, ...(Object.hasOwn(result, 'delivery') ? { delivery: deliveries.find((d) => d.id === result.delivery?.id) ?? null } : {}) };
}
const ACTIVE_MEMBER = `SELECT m.id, m.role FROM members m JOIN orgs o ON o.id = m.org_id
  WHERE m.org_id = ? AND m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL`;

export class InteractionShares {
  constructor(hub, relay) {
    this.hub = hub;
    this.relay = relay;
    this.proposals = new InteractionProposals(this);
    // Who has a shared session open right now: share id → (grantee user id → {at, wall}). Memory only, never stored or journaled.
    this.viewing = new Map();
  }

  get db() { return this.hub.db; }
  now() { return this.hub.iso(); }
  member(orgId, userId) { return this.db.get(ACTIVE_MEMBER, orgId, userId); }

  device(ident) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'session sharing needs the desktop app');
  }

  /** The owner side: only the host device holding the session. */
  asHost(ident) {
    this.device(ident);
    if (this.relay.role(ident.cred.id) !== 'host') throw new HubError('FORBIDDEN', 'turn on sharing sessions from this computer first');
  }

  live(row) {
    return !!row && row.revoked_at === null && (row.expires_at === null || row.expires_at > this.now());
  }

  members(orgId) {
    return this.db.all(`SELECT u.id, u.display_name AS name, m.role FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.removed_at IS NULL AND u.deleted_at IS NULL ORDER BY u.display_name, u.id`, orgId);
  }

  ownerView(row) {
    const team = this.db.get('SELECT name FROM orgs WHERE id = ?', row.org_id);
    const owner = this.db.get('SELECT display_name AS name FROM users WHERE id = ?', row.owner_user_id);
    return {
      id: row.id, session: row.session_id, team: { id: row.org_id, name: team?.name ?? 'Team' }, scope: row.scope,
      // Always present on a hub that has T4d (an older hub omits it), so the desktop app can tell the two apart.
      allowances: this.allowancesOf(row),
      // The owner's own label, so the host can keep a teammate's "Sent by" distinct from it.
      owner: { name: owner?.name ?? '' },
      created_at: row.created_at, expires_at: row.expires_at,
      viewers: this.viewersOf(row),
      // Who has access: the team's active members other than the owner, with their role (a viewer only watches).
      members: this.members(row.org_id).filter((m) => m.id !== row.owner_user_id),
    };
  }

  /** Live allowances of a share, newest first (expired rows are never reported). */
  allowancesOf(row) {
    if (row.scope !== 'watch') return [];
    return this.db.all(`SELECT a.user_id, a.expires_at FROM interaction_allowances a WHERE a.share_id = ? AND a.expires_at > ? ORDER BY a.expires_at DESC, a.user_id`, row.id, this.now())
      .filter((a) => this.member(row.org_id, a.user_id) && ACTING_ROLES.includes(this.member(row.org_id, a.user_id).role));
  }

  /** The caller's live allowance on a watch share, or null. Role and membership are the caller's, checked by authorize. */
  allowanceFor(row, userId) {
    if (row.scope !== 'watch') return null;
    return this.db.get('SELECT expires_at FROM interaction_allowances WHERE share_id = ? AND user_id = ? AND expires_at > ?', row.id, userId, this.now()) ?? null;
  }

  /** PUT (owner's host device): let one acting teammate send, steer and stop in this watch share until a set time. Replaces an earlier grant. */
  allow(ident, shareId, userId, body) {
    this.asHost(ident);
    if (!closed(body, ['expires_in_s']) || !Number.isSafeInteger(body.expires_in_s) || body.expires_in_s < ALLOWANCE_LIMITS.minS || body.expires_in_s > ALLOWANCE_LIMITS.maxS) throw invalid();
    const row = typeof shareId === 'string' && UUID.test(shareId) ? this.db.get('SELECT * FROM interaction_shares WHERE id = ?', shareId) : null;
    if (!this.live(row) || row.owner_user_id !== ident.user.id || row.host_device_id !== ident.cred.id || !this.member(row.org_id, ident.user.id)) throw noShare();
    if (typeof userId !== 'string' || !UUID.test(userId)) throw invalid();
    limitOrThrow(this.hub, 'share_write_user', ident.user.id);
    if (row.scope !== 'watch') throw new HubError('VALIDATION', 'this session is already shared to send; an allowance is for watch-only shares');
    const them = userId !== ident.user.id ? this.member(row.org_id, userId) : null;
    if (!them || !ACTING_ROLES.includes(them.role)) throw new HubError('NOT_FOUND', 'that teammate cannot be allowed to send');
    const now = this.now();
    const until = new Date(Math.min(this.hub.wallMs() + body.expires_in_s * 1000, row.expires_at ? Date.parse(row.expires_at) : Infinity)).toISOString();
    this.hub.txn(() => {
      this.db.run('DELETE FROM interaction_allowances WHERE expires_at <= ?', now);
      this.db.run('DELETE FROM interaction_allowances WHERE share_id = ? AND user_id = ?', row.id, userId);
      if (this.db.get('SELECT COUNT(*) AS n FROM interaction_allowances WHERE share_id = ?', row.id).n >= ALLOWANCE_LIMITS.perShare) throw new HubError('QUOTA_EXCEEDED', 'stop allowing someone else first');
      this.db.insert('interaction_allowances', { share_id: row.id, user_id: userId, granted_at: now, expires_at: until, granted_by: ident.user.id });
    });
    this.hub.log.info('session send allowed', { share: row.id, team: row.org_id });
    return { allowance: { user_id: userId, expires_at: until } };
  }

  /** DELETE (owner's host device): stop allowing. Idempotent. */
  disallow(ident, shareId, userId) {
    this.asHost(ident);
    const row = typeof shareId === 'string' && UUID.test(shareId) ? this.db.get('SELECT * FROM interaction_shares WHERE id = ?', shareId) : null;
    if (!row || row.owner_user_id !== ident.user.id || row.host_device_id !== ident.cred.id) throw noShare();
    if (typeof userId !== 'string' || !UUID.test(userId)) throw invalid();
    this.db.run('DELETE FROM interaction_allowances WHERE share_id = ? AND user_id = ?', row.id, userId);
    return { revoked: true };
  }

  /** GET: this host's live shares and the teams it may share with. */
  list(ident) {
    this.asHost(ident);
    const teams = this.db.all(`SELECT o.id, o.name FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL ORDER BY o.name, o.id`, ident.user.id);
    const rows = this.db.all('SELECT * FROM interaction_shares WHERE host_device_id = ? AND revoked_at IS NULL ORDER BY created_at, id', ident.cred.id);
    return { teams, shares: rows.filter((r) => this.live(r) && this.member(r.org_id, ident.user.id)).map((r) => this.ownerView(r)) };
  }

  /** POST: share one of this host's sessions with one team. Replaces a live share of the same session with the same team. */
  create(ident, body) {
    this.asHost(ident);
    if (!closed(body, ['session', 'team', 'scope', 'expires_in_s', 'request_id']) || typeof body.session !== 'string' || !UUID.test(body.session)
      || typeof body.team !== 'string' || !body.team || body.team.length > 100 || !Object.hasOwn(SCOPES, body.scope)
      || (body.expires_in_s != null && (!Number.isSafeInteger(body.expires_in_s) || body.expires_in_s < SHARE_LIMITS.minExpiryS || body.expires_in_s > SHARE_LIMITS.maxExpiryS))) throw invalid();
    limitOrThrow(this.hub, 'share_write_user', ident.user.id);
    if (!this.member(body.team, ident.user.id)) throw new HubError('NOT_FOUND', 'no such team');
    const now = this.now();
    const expires = body.expires_in_s == null ? null : new Date(this.hub.wallMs() + body.expires_in_s * 1000).toISOString();
    const id = randomUUID();
    this.hub.txn(() => {
      this.db.run('UPDATE interaction_shares SET revoked_at = ?, revoked_by = ? WHERE host_device_id = ? AND session_id = ? AND org_id = ? AND revoked_at IS NULL', now, ident.user.id, ident.cred.id, body.session, body.team);
      // Expired shares are dead: they never hold a slot.
      const count = this.db.get('SELECT COUNT(*) AS n FROM interaction_shares WHERE host_device_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', ident.cred.id, now).n;
      if (count >= SHARE_LIMITS.perHost) throw new HubError('QUOTA_EXCEEDED', 'stop sharing another session first');
      this.db.insert('interaction_shares', { id, owner_user_id: ident.user.id, host_device_id: ident.cred.id, session_id: body.session, org_id: body.team, scope: body.scope, created_at: now, expires_at: expires });
    });
    this.hub.log.info('session shared', { share: id, team: body.team, scope: body.scope });
    return { share: this.ownerView(this.db.get('SELECT * FROM interaction_shares WHERE id = ?', id)) };
  }

  /** DELETE: the owner (any of their devices) stops sharing. Idempotent; a foreign id is 404. */
  revoke(ident, shareId) {
    const row = typeof shareId === 'string' ? this.db.get('SELECT * FROM interaction_shares WHERE id = ?', shareId) : null;
    if (!row || row.owner_user_id !== ident.user.id) throw noShare();
    this.end(row, ident.user.id);
    return { revoked: true };
  }

  /** DELETE under a team: an owner or admin of the share's team ends it. */
  adminRevoke(member, shareId) {
    if (!member || member.removed_at || !['owner', 'admin'].includes(member.role)) throw new HubError('FORBIDDEN', 'only a team owner or admin can stop another member\'s share');
    const row = typeof shareId === 'string' ? this.db.get('SELECT * FROM interaction_shares WHERE id = ? AND org_id = ?', shareId, member.org_id) : null;
    if (!row) throw noShare();
    this.end(row, member.user_id ?? null);
    return { revoked: true };
  }

  end(row, by) {
    if (row.revoked_at === null) {
      this.db.run('UPDATE interaction_shares SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', this.now(), by, row.id);
      this.db.run('DELETE FROM interaction_proposals WHERE share_id = ?', row.id);
      this.db.run('DELETE FROM interaction_allowances WHERE share_id = ?', row.id);
      this.viewing.delete(row.id);
      this.hub.log.info('session share stopped', { share: row.id });
    }
  }

  /**
   * The owner's view of who is watching: grantees whose last beat is inside the TTL, still active members of
   * the share's team, newest first (at most viewersPerShare: view() refuses more). Staleness is filtered here on read; the 1 s reaper only ages entries out.
   */
  viewersOf(row) {
    const held = this.viewing.get(row.id);
    if (!held) return [];
    const now = this.hub.mono(), out = [];
    for (const [userId, v] of held) {
      if (now - v.at > PRESENCE_TTL_MS || !this.member(row.org_id, userId)) continue;
      const name = this.db.get('SELECT display_name AS name FROM users WHERE id = ? AND deleted_at IS NULL', userId)?.name;
      if (typeof name !== 'string') continue;
      out.push({ at: v.at, user_id: userId, name: name.replace(HIDDEN, '').trim().slice(0, 80) || 'Teammate', wall: v.wall });
    }
    return out.sort((a, b) => b.at - a.at).map((v) => ({ user_id: v.user_id, name: v.name, at: v.wall }));
  }

  /**
   * POST: a grantee of a live share says it has the session open (or closed). Same gate as a shared call
   * (device token, live share, caller and owner active in the team, caller is not the owner); anything else is
   * the same 404. The owner's host need not be online. Idempotent; a repeat inside PRESENCE_MIN_MS/2 is dropped.
   */
  view(ident, shareId, body) {
    if (!this.relay.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
    this.relay.asSharedClient(ident);
    if (!closed(body, ['viewing']) || typeof body.viewing !== 'boolean') throw invalid();
    const row = typeof shareId === 'string' && UUID.test(shareId) ? this.db.get('SELECT * FROM interaction_shares WHERE id = ?', shareId) : null;
    const me = this.live(row) && row.owner_user_id !== ident.user.id ? this.member(row.org_id, ident.user.id) : null;
    if (!me || !this.member(row.org_id, row.owner_user_id)) throw noShare();
    limitOrThrow(this.hub, 'share_view_user', ident.user.id);
    const held = this.viewing.get(row.id) ?? new Map(), had = held.get(ident.user.id), now = this.hub.mono();
    if (!body.viewing) {
      held.delete(ident.user.id);
      if (held.size) this.viewing.set(row.id, held); else this.viewing.delete(row.id);
      return { viewing: false };
    }
    if (had && now - had.at < PRESENCE_MIN_MS / 2) return { viewing: true };
    if (!had && held.size >= SHARE_LIMITS.viewersPerShare) return { viewing: false };
    held.set(ident.user.id, { at: now, wall: this.now() });
    this.viewing.set(row.id, held);
    return { viewing: true };
  }

  /** Reaper: forget silent viewers (TTL only; no share query). */
  sweepViewers() {
    const now = this.hub.mono();
    for (const [id, held] of this.viewing) {
      for (const [userId, v] of held) if (now - v.at > PRESENCE_TTL_MS) held.delete(userId);
      if (!held.size) this.viewing.delete(id);
    }
  }

  /** A member was removed or changed: their open views go at once. */
  dropViewer(memberId) {
    const userId = this.db.get('SELECT user_id FROM members WHERE id = ?', memberId)?.user_id;
    if (!userId) return;
    // A later re-add or promotion must not revive an allowance this member held in this team.
    this.db.run('DELETE FROM interaction_allowances WHERE user_id = ? AND share_id IN (SELECT id FROM interaction_shares WHERE org_id = (SELECT org_id FROM members WHERE id = ?))', userId, memberId);
    for (const [id, held] of this.viewing) { held.delete(userId); if (!held.size) this.viewing.delete(id); }
  }

  /** GET: sessions shared with the caller, across their teams. */
  shared(ident) {
    this.relay.asSharedClient(ident);
    const rows = this.db.all(`SELECT s.*, o.name AS team_name, u.display_name AS owner_name FROM interaction_shares s
      JOIN members m ON m.org_id = s.org_id AND m.user_id = ? AND m.removed_at IS NULL
      JOIN orgs o ON o.id = s.org_id AND o.deleted_at IS NULL
      JOIN users u ON u.id = s.owner_user_id AND u.deleted_at IS NULL
      WHERE s.revoked_at IS NULL AND s.owner_user_id != ? ORDER BY s.created_at, s.id`, ident.user.id, ident.user.id);
    const out = [];
    for (const r of rows) {
      const me = this.member(r.org_id, ident.user.id);
      if (!this.live(r) || !me || !this.member(r.org_id, r.owner_user_id)) continue;
      const allowance = ACTING_ROLES.includes(me.role) ? this.allowanceFor(r, ident.user.id) : null;
      out.push({ id: r.id, session: r.session_id, scope: ACTING_ROLES.includes(me.role) ? r.scope : 'watch', ...(allowance ? { allowance: { expires_at: allowance.expires_at } } : {}), expires_at: r.expires_at, team: { id: r.org_id, name: r.team_name }, owner: { id: r.owner_user_id, name: r.owner_name },
        online: !!this.relay.liveHost(r.owner_user_id, r.host_device_id) });
    }
    return { shared: out };
  }

  /**
   * Everything a shared call needs, checked now: → {row, host}. Any failure
   * but a scope one is the same 404; a removed or revoked caller learns
   * nothing about the share.
   */
  authorize(ident, shareId, op) {
    if (!this.relay.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
    this.relay.asSharedClient(ident);
    const row = typeof shareId === 'string' && UUID.test(shareId) ? this.db.get('SELECT * FROM interaction_shares WHERE id = ?', shareId) : null;
    const me = this.live(row) && row.owner_user_id !== ident.user.id ? this.member(row.org_id, ident.user.id) : null;
    if (!me || !this.member(row.org_id, row.owner_user_id)) throw noShare();
    const host = this.relay.liveHost(row.owner_user_id, row.host_device_id);
    if (!host) throw noShare();
    // T4d: on a watch share an acting teammate the owner has allowed holds interact until the allowance ends. `row.scope`
    // stays the share's own scope: proposals (which exist only on interact shares) check that, never this.
    const acts = ACTING_ROLES.includes(me.role), allowance = acts ? this.allowanceFor(row, ident.user.id) : null;
    const scope = allowance ? 'interact' : acts ? row.scope : 'watch';
    if (!SCOPES[scope].includes(op) || (MUTATING.has(op) && !acts)) throw new HubError('FORBIDDEN', 'this session is shared with you to watch only', { reason: 'SCOPE' });
    return { row, host, scope, allowance };
  }

  async call(ident, shareId, body, proposal = null) {
    if (!closed(body, ['request_id', 'op', 'args']) || typeof body.request_id !== 'string' || !UUID.test(body.request_id)
      || !Object.hasOwn(ARGS, body.op) || !closed(body.args, ARGS[body.op])) throw invalid();
    if (Buffer.byteLength(JSON.stringify(body.args)) > this.relay.limits.argsBytes) throw new HubError('PAYLOAD_TOO_LARGE', 'message too large');
    const { row, host, scope, allowance } = this.authorize(ident, shareId, body.op);
    // A share names one session: any other id is not shared, whatever it is.
    if (body.args.session !== row.session_id) throw noShare();
    limitOrThrow(this.hub, 'share_call_user', ident.user.id);
    limitOrThrow(this.hub, 'share_call_team', row.org_id);
    // Teammates never take the whole host: each has a small share, all of them together at most half, so the owner's own devices keep the rest.
    const lim = this.relay.limits;
    let teamPending = 0, mine = 0;
    for (const p of host.pending.values()) { if (p.by) teamPending++; if (p.by === ident.user.id) mine++; }
    if (host.pending.size >= lim.pendingPerHost || teamPending >= lim.sharedPendingPerHost || mine >= lim.pendingPerTeammate) throw new HubError('RATE_LIMITED', 'that computer is busy; try again shortly', { retry_after_s: 1 });
    if (this.relay.replayed(ident.user.id, body.request_id)) throw new HubError('CONFLICT', 'This request was already sent. Refresh and try again.', { reason: 'REPLAYED' });
    const name = this.db.get('SELECT display_name FROM users WHERE id = ?', ident.user.id)?.display_name ?? 'Teammate';
    const frame = {
      type: 'relay.request', rid: body.request_id, user: row.owner_user_id, from: ident.cred.id, op: body.op, args: body.args,
      share: { id: row.id, team: row.org_id, user: ident.user.id, name: name.slice(0, 80), scope, ...(allowance && MUTATING.has(body.op) ? { allowance_until: allowance.expires_at } : {}), ...(proposal ? { proposal } : {}) },
    };
    const result = await this.relay.dispatch(host, frame, () => this.relay.unburn(ident.user.id, body.request_id));
    // Revoked, removed or expired while the host answered: the answer is withheld.
    const again = this.authorize(ident, shareId, body.op);
    if (again.host !== host) throw noShare();
    return { share: row.id, result: sinceShared(result, Date.parse(row.created_at)) };
  }

  routes(route) {
    this.proposals.routes(route);
    const size = { maxBody: this.relay.limits.argsBytes + 1024 };
    route('GET', '/api/interaction/v1/shares', ({ ident }) => this.list(ident), { auth: 'user', replay: false });
    route('POST', '/api/interaction/v1/shares', ({ ident, body }) => this.create(ident, body), { auth: 'user', replay: false, strictBody: true });
    route('DELETE', '/api/interaction/v1/shares/:share_id', ({ ident, params }) => this.revoke(ident, params.share_id), { auth: 'user', replay: false });
    route('DELETE', '/api/teams/:team_id/interaction-shares/:share_id', ({ member, params }) => this.adminRevoke(member, params.share_id), { replay: false });
    route('PUT', '/api/interaction/v1/shares/:share_id/allowances/:user_id', ({ ident, params, body }) => this.allow(ident, params.share_id, params.user_id, body), { auth: 'user', replay: false, strictBody: true });
    route('DELETE', '/api/interaction/v1/shares/:share_id/allowances/:user_id', ({ ident, params }) => this.disallow(ident, params.share_id, params.user_id), { auth: 'user', replay: false });
    route('GET', '/api/interaction/v1/shared', ({ ident }) => this.shared(ident), { auth: 'user', replay: false });
    route('POST', '/api/interaction/v1/shared/:share_id/view', ({ ident, params, body }) => this.view(ident, params.share_id, body), { auth: 'user', replay: false, strictBody: true });
    route('POST', '/api/interaction/v1/shared/:share_id/call', ({ ident, params, body }) => this.call(ident, params.share_id, body), { auth: 'user', replay: false, strictBody: true, ...size });
  }
}
