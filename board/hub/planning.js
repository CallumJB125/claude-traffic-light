import { createHash } from 'node:crypto';
import { HubError } from './db.js';
import { cardView } from './views.js';
import { validRange, MAX_PREDECESSORS, MAX_GRAPH_CARDS, MAX_GRAPH_EDGES, orderGraph } from '../shared/planning.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class Planning {
  constructor(api) { this.api = api; this.hub = api.hub; this.db = api.db; }
  scope(member, cardId, dependencies, cred) {
    const current = this.api.currentWriter(member, cred), row = this.api.cardFor(current, cardId);
    this.api.writableBoard(row.board_id);
    const repoOk = card => card.repo_id == null || !!this.db.get('SELECT 1 x FROM board_repos br JOIN repos r ON r.id = br.repo_id WHERE br.board_id = ? AND br.repo_id = ? AND r.org_id = ?', card.board_id, card.repo_id, current.org_id);
    if (row.archived_at || !repoOk(row)) throw new HubError('CONFLICT', 'card is archived or its repository is no longer linked');
    const existing = this.db.all('SELECT depends_on_card_id FROM card_dependencies WHERE card_id = ?', cardId).map(r => r.depends_on_card_id);
    // Unlinking or archiving an old dependency must not prevent its removal.
    for (const id of dependencies ?? existing) {
      const dependency = this.api.cardFor(current, id);
      if (dependency.board_id !== row.board_id || dependency.archived_at || !repoOk(dependency)) throw new HubError('NOT_FOUND', 'dependency is not an active card on this board');
    }
    return { member: current, row };
  }
  async patch(member, cardId, body, cred = null) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['request_id', 'version', 'start_date', 'due_date', 'depends_on'].includes(k))) throw new HubError('VALIDATION', 'unknown planning field');
    if (!UUID.test(body.request_id) || !Number.isSafeInteger(body.version) || body.version < 0) throw new HubError('VALIDATION', 'request_id and version required');
    if (!['start_date', 'due_date', 'depends_on'].some(k => k in body)) throw new HubError('VALIDATION', 'choose planning fields to change');
    let dependencies;
    if ('depends_on' in body) {
      if (!Array.isArray(body.depends_on) || body.depends_on.length > MAX_PREDECESSORS || body.depends_on.some(id => typeof id !== 'string' || id.length < 1 || id.length > 100)) throw new HubError('VALIDATION', `choose at most ${MAX_PREDECESSORS} predecessors`);
      dependencies = [...new Set(body.depends_on)].sort();
    }
    const normalized = { card_id: cardId, version: body.version, ...('start_date' in body ? { start_date: body.start_date } : {}), ...('due_date' in body ? { due_date: body.due_date } : {}), ...(dependencies ? { depends_on: dependencies } : {}) };
    const binding = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const first = this.scope(member, cardId, dependencies, cred);
    return this.api.withWritableBoard(first.row.board_id, () => {
      const { member: current, row } = this.scope(member, cardId, dependencies, cred);
      if (row.board_id !== first.row.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      const prior = this.db.get('SELECT * FROM planning_requests WHERE member_id = ? AND request_id = ?', current.id, body.request_id);
      if (prior) {
        // A replay reads the current card, so its current predecessor scope
        // must remain valid too. A fresh explicit removal can repair stale links.
        this.scope(current, cardId, null, cred);
        if (prior.card_id !== cardId || prior.binding !== binding) throw new HubError('CONFLICT', 'request_id belongs to another planning edit');
        return { card: cardView(this.hub, row, current.id), replayed: true };
      }
      if (row.version !== body.version) throw new HubError('VERSION_CONFLICT', 'card changed since you loaded it', { version: row.version });
      const start = 'start_date' in body ? body.start_date : row.start_date, due = 'due_date' in body ? body.due_date : row.due_date;
      if (!validRange(start, due)) throw new HubError('VALIDATION', 'use valid YYYY-MM-DD dates, with start before due and a range of at most 3660 days');
      const cards = this.db.all('SELECT id FROM cards WHERE board_id = ? LIMIT ?', row.board_id, MAX_GRAPH_CARDS + 1);
      const edges = this.db.all('SELECT d.card_id, d.depends_on_card_id FROM card_dependencies d JOIN cards c ON c.id = d.card_id WHERE c.board_id = ? LIMIT ?', row.board_id, MAX_GRAPH_EDGES + 1);
      const next = dependencies ? [...edges.filter(e => e.card_id !== cardId), ...dependencies.map(id => ({ card_id: cardId, depends_on_card_id: id }))] : edges;
      try { orderGraph(cards.map(c => c.id), next); } catch (err) { throw new HubError('VALIDATION', err.message); }
      return this.hub.txn(() => {
        const before = this.db.all('SELECT depends_on_card_id FROM card_dependencies WHERE card_id = ? ORDER BY depends_on_card_id', cardId).map(r => r.depends_on_card_id);
        const at = this.hub.iso();
        this.db.run('UPDATE cards SET start_date = ?, due_date = ?, version = version + 1, updated_at = ? WHERE id = ?', start, due, at, cardId);
        if (dependencies) {
          this.db.run('DELETE FROM card_dependencies WHERE card_id = ?', cardId);
          for (const id of dependencies) this.db.run('INSERT INTO card_dependencies VALUES (?, ?, ?, ?)', cardId, id, current.id, at);
        }
        this.db.run('INSERT INTO planning_requests VALUES (?, ?, ?, ?, ?)', current.id, body.request_id, cardId, binding, at);
        // Bounded durable retry history; old retries still cannot bypass version checks.
        this.db.run('DELETE FROM planning_requests WHERE member_id = ? AND rowid NOT IN (SELECT rowid FROM planning_requests WHERE member_id = ? ORDER BY rowid DESC LIMIT 2000)', current.id, current.id);
        this.hub.journal({ board_id: row.board_id, card_id: cardId, actor_kind: 'member', actor_id: current.id, kind: 'card.update', payload: { request_id: body.request_id, fields: { start_date: [row.start_date, start], due_date: [row.due_date, due], ...(dependencies ? { depends_on: [before, dependencies] } : {}) } } });
        this.hub.later(() => this.hub.broadcastCard(cardId));
        return { card: cardView(this.hub, this.hub.card(cardId), current.id) };
      });
    }, { member, cred });
  }
}
