// The append-only journal (CONTRACT §15, P-1): row kinds and a pure replay()
// that rebuilds every card's state from the rows alone. Browser-safe.

export const JOURNAL_KINDS = Object.freeze([
  'card.create',        // {key, title, body, acceptance, repo_id, base_ref, labels, budget_cents, column_name, cover?, parent_card_id?}; by an integration {title_hmac, body_hmac, acceptance_hmac, connection_id, external_ref_hmac, base_ref_hmac, request_id_hmac} instead of the text and ids, labels only via:<provider> (D41: replay has no title or base_ref, `cards` does)
  'card.update',        // {fields: {name: [before, after]}}: human PATCH, dispatch budget, label rename/strip (cause:'label.rename'|'label.delete', label_id; D91); on an integration's card title/body/acceptance/base_ref/labels are <name>_hmac: [refHash, refHash] (D41)
  'card.transition',    // {rule, event, from, to, state: CARD_STATE, effects: [type]} — every state.step() applied
  'run.create',         // {fence, device_id, branch, snapshot_ref, dispatch_request_id}
  'run.snapshot',       // {status, sha, ref, provenance?}
  'ask.create',         // {ask_id, kind}
  'ask.answer',         // {ask_id, by}
  'permission.create',  // {permission_request_id, tool}
  'permission.answer',  // {permission_request_id, decision, scope}
  'permission.cancel',  // {permission_request_id}
  'handover.version',   // {version, written_by, provenance}
  'evidence.create',    // {evidence_id, kind, ref, verification, result}
  'plan.declare',       // {paths}
  'comment.create',     // {comment_id, source, for_agent}
  'feed.relabel',       // {event_id, relabel}: replaces the old in-place events UPDATE
  'hub.restore_bump',   // {bump}: every card fence += bump (Litestream restore, D10)
  'card.notify',        // {rule, to}: every notify effect (D40) and the delayed orphan notification
  'lesson.create',      // {lesson_id, repo_id}: board_add_lesson (no text, like comment.create)
  'integration.connect',    // {connection_id, provider}: a team connected a tool (D41; never secrets)
  'integration.disconnect', // {connection_id, provider}
  'label.create',       // {label_id, name, color}: board label registry (D91; board_id set, card_id NULL; never the description)
  'label.update',       // {label_id, fields: {name?: [b, a], color?: [b, a]}, description_changed?: true}
  'label.delete',       // {label_id, name, strip}
  'card.archive',       // {request_id, archived_at, archived_by} (D94)
  'card.restore',       // {request_id}
  'device.outbox',      // {reason:'runner_acked'|'gap'|'reset', from, to, outbox_id?}: a device's last_seq_acked moved other than by an ack (board_id NULL)
  'board.create',       // {name, key_prefix}; team-wide board lifecycle
  'board.rename',       // {name: [before, after]}; keys and links never change
  'board.archive',      // {archived_at}; board becomes read-only
  'board.restore',      // {archived_at: null}
  'workflow.publish',   // {recipe_id, version, content_hmac}; version content stays in the editable library
  'workflow.archive',   // {recipe_id, archived}; instantiated tasks remain ordinary cards
  'workflow.apply',     // {instance_id, recipe_id, version, content_hmac, context_hmac}
]);

// The card fields a transition writes (states.CARD_FIELDS + the derived column).
export const CARD_STATE = Object.freeze(['run_state', 'column_name', 'blocked_kind', 'fail_kind', 'resume_to', 'pre_reconnect_state', 'fence', 'handover_target', 'handover_provenance']);
const CREATE_FIELDS = ['key', 'title', 'body', 'acceptance', 'repo_id', 'base_ref', 'labels', 'budget_cents', 'column_name', 'cover', 'parent_card_id'];

/**
 * rows: journal rows in seq order ({seq, card_id, kind, payload} with payload
 * as an object or JSON text). → Map(card_id → card state). `run_state` uses the
 * DB form (null = todo).
 */
export function replay(rows) {
  const cards = new Map();
  for (const row of rows) {
    const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {});
    if (row.kind === 'hub.restore_bump') {
      for (const c of cards.values()) c.fence += p.bump;
      continue;
    }
    if (!row.card_id) continue;
    if (row.kind === 'card.create') {
      const c = { id: row.card_id, run_state: null, blocked_kind: null, fail_kind: null, resume_to: null, pre_reconnect_state: null, fence: 0, handover_target: null, handover_provenance: null, archived_at: null, archived_by: null };
      for (const f of CREATE_FIELDS) c[f] = p[f] ?? null;
      c.column_name = p.column_name ?? 'todo';
      cards.set(row.card_id, c);
      continue;
    }
    const c = cards.get(row.card_id);
    if (!c) continue;
    if (row.kind === 'card.update') {
      for (const [f, v] of Object.entries(p.fields ?? {})) c[f] = Array.isArray(v) ? v[1] : v;
    } else if (row.kind === 'card.transition') {
      for (const f of CARD_STATE) if (f in (p.state ?? {})) c[f] = p.state[f];
    } else if (row.kind === 'card.archive') {
      c.archived_at = p.archived_at ?? row.at_hub;
      c.archived_by = p.archived_by ?? null;
    } else if (row.kind === 'card.restore') {
      c.archived_at = null;
      c.archived_by = null;
    }
  }
  return cards;
}
