// Durable exact-text decisions inside existing interact shares. A grant
// authorizes one explicit new-turn send; it never expands a watch share or
// removes the direct rights already granted by a broad interact share.
import { createHash } from 'node:crypto';
import { HubError } from './db.js';
import { limitOrThrow } from './ratelimit.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const validText = (v, max) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const invalid = () => new HubError('VALIDATION', 'Review the exact proposal and decision version.');
const missing = () => new HubError('NOT_FOUND', 'That proposal is no longer available.');
const stale = () => new HubError('CONFLICT', 'The decision, grant or session changed. Review a fresh proposal; never retry an uncertain send.');
export class InteractionProposals {
  constructor(shares) { this.shares = shares; this.hub = shares.hub; }
  get db() { return this.hub.db; }
  now() { return this.hub.iso(); }
  prune() {
    this.db.run(`DELETE FROM interaction_proposals WHERE retain_until <= ?
      OR requester_user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)
      OR share_id IN (SELECT id FROM interaction_shares WHERE revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)
        OR owner_user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL))`, this.now(), this.now());
  }
  row(id) { return typeof id === 'string' && UUID.test(id) ? this.db.get('SELECT * FROM interaction_proposals WHERE id = ?', id) : null; }
  view(p) {
    return { id: p.id, share: p.share_id, requester: { id: p.requester_user_id, name: this.db.get('SELECT display_name AS name FROM users WHERE id = ?', p.requester_user_id)?.name ?? 'Teammate' },
      decision: p.decision_id, version: p.decision_version, generation: p.generation, title: p.title, text: p.message, digest: p.digest, action: p.action, budget: p.action_budget,
      status: p.status === 'approved' && p.grant_expires_at <= this.now() ? 'expired' : p.status, createdAt: p.created_at, retainUntil: p.retain_until,
      acknowledgedAt: p.acknowledged_at, expiresAt: p.grant_expires_at, receipt: p.receipt_id ? { id: p.receipt_id, state: p.receipt_state } : null };
  }
  owner(ident, shareId) {
    this.shares.asHost(ident);
    const s = this.db.get('SELECT * FROM interaction_shares WHERE id = ?', shareId);
    if (!this.shares.live(s) || s.owner_user_id !== ident.user.id || s.host_device_id !== ident.cred.id || !this.shares.member(s.org_id, ident.user.id)) throw missing();
    return s;
  }
  requester(ident, p) {
    if (!p || p.requester_user_id !== ident.user.id) throw missing();
    const auth = this.shares.authorize(ident, p.share_id, 'send');
    return auth;
  }
  activeVersion(p) {
    return this.db.get('SELECT MAX(decision_version) AS v FROM interaction_proposals WHERE share_id = ? AND requester_user_id = ? AND decision_id = ?', p.share_id, p.requester_user_id, p.decision_id)?.v === p.decision_version;
  }
  create(ident, shareId, body) {
    this.prune();
    if (!closed(body, ['id', 'decision', 'version', 'generation', 'title', 'text']) || !UUID.test(body.id) || !UUID.test(body.decision) || !Number.isSafeInteger(body.version) || body.version < 1
      || !Number.isSafeInteger(body.generation) || body.generation < 1 || !validText(body.title, 120) || !validText(body.text, 4000) || Buffer.byteLength(body.text) > 8192) throw invalid();
    const { row: share } = this.shares.authorize(ident, shareId, 'send');
    limitOrThrow(this.hub, 'share_write_user', ident.user.id);
    const digest = createHash('sha256').update(JSON.stringify([shareId, ident.user.id, body.decision, body.version, body.generation, body.title, body.text, 'send', 1])).digest('hex');
    const old = this.row(body.id);
    if (old) { if (old.digest !== digest) throw stale(); return { ok: true, proposal: this.view(old) }; }
    this.hub.txn(() => {
      const previous = this.db.get('SELECT MAX(decision_version) AS v FROM interaction_proposals WHERE share_id = ? AND requester_user_id = ? AND decision_id = ?', shareId, ident.user.id, body.decision)?.v ?? 0;
      if (body.version !== previous + 1 || this.db.get("SELECT id FROM interaction_proposals WHERE share_id = ? AND requester_user_id = ? AND decision_id = ? AND status = 'dispatching'", shareId, ident.user.id, body.decision)) throw stale();
      if (this.db.get('SELECT COUNT(*) AS n FROM interaction_proposals WHERE share_id = ?', shareId).n >= 64) throw new HubError('QUOTA_EXCEEDED', 'This session already has 64 retained proposals.');
      this.db.run("UPDATE interaction_proposals SET status = 'superseded' WHERE share_id = ? AND requester_user_id = ? AND decision_id = ? AND status IN ('pending','approved')", shareId, ident.user.id, body.decision);
      this.db.insert('interaction_proposals', { id: body.id, share_id: share.id, requester_user_id: ident.user.id, decision_id: body.decision, decision_version: body.version, generation: body.generation,
        title: body.title, message: body.text, digest, action: 'send', action_budget: 1, status: 'pending', created_at: this.now(), retain_until: new Date(this.hub.wallMs() + 7 * 86400000).toISOString() });
    });
    return { ok: true, proposal: this.view(this.row(body.id)) };
  }
  list(ident, shareId, owner = false) {
    this.prune();
    if (owner) this.owner(ident, shareId); else this.shares.authorize(ident, shareId, 'state');
    const rows = this.db.all('SELECT * FROM interaction_proposals WHERE share_id = ? ORDER BY created_at DESC, id', shareId);
    return { ok: true, proposals: rows.filter(p => owner ? ['owner','admin','member'].includes(this.shares.member(this.db.get('SELECT org_id FROM interaction_shares WHERE id = ?', shareId).org_id, p.requester_user_id)?.role) : p.requester_user_id === ident.user.id).map(p => this.view(p)) };
  }
  approve(ident, shareId, id, body) {
    this.prune(); const s = this.owner(ident, shareId), p = this.row(id);
    if (!p || p.share_id !== shareId) throw missing();
    if (!closed(body, ['version', 'digest', 'generation', 'expires_in_s']) || body.version !== p.decision_version || body.digest !== p.digest || body.generation !== p.generation
      || !Number.isSafeInteger(body.expires_in_s) || body.expires_in_s < 60 || body.expires_in_s > 3600) throw invalid();
    const member = this.shares.member(s.org_id, p.requester_user_id);
    if (s.scope !== 'interact' || !member || !['owner','admin','member'].includes(member.role)) throw missing();
    if (p.status !== 'pending' || !this.activeVersion(p)) throw stale();
    const expiry = new Date(Math.min(this.hub.wallMs() + body.expires_in_s * 1000, Date.parse(p.retain_until), s.expires_at ? Date.parse(s.expires_at) : Infinity)).toISOString();
    this.db.run("UPDATE interaction_proposals SET status = 'approved', acknowledged_at = ?, grant_expires_at = ? WHERE id = ? AND status = 'pending'", this.now(), expiry, p.id);
    return { ok: true, proposal: this.view(this.row(p.id)) };
  }
  revoke(ident, shareId, id, owner = false) {
    this.prune(); const p = this.row(id);
    if (!p || p.share_id !== shareId) throw missing();
    if (owner) this.owner(ident, shareId); else this.requester(ident, p);
    // Revocation cannot undo a send already admitted; keep its receipt/uncertainty.
    if (['pending','approved'].includes(p.status)) this.db.run("UPDATE interaction_proposals SET status = 'revoked' WHERE id = ?", p.id);
    return { ok: true, proposal: this.view(this.row(p.id)) };
  }
  async dispatch(ident, shareId, id, body) {
    this.prune(); const p = this.row(id);
    if (!p || p.share_id !== shareId) throw missing();
    const auth = this.requester(ident, p);
    if (!closed(body, ['version', 'digest', 'request_id']) || body.version !== p.decision_version || body.digest !== p.digest || !UUID.test(body.request_id)) throw invalid();
    if (p.status !== 'approved' || p.grant_expires_at <= this.now() || !this.activeVersion(p)) throw stale();
    // Durable action budget consumed before the first await. A crash/timeout
    // leaves dispatching and is never automatically retried, even after restart.
    this.db.run("UPDATE interaction_proposals SET status = 'dispatching', used_at = ? WHERE id = ? AND status = 'approved'", this.now(), p.id);
    let result;
    try { result = await this.shares.call(ident, shareId, { request_id: body.request_id, op: 'send', args: { session: auth.row.session_id, generation: p.generation, text: p.message } }, { id: p.id, digest: p.digest, version: p.decision_version }); }
    catch (e) { this.db.run("UPDATE interaction_proposals SET status = 'unconfirmed' WHERE id = ?", p.id); throw e; }
    const receipt = result?.result?.delivery, confirmed = result?.result?.ok === true && typeof receipt?.id === 'string';
    const state = confirmed ? 'sent' : ['stale','forbidden','busy','invalid','unavailable'].includes(result?.result?.status) ? 'refused' : 'unconfirmed';
    this.db.run('UPDATE interaction_proposals SET status = ?, receipt_id = ?, receipt_state = ? WHERE id = ?', state, confirmed ? receipt.id.slice(0, 100) : null, confirmed ? String(receipt.state || 'unknown').slice(0, 80) : null, p.id);
    this.requester(ident, p);
    return { ok: true, proposal: this.view(this.row(p.id)), result: result.result };
  }
  routes(route) {
    const settings = { auth: 'user', replay: false, strictBody: true, maxBody: 10000 };
    const shared = '/api/interaction/v1/shared/:share_id/proposals', owned = '/api/interaction/v1/shares/:share_id/proposals';
    route('GET', shared, ({ ident, params }) => this.list(ident, params.share_id), settings);
    route('POST', shared, ({ ident, params, body }) => this.create(ident, params.share_id, body), settings);
    route('DELETE', `${shared}/:proposal_id`, ({ ident, params }) => this.revoke(ident, params.share_id, params.proposal_id), settings);
    route('POST', `${shared}/:proposal_id/send`, ({ ident, params, body }) => this.dispatch(ident, params.share_id, params.proposal_id, body), settings);
    route('GET', owned, ({ ident, params }) => this.list(ident, params.share_id, true), settings);
    route('POST', `${owned}/:proposal_id/approve`, ({ ident, params, body }) => this.approve(ident, params.share_id, params.proposal_id, body), settings);
    route('DELETE', `${owned}/:proposal_id`, ({ ident, params }) => this.revoke(ident, params.share_id, params.proposal_id, true), settings);
  }
}
