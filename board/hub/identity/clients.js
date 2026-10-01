// Client users share only explicit project projections; they are never
// ordinary members, viewers, runner targets or integration actors.
import { randomBytes, randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { sha256hex } from '../auth.js';
import { can } from '../permissions.js';
import { ipKey, limitOrThrow } from '../ratelimit.js';
import { teamName, quotaFor } from './teams.js';
import { normalizeEmail, mailName } from './accounts.js';
import { INVITE_TTL_MS, firstName } from './invites.js';
import { BRAND } from '../../shared/brand.js';
import { requireCredentialOwner } from './credential-owner.js';

export const CLIENT_SCOPES = Object.freeze(['status.read', 'artifacts.read', 'feedback.create', 'approvals.decide']);
const TOKEN_RE = /^clinv_[A-Za-z0-9_-]{43}$/;
const invalid = () => new HubError('INVALID_TOKEN', 'this client invite is not valid: ask for a new invitation');
export const clientMissing = () => new HubError('NOT_FOUND', 'client resource not found');
const missing = clientMissing;
export const clientText = (v, max, required = false) => {
  if (v == null && !required) return '';
  if (typeof v !== 'string' || v.length > max || /[\p{C}&&[^\n\t]]/v.test(v) || required && !v.trim()) throw new HubError('VALIDATION', 'invalid client text');
  return v.trim();
};
const text = clientText;
export const clientOnly = (body, keys) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) throw new HubError('VALIDATION', 'unknown client field');
};
const only = clientOnly;

export class Clients {
  constructor(hub) { this.hub = hub; this.db = hub.db; }
  now() { return this.hub.iso(); }
  workspace(id) { return this.db.get('SELECT c.*, o.name, o.plan FROM client_workspaces c JOIN orgs o ON o.id = c.org_id WHERE c.org_id = ? AND o.deleted_at IS NULL', id); }
  publicWorkspace(w) { return { id: w.org_id, name: w.name }; }
  staff(member, action = 'invite.create', cred = null) {
    requireCredentialOwner(this.hub, cred, member?.user_id);
    const live = this.hub.activeMember(member?.id);
    if (!live || live.user_id !== member.user_id || !this.hub.accounts.liveUser(live.user_id) || live.org_id !== member.org_id || !this.workspace(member.org_id)) throw missing();
    if (!can(live, action)) throw new HubError('FORBIDDEN', 'client workspace admin required');
    return live;
  }
  audit(kind, { user = null, member = null, workspace = null, target = null, ip = null } = {}) {
    this.hub.accounts.audit(kind, { user: user?.id ?? member?.user_id ?? null, org: workspace ?? member?.org_id, target, ip });
    this.hub.journal({ board_id: null, actor_kind: member ? 'member' : 'system', actor_id: member?.id ?? null, kind, payload: { workspace_id: workspace ?? member?.org_id ?? null, target_id: target, ...(user ? { user_id: user.id } : {}) } });
  }
  activeGuestCount(id) { return this.db.get('SELECT COUNT(*) AS n FROM client_guests g JOIN users u ON u.id = g.user_id WHERE g.workspace_id = ? AND g.revoked_at IS NULL AND u.deleted_at IS NULL', id).n; }
  pendingCount(id) { return this.db.get('SELECT COUNT(*) AS n FROM client_invites WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', id, this.now()).n; }
  quota(id, replacing = null) {
    const w = this.workspace(id); if (!w) throw missing();
    const limit = quotaFor(w.plan, 'members');
    const pending = this.pendingCount(id) + this.hub.invites.pendingCount(id) - (replacing ? 1 : 0);
    if (this.hub.teams.activeMembers(id) + this.activeGuestCount(id) + pending >= limit) throw new HubError('QUOTA_EXCEEDED', 'client workspace seat limit reached', { resource: 'members', limit });
    const cap = quotaFor(w.plan, 'pending_invites');
    if (pending >= cap) throw new HubError('QUOTA_EXCEEDED', 'client invitation limit reached', { resource: 'pending_invites', limit: cap });
  }
  create(ident, body, { ip }) {
    only(body, ['request_id', 'name', 'agency_team_id']);
    const key = text(body.request_id, 100, true); const name = teamName(body.name);
    return this.hub.txn(() => {
      const user = this.hub.accounts.liveUser(ident.user.id);
      if (!user) throw new HubError('UNAUTHENTICATED', 'sign in again');
      ident = { ...ident, user };
      const prev = this.db.get('SELECT org_id FROM client_workspace_requests WHERE user_id = ? AND request_id = ?', ident.user.id, key);
      if (prev) {
        const w = this.workspace(prev.org_id);
        const member = this.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', prev.org_id, ident.user.id);
        if (!w || !can(member, 'board.read')) throw missing();
        return this.created(w);
      }
      if (body.agency_team_id != null) {
        const agency = this.db.get('SELECT m.* FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL', body.agency_team_id, ident.user.id);
        if (!can(agency, 'team.settings')) throw missing();
      }
      const result = this.hub.teams.create(ident, { name }, { ip });
      const at = this.now();
      this.db.insert('client_workspaces', { org_id: result.team.id, agency_org_id: body.agency_team_id ?? null, created_by_user: ident.user.id, created_at: at });
      this.db.insert('client_projects', { id: randomUUID(), workspace_id: result.team.id, board_id: result.board.id, name, created_at: at });
      this.db.insert('client_workspace_requests', { user_id: ident.user.id, request_id: key, org_id: result.team.id });
      this.audit('client.workspace.create', { user: ident.user, workspace: result.team.id, target: result.team.id, ip });
      return this.created(this.workspace(result.team.id));
    });
  }
  created(w) { return { workspace: this.publicWorkspace(w), projects: this.projectsForStaff(w.org_id) }; }
  projectsForStaff(id) { return this.db.all('SELECT id, name, board_id FROM client_projects WHERE workspace_id = ? ORDER BY name, id', id); }
  manage(member) {
    this.staff(member);
    return { ...this.created(this.workspace(member.org_id)), guests: this.db.all(`SELECT g.id, u.display_name, u.primary_email AS email, g.revoked_at FROM client_guests g JOIN users u ON u.id = g.user_id WHERE g.workspace_id = ? AND u.deleted_at IS NULL ORDER BY g.joined_at`, member.org_id).map((g) => ({ ...g, grants: this.grantsFor(g.id) })), invites: this.db.all('SELECT id, email, grants, expires_at FROM client_invites WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', member.org_id, this.now()).filter((i) => this.usable({ ...i, workspace_id: member.org_id, created_by: this.db.get('SELECT created_by FROM client_invites WHERE id = ?', i.id).created_by })).map((i) => ({ ...i, grants: JSON.parse(i.grants) })) };
  }
  grantsFor(guestId) { return this.db.all('SELECT project_id, scopes FROM client_grants WHERE guest_id = ? ORDER BY project_id', guestId).map((g) => ({ ...g, scopes: JSON.parse(g.scopes) })); }
  grants(id, value) {
    if (!Array.isArray(value) || !value.length || value.length > 20) throw new HubError('VALIDATION', 'choose 1–20 client projects');
    const seen = new Set();
    return value.map((g) => {
      only(g, ['project_id', 'scopes']);
      if (typeof g.project_id !== 'string' || seen.has(g.project_id) || !this.db.get('SELECT 1 AS x FROM client_projects WHERE id = ? AND workspace_id = ?', g.project_id, id)) throw missing();
      seen.add(g.project_id);
      if (!Array.isArray(g.scopes) || !g.scopes.length || g.scopes.some((s) => !CLIENT_SCOPES.includes(s)) || new Set(g.scopes).size !== g.scopes.length || !g.scopes.includes('status.read')) throw new HubError('VALIDATION', 'invalid client scope');
      return { project_id: g.project_id, scopes: [...g.scopes].sort() };
    });
  }
  usable(inv) {
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= this.now() || !this.workspace(inv.workspace_id)) return false;
    const actor = this.hub.activeMember(inv.created_by);
    return actor?.org_id === inv.workspace_id && can(actor, 'invite.create');
  }
  admission(email) { return this.db.all('SELECT * FROM client_invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', email, this.now()).some((i) => this.usable(i)); }
  pendingFor(user) {
    const emails = this.hub.invites.verifiedEmails(user); if (!emails.length) return [];
    return this.db.all(`SELECT i.*, o.name AS workspace_name, m.display_name AS by_name FROM client_invites i JOIN orgs o ON o.id = i.workspace_id JOIN members m ON m.id = i.created_by WHERE i.email IN (${emails.map(() => '?').join(',')}) AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at`, ...emails, this.now()).filter((i) => this.usable(i)).map((i) => ({ id: i.id, workspace_name: i.workspace_name, inviter_first_name: firstName(i.by_name), expires_at: i.expires_at }));
  }
  invite(member, body, { ip, req }) {
    only(body, ['request_id', 'email', 'grants']); this.staff(member);
    if (!this.hub.accounts.liveUser(member.user_id)?.primary_email_verified_at) throw new HubError('EMAIL_UNVERIFIED', 'verify your email before inviting clients');
    const email = normalizeEmail(body.email), grants = this.grants(member.org_id, body.grants);
    if (this.db.get('SELECT 1 AS x FROM client_invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', member.org_id, email, this.now())) throw new HubError('CONFLICT', 'a client invite is pending: resend it');
    if (this.db.get('SELECT 1 AS x FROM client_guests g JOIN users u ON u.id = g.user_id WHERE g.workspace_id = ? AND g.revoked_at IS NULL AND u.primary_email = ? AND u.deleted_at IS NULL', member.org_id, email)) throw new HubError('CONFLICT', 'this client already has access');
    this.quota(member.org_id); this.inviteLimits(member, ip);
    return this.issue(member, email, grants, { ip, req });
  }
  inviteLimits(member, ip) {
    limitOrThrow(this.hub, 'invite_team', member.org_id); limitOrThrow(this.hub, 'invite_user', member.user_id); limitOrThrow(this.hub, 'invite_ip', ipKey(ip));
  }
  issue(member, email, grants, { ip, req }) {
    const token = `clinv_${randomBytes(32).toString('base64url')}`, id = randomUUID(), at = this.now();
    const origin = this.hub.accounts.linkOrigin(req); if (!origin) throw new HubError('VALIDATION', 'hub has no public invitation origin');
    const expires = new Date(this.hub.wallMs() + INVITE_TTL_MS).toISOString();
    const link = `${origin}/client-invite#${token}`;
    this.hub.txn(() => {
      this.staff(member);
      this.db.insert('client_invites', { id, workspace_id: member.org_id, email, token_hash: sha256hex(token), grants: JSON.stringify(grants), created_by: member.id, created_at: at, expires_at: expires });
      this.audit('client.invite.create', { member, target: id, ip });
    });
    const w = this.workspace(member.org_id);
    const mailed = !!this.hub.accounts.mailer && this.hub.accounts.mailBudget(email);
    if (mailed) this.hub.later(() => this.hub.accounts.mailer.send({ to: email, subject: `${firstName(member.display_name)} invited you to ${mailName(w.name)} on ${BRAND.name}`, text: `View your project status and shared deliverables in ${mailName(w.name)}.\n\n${link}\n\nThis invitation is for ${email}, expires in 7 days, and grants only the listed client projects. It does not grant developer tools.\n`, idempotencyKey: `client-invite:${id}` }).catch((e) => this.hub.log.warn('client invitation mail failed', { mailer: this.hub.accounts.mailer.kind, err: e.message })));
    return { invite: { id, email, grants, expires_at: expires }, link, mailed };
  }
  inviteForStaff(member, id) { this.staff(member); const i = this.db.get('SELECT * FROM client_invites WHERE id = ? AND workspace_id = ?', id, member.org_id); if (!i) throw missing(); return i; }
  revokeInvite(member, id, { ip }) {
    return this.hub.txn(() => { this.inviteForStaff(member, id); this.db.run("UPDATE client_invites SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = 'withdrawn' WHERE id = ?", this.now(), id); this.audit('client.invite.revoke', { member, target: id, ip }); return { ok: true }; });
  }
  resend(member, id, { ip, req }) {
    const inv = this.inviteForStaff(member, id); if (!this.usable(inv)) throw invalid();
    if (!this.hub.accounts.liveUser(member.user_id)?.primary_email_verified_at) throw new HubError('EMAIL_UNVERIFIED', 'verify your email before inviting clients');
    this.quota(member.org_id, id); this.inviteLimits(member, ip);
    return this.hub.txn(() => { this.revokeInvite(member, id, { ip }); return this.issue(member, inv.email, this.grants(member.org_id, JSON.parse(inv.grants)), { ip, req }); });
  }
  preview(body, { ip }) {
    only(body, ['t']); limitOrThrow(this.hub, 'invite_preview_ip', ipKey(ip));
    if (!TOKEN_RE.test(body.t)) throw invalid();
    const inv = this.db.get('SELECT * FROM client_invites WHERE token_hash = ?', sha256hex(body.t)); if (!this.usable(inv)) throw invalid();
    return { workspace_name: mailName(this.workspace(inv.workspace_id).name), inviter_first_name: firstName(this.hub.member(inv.created_by).display_name), scopes: [...new Set(JSON.parse(inv.grants).flatMap((g) => g.scopes))], expires_at: inv.expires_at };
  }
  accept(ident, body, { ip }) {
    only(body, ['request_id', 't', 'invite_id']); limitOrThrow(this.hub, 'invite_accept_ip', ipKey(ip)); limitOrThrow(this.hub, 'invite_accept_user', ident.user.id);
    return this.hub.txn(() => {
      const user = this.hub.accounts.liveUser(ident.user.id);
      if (!user) throw new HubError('UNAUTHENTICATED', 'sign in again');
      const emails = this.hub.invites.verifiedEmails(user);
      let inv;
      if (TOKEN_RE.test(body.t)) inv = this.db.get('SELECT * FROM client_invites WHERE token_hash = ?', sha256hex(body.t));
      else if (typeof body.invite_id === 'string') inv = this.db.get('SELECT * FROM client_invites WHERE id = ?', body.invite_id);
      if (!inv) throw invalid();
      if (inv.accepted_at) {
        const guest = inv.accepted_by_user === ident.user.id && this.liveGuest(ident.user.id, inv.workspace_id);
        if (!guest) throw invalid(); return { workspace: this.publicWorkspace(this.workspace(inv.workspace_id)) };
      }
      if (!this.usable(inv)) throw invalid();
      if (!emails.includes(inv.email)) throw new HubError('WRONG_ACCOUNT', 'sign in with the invited address');
      const old = this.db.get('SELECT * FROM client_guests WHERE user_id = ? AND workspace_id = ?', ident.user.id, inv.workspace_id);
      if (old && !old.revoked_at) throw new HubError('CONFLICT', 'client access already exists');
      this.quota(inv.workspace_id, inv.id);
      const grants = this.grants(inv.workspace_id, JSON.parse(inv.grants)), id = old?.id ?? randomUUID();
      if (old) { this.db.run('UPDATE client_guests SET revoked_at = NULL, invited_by = ?, joined_at = ? WHERE id = ?', inv.created_by, this.now(), id); this.db.run('DELETE FROM client_grants WHERE guest_id = ?', id); }
      else this.db.insert('client_guests', { id, workspace_id: inv.workspace_id, user_id: ident.user.id, invited_by: inv.created_by, joined_at: this.now() });
      for (const grant of grants) this.db.insert('client_grants', { guest_id: id, project_id: grant.project_id, scopes: JSON.stringify(grant.scopes) });
      this.db.run('UPDATE client_invites SET accepted_at = ?, accepted_by_user = ?, guest_id = ? WHERE id = ?', this.now(), ident.user.id, id, inv.id);
      this.audit('client.invite.accept', { user: ident.user, workspace: inv.workspace_id, target: inv.id, ip });
      return { workspace: this.publicWorkspace(this.workspace(inv.workspace_id)) };
    });
  }
  liveGuest(userId, workspaceId) { return this.db.get('SELECT g.* FROM client_guests g JOIN users u ON u.id = g.user_id JOIN orgs o ON o.id = g.workspace_id WHERE g.user_id = ? AND g.workspace_id = ? AND g.revoked_at IS NULL AND u.deleted_at IS NULL AND o.deleted_at IS NULL', userId, workspaceId); }
  catalog(user) {
    if (!this.hub.accounts.liveUser(user.id)) return [];
    const staff = this.db.all('SELECT o.id, o.name, m.role FROM client_workspaces w JOIN orgs o ON o.id = w.org_id JOIN members m ON m.org_id = o.id WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL', user.id).map((w) => ({ ...w, mode: 'staff' }));
    const guests = this.db.all('SELECT o.id, o.name FROM client_guests g JOIN orgs o ON o.id = g.workspace_id WHERE g.user_id = ? AND g.revoked_at IS NULL AND o.deleted_at IS NULL', user.id).filter((w) => !staff.some((s) => s.id === w.id)).map((w) => ({ ...w, mode: 'client' }));
    return [...staff, ...guests].sort((a, b) => a.name.localeCompare(b.name));
  }
  projects(user, workspaceId) {
    if (!this.hub.accounts.liveUser(user.id)) throw missing();
    const w = this.workspace(workspaceId); if (!w) throw missing();
    const member = this.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', workspaceId, user.id);
    if (can(member, 'board.read')) return { workspace: this.publicWorkspace(w), projects: this.projectsForStaff(workspaceId).map(({ id, name }) => ({ id, name, scopes: CLIENT_SCOPES })) };
    const guest = this.liveGuest(user.id, workspaceId); if (!guest) throw missing();
    return { workspace: this.publicWorkspace(w), projects: this.db.all('SELECT p.id, p.name, g.scopes FROM client_projects p JOIN client_grants g ON g.project_id = p.id WHERE g.guest_id = ? ORDER BY p.name, p.id', guest.id).map((p) => ({ ...p, scopes: JSON.parse(p.scopes) })) };
  }
  project(user, projectId) {
    const p = this.db.get('SELECT * FROM client_projects WHERE id = ?', projectId); if (!p) throw missing();
    const allowed = this.projects(user, p.workspace_id).projects.find((x) => x.id === p.id && x.scopes.includes('status.read')); if (!allowed) throw missing();
    const items = this.db.all('SELECT id, title, summary, status, updated_at FROM client_items WHERE project_id = ? AND unpublished_at IS NULL ORDER BY published_at, id', p.id);
    const artifacts = this.hub.clientArtifacts?.decorate(user, items) ?? items;
    return { project: { id: p.id, name: p.name }, items: this.hub.clientFeedback?.decorate(user, artifacts) ?? artifacts };
  }
  setGuest(member, id, body, { ip }) {
    this.staff(member); only(body, ['request_id', 'grants']);
    const guest = this.db.get('SELECT * FROM client_guests WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL', id, member.org_id); if (!guest) throw missing();
    const grants = this.grants(member.org_id, body.grants);
    this.hub.txn(() => { this.db.run('DELETE FROM client_grants WHERE guest_id = ?', id); for (const g of grants) this.db.insert('client_grants', { guest_id: id, project_id: g.project_id, scopes: JSON.stringify(g.scopes) }); this.audit('client.guest.grants', { member, target: id, ip }); });
    return { ok: true };
  }
  revokeGuest(member, id, { ip }) {
    this.staff(member); const guest = this.db.get('SELECT * FROM client_guests WHERE id = ? AND workspace_id = ?', id, member.org_id); if (!guest) throw missing();
    return this.hub.txn(() => { this.db.run('UPDATE client_guests SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', this.now(), id); this.audit('client.guest.revoke', { member, target: id, ip }); return { ok: true }; });
  }
  addProject(member, boardId, body, { ip, cred = null }) {
    this.staff(member); only(body, ['request_id', 'name']);
    const board = this.hub.board(boardId); if (!board || board.org_id !== member.org_id) throw missing();
    const name = teamName(body.name ?? board.name);
    return this.hub.withBoard(boardId, () => this.hub.txn(() => {
      this.staff(member, 'invite.create', cred); if (this.hub.board(boardId).archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
      const old = this.db.get('SELECT id, name FROM client_projects WHERE board_id = ?', boardId); if (old) return { project: old };
      const id = randomUUID(); this.db.insert('client_projects', { id, board_id: boardId, workspace_id: member.org_id, name, created_at: this.now() });
      this.audit('client.project.create', { member, target: id, ip }); return { project: { id, name } };
    }));
  }
  publish(member, boardId, body, { ip, cred = null }) {
    this.staff(member, 'team.settings'); only(body, ['request_id', 'card_id', 'title', 'summary', 'status']);
    const p = this.db.get('SELECT * FROM client_projects WHERE board_id = ? AND workspace_id = ?', boardId, member.org_id); if (!p) throw missing();
    const card = this.hub.card(body.card_id); if (!card || card.board_id !== boardId) throw missing();
    const title = text(body.title, 200, true), summary = text(body.summary, 2000), status = body.status;
    if (!['todo', 'in_progress', 'review', 'done'].includes(status)) throw new HubError('VALIDATION', 'invalid client status');
    return this.hub.withBoard(boardId, () => this.hub.txn(() => {
      this.staff(member, 'team.settings', cred); if (this.hub.board(boardId).archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
      const old = this.db.get('SELECT * FROM client_items WHERE card_id = ?', card.id); const id = old?.id ?? randomUUID(), at = this.now();
      if (old) this.db.run('UPDATE client_items SET title = ?, summary = ?, status = ?, updated_at = ?, unpublished_at = NULL, published_by = ? WHERE id = ?', title, summary, status, at, member.id, id);
      else this.db.insert('client_items', { id, project_id: p.id, card_id: card.id, title, summary, status, published_by: member.id, published_at: at, updated_at: at });
      this.hub.clientFeedback?.recordUpdate({ id, title, summary, status });
      this.audit('client.item.publish', { member, target: id, ip });
      return { item: { id, title, summary, status, updated_at: at } };
    }));
  }
  unpublish(member, id, { ip, cred = null }) {
    this.staff(member, 'team.settings'); const row = this.db.get('SELECT i.*, p.board_id FROM client_items i JOIN client_projects p ON p.id = i.project_id WHERE i.id = ? AND p.workspace_id = ?', id, member.org_id); if (!row) throw missing();
    return this.hub.withBoard(row.board_id, () => this.hub.txn(() => { this.staff(member, 'team.settings', cred); if (this.hub.board(row.board_id).archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' }); this.db.run('UPDATE client_items SET unpublished_at = ? WHERE id = ?', this.now(), id); this.audit('client.item.unpublish', { member, target: id, ip }); return { ok: true }; }));
  }
  deleteUser(userId, emails, at) {
    this.db.run('UPDATE client_guests SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', at, userId);
    const clauses = ['accepted_by_user = ?'], args = [userId];
    if (emails.length) { clauses.push(`email IN (${emails.map(() => '?').join(',')})`); args.push(...emails); }
    this.db.run(`UPDATE client_invites SET email = 'deleted:' || id, revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'account_deleted') WHERE ${clauses.join(' OR ')}`, at, ...args);
  }
  deleteTeam(id, at) { this.db.run('UPDATE client_guests SET revoked_at = COALESCE(revoked_at, ?) WHERE workspace_id = ?', at, id); this.db.run("UPDATE client_invites SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, 'team_deleted') WHERE workspace_id = ?", at, id); }
  export(user) {
    const workspaces = this.catalog(user);
    return {
      workspaces, pending_invites: this.pendingFor(user),
      access: this.db.all('SELECT id, workspace_id, joined_at, revoked_at FROM client_guests WHERE user_id = ? ORDER BY joined_at', user.id).map((g) => ({ ...g, grants: this.grantsFor(g.id) })),
      projects: workspaces.flatMap((w) => this.projects(user, w.id).projects.map((p) => this.project(user, p.id))),
    };
  }
}
