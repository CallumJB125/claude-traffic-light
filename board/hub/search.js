// Staff search uses the same team-wide board access as ordinary reads. There
// is no global index, credential text, artifact content or guest API here.
import { HubError } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
function snippet(text, terms) {
  const value = clean(text), lower = value.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0);
  const start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 55);
  return `${start ? '…' : ''}${value.slice(start, start + 180)}${value.length > start + 180 ? '…' : ''}`;
}

export function searchWork(hub, member, query, { cred = null } = {}) {
  if (cred && !hub.accounts?.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
  const fresh = hub.activeMember(member?.id);
  if (!fresh || fresh.org_id !== member.org_id || !hub.db.get('SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL', fresh.org_id)
    || (fresh.user_id && !hub.db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', fresh.user_id))) throw new HubError('NOT_FOUND', 'team not found');
  const allowed = new Set(['q', 'board_id', 'limit', 'org', 'team']);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) throw new HubError('VALIDATION', 'invalid search options');
  const q = query.get('q');
  if (typeof q !== 'string' || q.trim().length < 2 || q.length > 120 || /[\u0000-\u001f\u007f]/.test(q)) throw new HubError('VALIDATION', 'search must be 2–120 characters');
  const terms = [...new Set(q.trim().toLowerCase().split(/\s+/))];
  if (terms.length > 6) throw new HubError('VALIDATION', 'search supports up to six words');
  const rawLimit = query.get('limit') ?? '20';
  if (!/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > 40) throw new HubError('VALIDATION', 'search limit must be 1–40');
  const limit = Number(rawLimit), boardId = query.get('board_id');
  if (boardId !== null) {
    const board = UUID.test(boardId) && hub.board(boardId);
    if (!board || board.org_id !== fresh.org_id || board.archived_at) throw new HubError('NOT_FOUND', 'board not found');
  }
  const args = [fresh.org_id, ...(boardId ? [boardId] : [])];
  const scope = `b.org_id = ? AND b.archived_at IS NULL AND c.archived_at IS NULL${boardId ? ' AND b.id = ?' : ''}`;
  const base = 'c.id AS card_id, c.key AS card_key, c.title AS card_title, b.id AS board_id, b.name AS board_name';
  const sources = [
    { kind: 'card', section: 'details', from: 'cards c JOIN boards b ON b.id = c.board_id', id: 'c.id', text: "c.key || char(10) || c.title || char(10) || c.body || char(10) || COALESCE(c.acceptance, '')", order: 'c.updated_at DESC, c.id' },
    { kind: 'comment', section: 'comments', from: 'comments s JOIN cards c ON c.id = s.card_id JOIN boards b ON b.id = c.board_id', id: 's.id', text: 's.body', order: 's.created_at DESC, s.id' },
    { kind: 'handover', section: 'handover', from: 'handovers s JOIN cards c ON c.id = s.card_id JOIN boards b ON b.id = c.board_id', id: "c.id || ':' || s.version", text: "COALESCE(json_extract(s.sections, '$.plan'), '') || char(10) || COALESCE(json_extract(s.sections, '$.done'), '') || char(10) || COALESCE(json_extract(s.sections, '$.hypothesis'), '') || char(10) || COALESCE(json_extract(s.sections, '$.dead_ends'), '') || char(10) || COALESCE(json_extract(s.sections, '$.next'), '') || char(10) || COALESCE(json_extract(s.sections, '$.questions'), '')", extra: 'AND s.version = (SELECT MAX(version) FROM handovers WHERE card_id = c.id)', order: 's.created_at DESC, c.id' },
    { kind: 'artifact', section: 'details', from: 'client_artifact_versions s JOIN client_items i ON i.id = s.item_id JOIN client_projects p ON p.id = i.project_id JOIN cards c ON c.id = i.card_id JOIN boards b ON b.id = c.board_id', id: 's.id', text: "s.name || char(10) || i.title || char(10) || i.summary", extra: 'AND p.workspace_id = b.org_id AND i.unpublished_at IS NULL AND s.version_number = (SELECT MAX(version_number) FROM client_artifact_versions WHERE item_id = i.id)', order: 's.created_at DESC, s.id' },
  ];
  const results = [];
  for (const source of sources) {
    // SQL values are bound; %, _, quotes and SQL-looking text are literals.
    const match = terms.map(() => `instr(lower(${source.text}), ?) > 0`).join(' AND ');
    const rows = hub.db.all(`SELECT ${base}, ${source.id} AS source_id, ${source.text} AS text FROM ${source.from}
      WHERE ${scope} ${source.extra ?? ''} AND ${match} ORDER BY ${source.order} LIMIT ?`, ...args, ...terms, limit + 1);
    for (const row of rows) results.push({ id: `${source.kind}:${row.source_id}`, kind: source.kind,
      board: { id: row.board_id, name: row.board_name }, card: { id: row.card_id, key: row.card_key, title: row.card_title },
      snippet: snippet(row.text, terms), section: source.section });
  }
  return { query: q.trim(), results: results.slice(0, limit), truncated: results.length > limit };
}
