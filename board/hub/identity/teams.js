// BOARD_AUTH=accounts, P2 (ACCOUNTS-API.md "Teams and members", CONTRACT
// D59–D62): create a team (the creator becomes owner, one board is made),
// read / rename / soft-delete it, list members, change roles under the role
// ceilings, remove members (or leave), add boards, and the free-plan quotas.
// Every handler here receives the caller's membership in the team named by
// the URL, resolved by hub/http.js from the resource (never a "current team").

import { randomBytes, randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { limitOrThrow } from '../ratelimit.js';
import { emailOnlyIdentity } from '../views.js';
import { can, canSetRole, ROLES } from '../permissions.js';

export const PURGE_AFTER_MS = 7 * 86_400_000;
const NAME_MAX = 60;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED_SLUGS = new Set([
  'account', 'admin', 'api', 'app', 'auth', 'board', 'boards', 'buddy', 'device', 'devices', 'download', 'help', 'invite',
  'invites', 'join', 'login', 'new', 'settings', 'shared', 'signin', 'signout', 'static', 'support', 'team', 'teams', 'web', 'www',
]);

// Free-plan limits (design §9.3): pro = ×10, self_hosted = none.
export const FREE_QUOTAS = Object.freeze({ members: 25, boards: 10, teams: 10, pending_invites: 100 });
export function quotaFor(plan, resource) {
  if (plan === 'self_hosted') return Infinity;
  return FREE_QUOTAS[resource] * (plan === 'pro' ? 10 : 1);
}
const quotaError = (resource, limit) => new HubError('QUOTA_EXCEEDED', `this team's plan allows at most ${limit} ${resource.replace('_', ' ')}`, { resource, limit });

/** A team name: 1–60 visible characters, no control or format characters. */
export function teamName(v) {
  if (typeof v !== 'string') throw new HubError('VALIDATION', 'name required');
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > NAME_MAX || /[\p{C}]/u.test(s)) throw new HubError('VALIDATION', `name must be 1–${NAME_MAX} characters, no control characters`);
  return s;
}

export function slugify(name) {
  const s = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return SLUG_RE.test(s) && !RESERVED_SLUGS.has(s) ? s : `team-${randomBytes(4).toString('hex').slice(0, 6)}`;
}

/** A free slug for `name`: the slugified name, then -2, -3 …, then a random tail. */
export function uniqueSlug(db, name) {
  const base = slugify(name);
  const taken = (s) => !!db.get('SELECT 1 AS x FROM orgs WHERE slug = ?', s);
  if (!taken(base)) return base;
  for (let i = 2; i < 50; i++) {
    const s = `${base.slice(0, 40 - String(i).length - 1)}-${i}`;
    if (!taken(s)) return s;
  }
  return `${base.slice(0, 33)}-${randomBytes(3).toString('hex')}`;
}

/** Teams made by the legacy paths (seed, bootstrap) after migration 009 get a slug. */
export function backfillSlugs(db) {
  for (const o of db.all('SELECT id, name FROM orgs WHERE slug IS NULL ORDER BY created_at, id')) {
    db.run('UPDATE orgs SET slug = ? WHERE id = ? AND slug IS NULL', uniqueSlug(db, o.name), o.id);
  }
}

const keyPrefix = (name) => (String(name).normalize('NFKD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'BRD');

export const publicTeam = (o) => ({ id: o.id, name: o.name, slug: o.slug, plan: o.plan });

export class Teams {
  constructor(hub, { accounts }) {
    this.hub = hub;
    this.db = hub.db;
    this.accounts = accounts;
    backfillSlugs(this.db);
  }

  audit(action, member, { ip, target = null, detail = null, user = null } = {}) {
    this.accounts.audit(action, { user: user ?? member?.user_id ?? null, org: member?.org_id ?? null, target, detail, ip });
  }

  org(id) { return this.db.get('SELECT * FROM orgs WHERE id = ? AND deleted_at IS NULL', id); }

  count(sql, ...args) { return this.db.get(sql, ...args).n; }
  activeMembers(orgId) { return this.count('SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND removed_at IS NULL', orgId); }

  // ── teams ─────────────────────────────────────────────────────────────────

  /** POST /api/teams {name, slug?} → {team, board}. The creator becomes owner. */
  create(ident, body, { ip }) {
    const user = ident.user;
    if (!user.primary_email_verified_at || !user.primary_email) throw new HubError('EMAIL_UNVERIFIED', 'verify your email address before creating a team');
    const name = teamName(body.name);
    let slug = null;
    if (body.slug != null) {
      if (typeof body.slug !== 'string' || !SLUG_RE.test(body.slug) || RESERVED_SLUGS.has(body.slug)) throw new HubError('VALIDATION', 'slug must be 3–40 of a-z, 0-9 and -, not starting or ending with -');
      if (this.db.get('SELECT 1 AS x FROM orgs WHERE slug = ?', body.slug)) throw new HubError('CONFLICT', 'that slug is taken');
      slug = body.slug;
    }
    const owned = this.count(`SELECT COUNT(*) AS n FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.role = 'owner' AND m.removed_at IS NULL AND o.deleted_at IS NULL`, user.id);
    const limit = quotaFor('free', 'teams');
    if (owned >= limit) throw quotaError('teams', limit);
    limitOrThrow(this.hub, 'team_create_user', user.id);
    const now = this.hub.iso();
    const org = { id: randomUUID(), name, created_at: now, slug: slug ?? uniqueSlug(this.db, name), plan: 'free', created_by_user: user.id };
    const board = { id: randomUUID(), org_id: org.id, name, key_prefix: keyPrefix(name) };
    const member = {
      id: randomUUID(), org_id: org.id, user_id: user.id, role: 'owner', display_name: user.display_name, email: user.primary_email,
      ...emailOnlyIdentity(user.primary_email), joined_via: 'created_team', created_at: now,
    };
    this.hub.txn(() => {
      this.db.insert('orgs', org);
      this.db.insert('boards', board);
      this.db.insert('members', member);
      this.audit('team.create', member, { ip, target: org.id, detail: { slug: org.slug } });
    });
    return { team: publicTeam(this.org(org.id)), board: { id: board.id, name: board.name, key_prefix: board.key_prefix } };
  }

  /** GET /api/teams/:team_id */
  get(member) {
    const o = this.org(member.org_id);
    const counts = {
      members: this.activeMembers(o.id),
      boards: this.count('SELECT COUNT(*) AS n FROM boards WHERE org_id = ?', o.id),
      ...(can(member, 'invite.list') ? { pending_invites: this.hub.invites.pendingCount(o.id) } : {}),
    };
    const quotas = Object.fromEntries(['members', 'boards'].map((r) => [r, Number.isFinite(quotaFor(o.plan, r)) ? quotaFor(o.plan, r) : null]));
    return { team: publicTeam(o), me: { member_id: member.id, role: member.role }, counts, quotas };
  }

  /** PATCH /api/teams/:team_id {name} (admin). */
  update(member, body, { ip }) {
    if (!can(member, 'team.settings')) throw new HubError('FORBIDDEN', 'only admins can rename the team');
    const o = this.org(member.org_id);
    if (body.name === undefined) return { team: publicTeam(o) };
    const name = teamName(body.name);
    if (name !== o.name) {
      this.hub.txn(() => {
        this.db.run('UPDATE orgs SET name = ? WHERE id = ?', name, o.id);
        this.audit('team.update', member, { ip, target: o.id, detail: { fields: ['name'] } });
      });
    }
    return { team: publicTeam(this.org(o.id)) };
  }

  /**
   * DELETE /api/teams/:team_id {confirm_slug, flow_id} (owner, with a fresh
   * purpose:'delete' step-up that this spends): soft delete. Every
   * route 404s at once, runner devices are revoked (their sockets close
   * 4403), pending invites die and browser sockets on the team close 4403.
   * The hard purge after 7 days is P5.
   */
  remove(member, body, { ip }) {
    if (!can(member, 'team.delete')) throw new HubError('FORBIDDEN', 'only an owner can delete the team');
    const o = this.org(member.org_id);
    if (body.confirm_slug !== o.slug) throw new HubError('VALIDATION', 'confirm_slug must be the team slug');
    // Like deleting the account: a fresh email code first (M4), of its own purpose (L-H).
    const step = this.accounts.requireStepUp(member.user_id, body.flow_id, 'delete_team');
    return this.deleteTeam(o, { member, ip, step });
  }

  /**
   * Soft-delete a team: every device of its members revoked, pending invites
   * withdrawn, integrations revoked, purge in 7 days. Also the operator's
   * `hub/admin.js delete-team` (no member, no step-up).
   */
  deleteTeam(o, { member = null, ip = null, step = null } = {}) {
    const now = this.hub.iso();
    const members = this.db.all('SELECT id FROM members WHERE org_id = ? AND removed_at IS NULL', o.id);
    const devices = this.db.all('SELECT d.id FROM devices d JOIN members m ON m.id = d.member_id WHERE m.org_id = ? AND d.revoked_at IS NULL', o.id);
    const purgeAfter = new Date(this.hub.wallMs() + PURGE_AFTER_MS).toISOString();
    this.hub.txn(() => {
      if (step) this.accounts.consumeStepUp(step);
      this.db.run('UPDATE orgs SET deleted_at = ?, purge_after = ? WHERE id = ?', now, purgeAfter, o.id);
      this.db.run('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL AND member_id IN (SELECT id FROM members WHERE org_id = ?)', now, o.id);
      this.hub.invites.revokeWhere('org_id', o.id, 'team_deleted');
      this.hub.revokeDeletedTeamConnections(now);
      this.audit('team.delete', member ?? { org_id: o.id }, { ip, target: o.id, detail: { purge_after: purgeAfter, ...(member ? {} : { by: 'operator' }) } });
      this.hub.later(() => {
        for (const d of devices) {
          this.hub.runners.get(d.id)?.close(4403, 'team deleted');
          this.hub.presence.dropDevice(d.id);
        }
        for (const m of members) this.hub.memberChanged(m.id);
      });
    });
    return { ok: true, purge_after: purgeAfter };
  }

  // ── boards ────────────────────────────────────────────────────────────────

  /** POST /api/teams/:team_id/boards {name, key_prefix?} (admin). */
  createBoard(member, body, { ip }) {
    if (!can(member, 'board.create')) throw new HubError('FORBIDDEN', 'only admins can add boards');
    const o = this.org(member.org_id);
    const name = teamName(body.name);
    const prefix = body.key_prefix ?? keyPrefix(name);
    if (typeof prefix !== 'string' || !/^[A-Z]{1,10}$/.test(prefix)) throw new HubError('VALIDATION', 'key_prefix must be 1–10 capital letters');
    const limit = quotaFor(o.plan, 'boards');
    if (this.count('SELECT COUNT(*) AS n FROM boards WHERE org_id = ?', o.id) >= limit) throw quotaError('boards', limit);
    const board = { id: randomUUID(), org_id: o.id, name, key_prefix: prefix };
    this.hub.txn(() => {
      this.db.insert('boards', board);
      this.audit('board.create', member, { ip, target: board.id });
    });
    return { board: { id: board.id, name, key_prefix: prefix } };
  }

  // ── members ───────────────────────────────────────────────────────────────

  /** GET /api/teams/:team_id/members: names for everyone, emails for admins. */
  listMembers(member) {
    const emails = can(member, 'members.emails');
    const rows = this.db.all('SELECT * FROM members WHERE org_id = ? AND removed_at IS NULL ORDER BY created_at, id', member.org_id);
    const rank = { owner: 0, admin: 1, member: 2, viewer: 3 };
    rows.sort((a, b) => rank[a.role] - rank[b.role] || a.display_name.localeCompare(b.display_name));
    return {
      members: rows.map((m) => ({
        member_id: m.id, user_id: m.user_id, display_name: m.display_name, role: m.role, joined_at: m.created_at,
        ...(emails ? { email: m.email } : {}),
      })),
    };
  }

  target(member, id) {
    const t = this.hub.activeMember(id);
    if (!t || t.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'member not found');
    return t;
  }

  lastOwner(t) {
    return t.role === 'owner' && !this.db.get("SELECT 1 AS x FROM members WHERE org_id = ? AND id != ? AND role = 'owner' AND removed_at IS NULL", t.org_id, t.id);
  }

  /** PATCH /api/teams/:team_id/members/:member_id {role} */
  setRole(member, id, body, { ip }) {
    const t = this.target(member, id);
    const role = body.role;
    if (!ROLES.includes(role)) throw new HubError('VALIDATION', `role must be one of ${ROLES.join(', ')}`);
    if (!canSetRole(member, t, role)) throw new HubError('FORBIDDEN', member.role === 'admin' ? 'admins cannot change owners or make owners' : 'only admins can change roles');
    if (role === t.role) return { member: this.memberView(t, member) };
    if (this.lastOwner(t)) throw new HubError('CONFLICT', 'a team needs an owner: make someone else owner first', { reason: 'LAST_OWNER' });
    this.hub.txn(() => {
      this.db.run('UPDATE members SET role = ? WHERE id = ?', role, t.id);
      this.audit('member.role', member, { ip, target: t.id, detail: { from: t.role, to: role } });
      this.hub.later(() => this.hub.memberChanged(t.id));
    });
    return { member: this.memberView(this.hub.member(t.id), member) };
  }

  memberView(m, viewer) {
    return { member_id: m.id, user_id: m.user_id, display_name: m.display_name, role: m.role, joined_at: m.created_at, ...(can(viewer, 'members.emails') ? { email: m.email } : {}) };
  }

  /**
   * DELETE /api/teams/:team_id/members/:member_id: an admin removes someone
   * (owners only by an owner), or anyone leaves. Soft: the row stays for
   * history; runner devices are revoked and closed, invites they sent that
   * nobody used die, and their browser sockets on this team close 4403.
   */
  removeMember(member, id, { ip }) {
    const t = this.target(member, id);
    const self = t.id === member.id;
    if (!can(member, 'member.remove', { target: t })) throw new HubError('FORBIDDEN', t.role === 'owner' ? 'only an owner can remove an owner' : 'only admins can remove members');
    if (this.lastOwner(t)) throw new HubError('CONFLICT', 'a team needs an owner: make someone else owner first', { reason: 'LAST_OWNER' });
    const now = this.hub.iso();
    const devices = this.db.all('SELECT id FROM devices WHERE member_id = ? AND revoked_at IS NULL', t.id);
    this.hub.txn(() => {
      this.db.run('UPDATE members SET removed_at = ? WHERE id = ?', now, t.id);
      this.db.run('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL', now, t.id);
      this.hub.invites.revokeWhere('created_by', t.id, 'inviter_removed');
      this.audit(self ? 'member.leave' : 'member.remove', member, { ip, target: t.id, detail: { role: t.role } });
      this.hub.later(() => {
        for (const d of devices) {
          this.hub.runners.get(d.id)?.close(4403, 'member removed');
          this.hub.presence.dropDevice(d.id);
        }
        this.hub.memberChanged(t.id);
      });
    });
    return { ok: true };
  }
}
