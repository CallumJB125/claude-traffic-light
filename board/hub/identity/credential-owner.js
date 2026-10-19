import { HubError } from '../db.js';

// The captured user remains the request principal while it waits for a queue.
// A live credential alone does not prove that it still belongs to that user.
export function requireCredentialOwner(hub, cred, userId) {
  if (!cred) return;
  if (!['device', 'session'].includes(cred.kind) || !hub.accounts?.credValid(cred)) {
    throw new HubError('UNAUTHENTICATED', 'sign in again');
  }
  const owner = cred.kind === 'device'
    ? hub.db.get('SELECT user_id FROM user_devices WHERE id = ?', cred.id)
    : hub.db.get('SELECT user_id FROM sessions WHERE id = ?', cred.id);
  if (!owner || owner.user_id !== userId) {
    throw new HubError('UNAUTHENTICATED', 'credential does not belong to this user');
  }
}
