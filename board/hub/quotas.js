// Accepted row creation, inside its existing transaction. All authors and
// archived cards count; observed runner outbox outcomes stay recordable.
import { HubError } from './db.js';
import { quotaFor } from './identity/teams.js';
import { requireStorage } from './storage-watch.js';

const COUNTS = Object.freeze({
  cards: 'SELECT COUNT(*) AS n FROM cards c JOIN boards b ON b.id=c.board_id WHERE b.org_id=?',
  comments: 'SELECT COUNT(*) AS n FROM comments c JOIN cards t ON t.id=c.card_id JOIN boards b ON b.id=t.board_id WHERE b.org_id=?',
});

export function requireRows(hub, orgId, resource) {
  if (!Object.hasOwn(COUNTS, resource)) throw new Error('unknown row quota');
  if (!hub.db.depth) throw new Error('row quota requires its creation transaction');
  requireStorage(hub);
  if (hub.config.auth !== 'accounts') return;
  const org = hub.db.get('SELECT plan FROM orgs WHERE id=? AND deleted_at IS NULL', orgId);
  if (!org) throw new HubError('NOT_FOUND', 'team not found');
  const limit = quotaFor(org.plan, resource);
  if (!Number.isFinite(limit)) return;
  if (hub.db.get(COUNTS[resource], orgId).n >= limit) {
    throw new HubError('QUOTA_EXCEEDED', `this team's plan allows at most ${limit} ${resource}`, { resource, limit });
  }
}
