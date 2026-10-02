// Durable receipt pointers preserve application provenance in ordinary staff
// views as well as remote responses. Application names are never verified.
export function commentIdentity(hub, comment) {
  const grant = hub.db.get(`SELECT g.application, g.user_id FROM remote_grants g WHERE g.id = (
    SELECT a.grant_id FROM remote_actions a WHERE a.tool = 'plexiform_add_comment'
      AND json_extract(a.response, '$.comment_id') = ? LIMIT 1
    ) OR g.id = (
    SELECT substr(m.actor_key, 8) FROM task_messages m WHERE m.comment_id = ?
      AND m.actor_key LIKE 'remote:%' LIMIT 1
    ) LIMIT 1`, comment.id, comment.id);
  return grant ? { ...comment, identity_source: 'remote_grant', account_id: grant.user_id,
    application: grant.application, application_verified: false } : comment;
}
