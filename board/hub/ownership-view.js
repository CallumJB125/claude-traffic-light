// Read-only staff projection; the enrolled runner remains the authority for
// declared paths and current lease observations.
import { TeamCommunication } from './communication.js';
import { HubError } from './db.js';

export async function readOwnership(hub, member, cardId, cred, options = {}) {
  const communication = new TeamCommunication(hub);
  const actor = member && Object.freeze({ id: member.id, org_id: member.org_id, user_id: member.user_id });
  const credential = cred ? Object.freeze({ kind: cred.kind, id: cred.id }) : null;
  if (options.boardIds != null && !Array.isArray(options.boardIds)) throw new HubError('VALIDATION', 'Invalid board selection.');
  const narrowed = options.boardIds == null ? {} : { boardIds: Object.freeze([...options.boardIds]) };
  const initial = communication.human(actor, cardId, credential, false, narrowed);
  await hub.ownership.staffRead(actor, cardId, credential, narrowed);
  // Do not deliver a result captured before an asynchronous queue wait or a
  // changed account. Reproject current peers and leases after fresh authority.
  const scope = communication.human(actor, cardId, credential, false, narrowed);
  if (scope.row.board_id !== initial.row.board_id || scope.row.repo_id !== initial.row.repo_id) {
    throw new HubError('CONFLICT', 'Task context changed; reload the task.');
  }
  scope.run = hub.run(scope.row.active_run_id);
  const result = hub.ownership.snapshotFor(scope, narrowed);
  const decorate = (entry) => {
    if (!entry) return null;
    const row = hub.card(entry.card_id), live = hub.ownership.live.get(entry.run_id);
    return { ...entry, card_key: row?.key ?? null, card_title: row?.title ?? null,
      expires_in_ms: entry.state === 'editing' && live ? Math.max(0, live.deadline - hub.mono()) : null };
  };
  return { ...result, ownership: decorate(result.ownership), ownership_intents: result.ownership_intents.map(decorate),
    global_filesystem_lock: false };
}
