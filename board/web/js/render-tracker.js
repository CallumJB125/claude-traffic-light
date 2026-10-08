import { h } from './h.js';

const SETUP = {
  linear: 'In Linear: Settings → API → Webhooks, data change events for Issues, signed with the secret you pasted here.',
  jira: 'In Jira: Settings → System → WebHooks, events Issue created and Issue updated, with the secret you pasted here.',
};

export function trackerIntake(conn, m, name) {
  const board = (m.boards ?? []).find((b) => b.id === conn.target_board_id);
  const paused = !board || board.archived_at;
  return h('section', { class: 'integ-section', 'aria-label': `${name} intake` },
    h('h4', null, `${name} intake`),
    paused ? h('p', { class: 'small', role: 'status' }, m.canEdit ? 'New intake is paused until you choose an active board above.' : 'New intake is paused until an admin chooses an active board.') : null,
    h('p', { class: 'muted small' }, `New and updated ${name} issues become Todo cards, one per issue. Status changes add a comment to that card; they never move it or start an AI. Issues already done or canceled make no card.`),
    m.canEdit && SETUP[conn.provider] ? h('p', { class: 'muted small' }, SETUP[conn.provider]) : null);
}
