import { createHash, randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { can } from './permissions.js';
import { insertCardRecord } from './card-record.js';
import { PLAN_APPROVAL_LABEL } from '../shared/states.js';
import { limitOrThrow } from './ratelimit.js';

const missing = () => new HubError('NOT_FOUND', 'workflow not found');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function only(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw new HubError('VALIDATION', 'unknown workflow fields');
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) throw new HubError('VALIDATION', `workflow text must be ${required ? '1–' : 'at most '}${max} characters`);
  return value.trim();
}
function definition(value) {
  only(value, ['name', 'description', 'steps']);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) throw new HubError('VALIDATION', 'choose 1–8 workflow steps');
  const out = { name: text(value.name, 80, true), description: text(value.description ?? '', 1000), steps: value.steps.map((s) => {
    only(s, ['title', 'body', 'acceptance', 'plan_approval']);
    if (typeof s.plan_approval !== 'boolean') throw new HubError('VALIDATION', 'choose the plan review policy for each step');
    return { title: text(s.title, 140, true), body: text(s.body ?? '', 4000), acceptance: text(s.acceptance ?? '', 2000), plan_approval: s.plan_approval };
  }) };
  if (Buffer.byteLength(JSON.stringify(out)) > 32 * 1024) throw new HubError('VALIDATION', 'workflow definition is too large');
  return out;
}
const requestId = (value) => text(value, 100, true);

export class Workflows {
  constructor(hub) { this.hub = hub; this.db = hub.db; }
  staff(member, cred, write = false) {
    if (cred && !this.hub.accounts?.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
    const m = this.hub.activeMember(member?.id);
    if (!m || m.org_id !== member.org_id || !this.db.get('SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL', m.org_id)
      || (m.user_id && !this.db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', m.user_id))) throw missing();
    if (!can(m, write ? 'card.write' : 'board.read')) throw new HubError('FORBIDDEN', 'workflow is read only');
    return m;
  }
  recipe(member, id, cred, write = false) {
    const m = this.staff(member, cred, write), r = this.db.get('SELECT * FROM workflow_recipes WHERE id = ? AND org_id = ?', id, m.org_id);
    if (!r) throw missing(); return r;
  }
  version(id, version) {
    const row = this.db.get('SELECT * FROM workflow_versions WHERE recipe_id = ? AND version = ?', id, version);
    if (!row) throw missing();
    const def = JSON.parse(row.definition);
    if (hash(def) !== row.content_hash) throw new HubError('CONFLICT', 'workflow version cannot be verified');
    return { version: row.version, content_hash: row.content_hash, definition: def, created_at: row.created_at, author_name: this.hub.memberName(row.created_by) };
  }
  list(member, cred = null, { includeArchived = false } = {}) {
    const m = this.staff(member, cred);
    return { workflows: this.db.all(`SELECT * FROM workflow_recipes WHERE org_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY created_at DESC, id`, m.org_id).map((r) => ({ id: r.id, archived_at: r.archived_at, ...this.version(r.id, r.latest_version) })) };
  }
  instance(row) {
    return { id: row.id, recipe_id: row.recipe_id, version: row.recipe_version, board_id: row.board_id, created_at: row.created_at,
      steps: this.db.all('SELECT s.position, c.id, c.key, c.title, c.column_name AS column, c.run_state, c.archived_at FROM workflow_step_cards s JOIN cards c ON c.id = s.card_id WHERE s.instance_id = ? ORDER BY s.position', row.id) };
  }
  detail(member, id, cred = null) {
    const r = this.recipe(member, id, cred);
    return { workflow: { id: r.id, archived_at: r.archived_at, ...this.version(id, r.latest_version) },
      versions: this.db.all('SELECT version FROM workflow_versions WHERE recipe_id = ? ORDER BY version DESC', id).map((v) => this.version(id, v.version)),
      instances: this.db.all('SELECT * FROM workflow_instances WHERE recipe_id = ? ORDER BY created_at DESC, id LIMIT 50', id).map((row) => this.instance(row)) };
  }
  publish(member, id, body, cred = null) {
    this.staff(member, cred, true); only(body, ['request_id', 'expected_version', 'definition']);
    const request = requestId(body.request_id), def = definition(body.definition);
    if (id ? !Number.isSafeInteger(body.expected_version) || body.expected_version < 1 : body.expected_version != null) throw new HubError('VALIDATION', 'choose the current workflow version');
    const fingerprint = hash({ id, expected_version: body.expected_version ?? null, definition: def });
    return this.hub.withBoard(`workflows:${member.org_id}`, () => this.hub.txn(() => {
      const m = this.staff(member, cred, true);
      const prior = this.db.get('SELECT * FROM workflow_versions WHERE created_by = ? AND request_id = ?', m.id, request);
      if (prior) {
        if (prior.request_hash !== fingerprint) throw new HubError('CONFLICT', 'request id belongs to another workflow change');
        const r = this.recipe(m, prior.recipe_id, cred, true);
        if (r.archived_at) throw new HubError('CONFLICT', 'workflow is archived');
        return { workflow: { id: r.id, ...this.version(r.id, prior.version) } };
      }
      const r = id ? this.recipe(m, id, cred, true) : null;
      if (r?.archived_at) throw new HubError('CONFLICT', 'workflow is archived');
      if (r && r.latest_version !== body.expected_version) throw new HubError('CONFLICT', 'workflow changed; reload before publishing');
      if (r?.latest_version >= 50 || (!r && this.db.get('SELECT COUNT(*) n FROM workflow_recipes WHERE org_id = ?', m.org_id).n >= 100)) throw new HubError('QUOTA_EXCEEDED', 'workflow library limit reached');
      limitOrThrow(this.hub, 'workflow_member', m.id);
      const recipeId = r?.id ?? randomUUID(), version = r ? r.latest_version + 1 : 1, now = this.hub.iso();
      if (!r) this.db.insert('workflow_recipes', { id: recipeId, org_id: m.org_id, created_by: m.id, created_at: now });
      this.db.insert('workflow_versions', { recipe_id: recipeId, version, definition: JSON.stringify(def), content_hash: hash(def), created_by: m.id, request_id: request, request_hash: fingerprint, created_at: now });
      if (r) this.db.run('UPDATE workflow_recipes SET latest_version = ? WHERE id = ?', version, recipeId);
      this.hub.journal({ board_id: null, actor_kind: 'member', actor_id: m.id, kind: 'workflow.publish', payload: { recipe_id: recipeId, version, content_hmac: this.hub.refHash(JSON.stringify(def)) } });
      return { workflow: { id: recipeId, ...this.version(recipeId, version) } };
    }));
  }
  archive(member, id, body, cred = null) {
    const initial = this.recipe(member, id, cred, true); only(body, ['request_id', 'archived']);
    if (typeof body.archived !== 'boolean') throw new HubError('VALIDATION', 'choose workflow archive state');
    return this.hub.withBoard(`workflows:${initial.org_id}`, () => this.hub.txn(() => {
      const r = this.recipe(member, id, cred, true);
      if (!!r.archived_at !== body.archived) {
        this.db.run('UPDATE workflow_recipes SET archived_at = ? WHERE id = ?', body.archived ? this.hub.iso() : null, id);
        this.hub.journal({ board_id: null, actor_kind: 'member', actor_id: member.id, kind: 'workflow.archive', payload: { recipe_id: id, archived: body.archived } });
      }
      return this.detail(member, id, cred);
    }));
  }
  apply(member, id, boardId, body, cred = null) {
    this.recipe(member, id, cred, true); only(body, ['request_id', 'version', 'content_hash', 'context', 'title_prefix']);
    const request = requestId(body.request_id), context = text(body.context ?? '', 2000), prefix = text(body.title_prefix ?? '', 50);
    if (!Number.isSafeInteger(body.version) || body.version < 1 || !/^[0-9a-f]{64}$/.test(body.content_hash ?? '')) throw new HubError('VALIDATION', 'choose an exact workflow version');
    const fingerprint = hash({ id, boardId, version: body.version, content_hash: body.content_hash, context, prefix });
    return this.hub.withBoard(boardId, () => this.hub.txn(() => {
      const m = this.staff(member, cred, true), r = this.recipe(m, id, cred, true), b = this.hub.board(boardId);
      if (!b || b.org_id !== m.org_id) throw new HubError('NOT_FOUND', 'board not found');
      if (b.archived_at || r.archived_at) throw new HubError('CONFLICT', 'workflow or board is archived');
      const v = this.version(id, body.version);
      if (v.content_hash !== body.content_hash) throw new HubError('CONFLICT', 'workflow preview does not match this version');
      const prior = this.db.get('SELECT * FROM workflow_instances WHERE created_by = ? AND request_id = ?', m.id, request);
      if (prior) { if (prior.request_hash !== fingerprint) throw new HubError('CONFLICT', 'request id belongs to another workflow'); return { instance: this.instance(prior) }; }
      if (this.db.get('SELECT COUNT(*) n FROM workflow_instances i JOIN workflow_recipes r ON r.id = i.recipe_id WHERE r.org_id = ?', m.org_id).n >= 1000) throw new HubError('QUOTA_EXCEEDED', 'workflow use limit reached');
      limitOrThrow(this.hub, 'workflow_member', m.id);
      const row = { id: randomUUID(), recipe_id: id, recipe_version: body.version, board_id: boardId, created_by: m.id, request_id: request, request_hash: fingerprint, created_at: this.hub.iso() };
      this.db.insert('workflow_instances', row);
      for (const [position, s] of v.definition.steps.entries()) {
        const card = insertCardRecord(this.hub, boardId, m.id, { title: prefix ? `${prefix}: ${s.title}` : s.title,
          body: `${s.body}${context ? `${s.body ? '\n\n' : ''}Project context:\n${context}` : ''}`, acceptance: s.acceptance,
          labels: JSON.stringify(s.plan_approval ? [PLAN_APPROVAL_LABEL] : []), repo_id: null, base_ref: null, budget_cents: null, cover: null }, { id: randomUUID(), now: row.created_at });
        this.db.insert('workflow_step_cards', { instance_id: row.id, position, card_id: card.id });
        this.hub.journal({ board_id: boardId, card_id: card.id, actor_kind: 'member', actor_id: m.id, kind: 'card.create', payload: {
          workflow_instance_id: row.id, workflow_recipe_id: id, workflow_version: body.version, workflow_position: position, key: card.key,
          title: card.title, body_hmac: this.hub.refHash(card.body), acceptance_hmac: this.hub.refHash(card.acceptance), repo_id: null, base_ref: null,
          labels: card.labels, budget_cents: null, column_name: 'todo', cover: null, assignees: [] } });
        this.hub.feed(card.id, 'created', { workflow_instance_id: row.id }, { actor: m.id });
        this.hub.later(() => this.hub.broadcastCard(card.id));
      }
      this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: m.id, kind: 'workflow.apply', payload: { instance_id: row.id, recipe_id: id, version: body.version, content_hmac: this.hub.refHash(v.content_hash), context_hmac: this.hub.refHash(context) } });
      return { instance: this.instance(row) };
    }));
  }
}
