// Dedicated client feedback intake; never guest member or dispatch authority.
import { randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { can } from '../permissions.js';
import { insertCardRecord } from '../card-record.js';
import { limitOrThrow } from '../ratelimit.js';
import { clientOnly as only, clientText as text, clientMissing as missing } from './clients.js';
import { requireCredentialOwner } from './credential-owner.js';

const paused = () => new HubError('CONFLICT', 'your team has paused feedback intake; contact them to resume it', { reason: 'CLIENT_INTAKE_PAUSED' });
export class ClientFeedback {
  constructor(hub) { this.hub = hub; this.db = hub.db; this.clients = hub.clients; }
  project(boardId) { const p = this.db.get('SELECT * FROM client_projects WHERE board_id = ?', boardId); if (!p || !this.clients.workspace(p.workspace_id)) throw missing(); return p; }
  staff(member, boardId, cred, admin = false) {
    requireCredentialOwner(this.hub, cred, member?.user_id); const p = this.project(boardId), live = this.hub.activeMember(member?.id);
    if (!live || live.user_id !== member.user_id || !this.hub.accounts.liveUser(live.user_id) || live.org_id !== p.workspace_id || member.org_id !== p.workspace_id) throw missing();
    if (!can(live, admin ? 'team.settings' : 'board.read')) throw new HubError('FORBIDDEN', 'client workspace admin required'); return p;
  }
  active(p) {
    const row = this.db.get('SELECT * FROM client_feedback_intake WHERE project_id = ?', p.id);
    const delegate = row && this.hub.activeMember(row.delegate_member_id);
    return { row, delegate, active: !!row?.enabled && !!delegate && delegate.org_id === p.workspace_id && can(delegate, 'card.write') && !!this.hub.accounts.liveUser(delegate.user_id) && !!this.clients.workspace(p.workspace_id) && !this.hub.board(p.board_id)?.archived_at };
  }
  config(member, boardId, cred = null) {
    const p = this.staff(member, boardId, cred), { row, delegate, active } = this.active(p);
    return { intake: { enabled: !!row?.enabled, active, delegate: row ? { member_id: row.delegate_member_id, name: this.hub.memberName(row.delegate_member_id), writable: !!delegate && can(delegate, 'card.write') } : null } };
  }
  configure(member, boardId, body, { ip, cred = null }) {
    this.staff(member, boardId, cred, true); only(body, ['enabled']);
    if (typeof body.enabled !== 'boolean') throw new HubError('VALIDATION', 'choose whether to enable client feedback');
    return this.hub.withBoard(boardId, () => this.hub.txn(() => {
      const p = this.staff(member, boardId, cred, true); if (this.hub.board(boardId).archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
      // Enabling always opts in the actual configuring admin. No caller can
      // grant another member this acting authority without their consent.
      const old = this.db.get('SELECT * FROM client_feedback_intake WHERE project_id = ?', p.id), delegate = body.enabled || !old ? member.id : old.delegate_member_id;
      this.db.run('INSERT INTO client_feedback_intake (project_id, enabled, delegate_member_id, configured_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, delegate_member_id = excluded.delegate_member_id, configured_at = excluded.configured_at', p.id, body.enabled, delegate, this.hub.iso());
      this.clients.audit('client.feedback.intake', { member, target: p.id, ip }); return this.config(member, boardId, cred);
    }));
  }
  access(user, id, cred = null) { return this.hub.clientArtifacts.access(user, id, 'feedback.create', cred); }
  guest(user, item) {
    const g = this.clients.liveGuest(user.id, item.workspace_id);
    if (!g || !this.clients.grantsFor(g.id).some((p) => p.project_id === item.project_id && p.scopes.includes('feedback.create'))) throw missing(); return g;
  }
  isStaff(user, item) { return can(this.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', item.workspace_id, user.id), 'board.read'); }
  history(id) { return this.db.all('SELECT id, title, summary, status, created_at FROM client_delivery_updates WHERE item_id = ? ORDER BY rowid DESC LIMIT 50', id).reverse(); }
  recordUpdate(item) {
    const latest = this.db.get('SELECT title, summary, status FROM client_delivery_updates WHERE item_id = ? ORDER BY rowid DESC LIMIT 1', item.id);
    if (latest && latest.title === item.title && latest.summary === item.summary && latest.status === item.status) return;
    this.db.insert('client_delivery_updates', { id: randomUUID(), item_id: item.id, title: item.title, summary: item.summary, status: item.status, created_at: this.hub.iso() });
    this.db.run('DELETE FROM client_delivery_updates WHERE item_id = ? AND id NOT IN (SELECT id FROM client_delivery_updates WHERE item_id = ? ORDER BY rowid DESC LIMIT 50)', item.id, item.id);
  }
  projection(row, staff, item) {
    const author = this.db.get('SELECT display_name FROM users WHERE id = (SELECT user_id FROM client_guests WHERE id = ?)', row.guest_id)?.display_name ?? 'Deleted user';
    const shared = this.db.get('SELECT id, title, summary, status, updated_at FROM client_items WHERE card_id = ? AND project_id = ? AND unpublished_at IS NULL', row.card_id, item.project_id);
    return { id: row.id, item_id: row.item_id, message: row.message, created_at: row.created_at, source_name: author, intake: { kind: 'staff_authorized', ...(staff ? { member_id: row.delegate_member_id, name: this.hub.memberName(row.delegate_member_id) } : {}) }, ...(shared ? { update: { ...shared, history: this.history(shared.id) } } : {}), ...(staff ? { guest_id: row.guest_id, task: { card_id: row.card_id, board_id: item.board_id, workspace_id: item.workspace_id, key: this.hub.card(row.card_id).key } } : {}) };
  }
  list(user, id, cred = null) {
    const item = this.access(user, id, cred), staff = this.isStaff(user, item), guest = staff ? null : this.guest(user, item);
    const rows = this.db.all(`SELECT * FROM client_feedback WHERE item_id = ? ${staff ? '' : 'AND guest_id = ?'} ORDER BY created_at, rowid`, ...[id, ...(staff ? [] : [guest.id])]);
    return { feedback: rows.map((r) => this.projection(r, staff, item)), feedback_available: !staff && this.active(this.project(item.board_id)).active };
  }
  decorate(user, items) {
    return items.map((i) => { let feedback = {}; try { feedback = this.list(user, i.id); } catch (e) { if (e.code !== 'NOT_FOUND') throw e; } return { ...i, history: this.history(i.id), ...feedback }; });
  }
  create(user, id, body, { ip, cred = null }) {
    const initial = this.access(user, id, cred); this.guest(user, initial); only(body, ['request_id', 'message']);
    const key = text(body.request_id, 100, true), message = text(body.message, 4000, true);
    return this.hub.withBoard(initial.board_id, () => this.hub.txn(() => {
      const item = this.access(user, id, cred), guest = this.guest(user, item), p = this.project(item.board_id), intake = this.active(p);
      if (!intake.active) throw paused();
      const prior = this.db.get('SELECT * FROM client_feedback WHERE guest_id = ? AND request_id = ?', guest.id, key);
      if (prior) { if (prior.item_id !== id || prior.message !== message) throw new HubError('CONFLICT', 'request id already belongs to another feedback message'); return { feedback: this.projection(prior, false, item) }; }
      const quota = Math.max(1, Math.min(1000, Number.isSafeInteger(this.hub.config.clientFeedbackLimit) ? this.hub.config.clientFeedbackLimit : 1000));
      if (this.db.get('SELECT COUNT(*) n FROM client_feedback f JOIN client_items i ON i.id = f.item_id WHERE i.project_id = ?', p.id).n >= quota) throw new HubError('QUOTA_EXCEEDED', 'client feedback limit reached; contact your team', { resource: 'client_feedback', limit: quota });
      limitOrThrow(this.hub, 'client_feedback_guest', guest.id);
      const row = { id: randomUUID(), item_id: id, guest_id: guest.id, delegate_member_id: intake.delegate.id, card_id: randomUUID(), request_id: key, message, created_at: this.hub.iso() };
      const card = insertCardRecord(this.hub, item.board_id, intake.delegate.id, { title: 'Client feedback', body: `Client feedback for ${item.title}\n\n${message}`, acceptance: null, repo_id: null, base_ref: null, budget_cents: null, cover: null, labels: '[]' }, { id: row.card_id, now: row.created_at });
      this.db.insert('client_feedback', row);
      const provenance = { client_feedback_id: row.id, client_guest_id: guest.id, client_user_id: user.id, intake_delegate_member_id: intake.delegate.id, source_item_id: item.id };
      this.hub.journal({ board_id: item.board_id, card_id: card.id, actor_kind: 'system', kind: 'card.create', payload: { ...provenance, key: card.key, title: card.title, body_hmac: this.hub.refHash(card.body), repo_id: null, base_ref: null, labels: '[]', budget_cents: null, column_name: 'todo', cover: null, assignees: [] } });
      this.hub.feed(card.id, 'created', provenance);
      this.clients.audit('client.feedback.receive', { user, workspace: item.workspace_id, target: row.id, ip });
      this.hub.later(() => this.hub.broadcastCard(card.id)); return { feedback: this.projection(row, false, item) };
    }));
  }
  cardProvenance(id) {
    const row = this.db.get('SELECT * FROM client_feedback WHERE card_id = ?', id); if (!row) return null;
    const author = this.db.get('SELECT display_name FROM users WHERE id = (SELECT user_id FROM client_guests WHERE id = ?)', row.guest_id)?.display_name ?? 'Deleted user';
    return { id: row.id, source_name: author, intake_name: this.hub.memberName(row.delegate_member_id), source_item_id: row.item_id };
  }
}
