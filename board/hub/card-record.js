// Internal row insertion only. Callers retain validation/authorization and
// own the board queue, transaction, provenance journal and broadcasts.
import { HubError } from './db.js';
import { can } from './permissions.js';

export function insertCardRecord(hub, boardId, memberId, fields, { id, now, assignees = [] }) {
  if (!hub.db.depth || !hub.inBoard(boardId)) throw new Error('card insertion requires its board transaction');
  const board = hub.board(boardId), member = hub.activeMember(memberId);
  if (!board || member?.org_id !== board.org_id) throw new HubError('NOT_FOUND', 'card destination not found');
  if (!can(member, 'card.write')) throw new HubError('FORBIDDEN', 'viewers cannot change the board');
  if (board.archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
  hub.db.run('UPDATE boards SET next_key = next_key + 1 WHERE id = ?', boardId);
  hub.db.insert('cards', { ...fields, id, board_id: boardId, key: `${board.key_prefix}-${board.next_key}`, created_by: memberId, created_at: now, updated_at: now, state_since: now });
  for (const a of new Set(assignees)) hub.db.insert('card_assignees', { card_id: id, member_id: a, role: 'collaborator' });
  return hub.card(id);
}
