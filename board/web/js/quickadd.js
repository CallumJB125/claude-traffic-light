// Inline quick-add, pure parts: turning typed or pasted text into titles and
// building the optimistic card shown until the hub answers.

// Past this many pasted lines the person is asked first: a stray paste of a
// log or a list must not silently create a screenful of cards.
export const CONFIRM_OVER = 5;
export const MAX_TITLE = 200;

/** One title per non-empty line; list bullets and "1." numbering are not part of the title. */
export function parseTitles(text) {
  return String(text ?? '').split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim().slice(0, MAX_TITLE))
    .filter(Boolean);
}

export const needsConfirm = (titles) => titles.length > CONFIRM_OVER;

/**
 * A CardView good enough for cardFace/card(): a human-owned To do card, marked
 * `pending` so it can't be opened, dragged or acted on until the hub's card
 * replaces it.
 */
export function pendingCard(title, seq, { prefix = null, memberId = null } = {}) {
  return {
    id: `pending-${seq}`, key: prefix ? `${prefix}-…` : '…', title, labels: [], column: 'todo', version: 0, pending: true,
    agent_suggested: false, parent_card_id: null, run_state: 'todo', blocked_kind: null, fail_kind: null, fail_reason: null, resume_to: null, fence: 0,
    repo: null, base_ref: null, branch: null, assignee_ids: memberId ? [memberId] : [], approvers: [], viewer_can_approve: false,
    target: null, queue: null, run: null, live: null, state_age_ms: 0, ask: null, handover: null, handover_target_name: null, stopped_by_name: null,
    limit_resets_in_ms: null, device_kind: null, overlaps: [], budget: null, pr: null, evidence: null,
  };
}
