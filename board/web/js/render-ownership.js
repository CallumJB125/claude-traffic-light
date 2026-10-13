import { h } from './h.js';

const REASONS = { awaiting_heartbeat: 'Waiting for a fresh host heartbeat', not_current: 'Previous run', read_only: 'Read only',
  hub_restarted: 'Waiting after board restart', connection_changed: 'Host connection changed', expired: 'Heartbeat expired',
  idle: 'Agent is idle', waiting: 'Agent is waiting', finishing: 'Agent is finishing', run_ended: 'Awaiting review' };

export function ownershipStatus(entry, elapsed = 0, connected = true) {
  if (!connected) return 'Signal unavailable';
  if (entry.state === 'awaiting_review') return 'Awaiting review';
  if (entry.state === 'editing') {
    return Number.isFinite(entry.expires_in_ms) && entry.expires_in_ms - Math.max(0, elapsed) > 0
      ? 'Agent active · fresh host signal' : 'Heartbeat expired';
  }
  return REASONS[entry.reason] ?? 'Declared work';
}

export function ownershipPanel(detail, model, elapsed = 0) {
  if (detail.data.card.archived) return h('p', { class: 'muted' }, 'Restore this task to view coordination.');
  if (detail.ownershipError) return h('div', null, h('p', { class: 'form-error', role: 'alert' }, detail.ownershipError),
    h('button', { class: 'btn btn-sm', 'data-action': 'ownership-reload' }, 'Reload coordination'));
  if (!detail.ownershipLoaded) return h('p', { class: 'muted', role: 'status' }, 'Loading coordination…');
  const data = detail.ownership, connected = model.conn?.status === 'open', own = data?.ownership;
  const peers = (data?.ownership_intents ?? []).filter(p => p && p.run_id !== own?.run_id);
  const paths = (entry) => entry.paths?.length ? h('ul', { class: 'md-list' }, entry.paths.map(p => h('li', { key: p }, h('code', null, p))))
    : h('p', { class: 'muted small' }, 'No file paths declared.');
  const participant = (entry) => h('li', { key: entry.run_id, class: 'comment' },
    h('div', { class: 'comment-head' }, h('strong', null, entry.author?.name ?? 'Teammate'),
      h('span', { class: 'muted small' }, entry.author?.provider_label ?? 'Agent')),
    h('p', null, `${entry.card_key ?? 'Task'} · ${entry.card_title ?? ''}`),
    h('p', { class: 'muted small', role: 'status' }, ownershipStatus(entry, elapsed, connected)), paths(entry),
    entry.paths_truncated ? h('p', { class: 'muted small' }, 'Showing the first 20 declared paths.') : null);
  return h('div', { class: 'task-ownership' },
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'ownership-reload' }, 'Refresh coordination'),
    h('p', { class: 'muted small' }, 'Declared paths help teammates coordinate. They do not lock files or grant permission to edit.'),
    own ? h('div', null, h('h3', null, 'This task'), h('ul', { class: 'comments' }, participant(own)))
      : h('p', { class: 'muted' }, 'This task has no current agent declaration.'),
    data?.ownership_overlaps?.length ? h('section', { 'aria-label': 'Declared overlaps' }, h('h3', null, 'Declared paths overlap'),
      h('p', { class: 'muted small' }, 'Check with the teammate before editing shared files.'),
      h('ul', { class: 'md-list' }, data.ownership_overlaps.map(o => h('li', { key: o.run_id },
        `${(data.ownership_intents ?? []).find(p => p?.run_id === o.run_id)?.card_key ?? 'Peer task'}: ${o.paths.join(', ')}`,
        o.paths_truncated ? ' · first 20 paths shown' : null)))) : null,
    peers.length ? h('section', { 'aria-label': 'Other declared work' }, h('h3', null, 'Other work on this board and repository'), h('ul', { class: 'comments' }, peers.map(participant))) : null,
    data?.ownership_truncated ? h('p', { class: 'muted small' }, 'Showing the latest 50 declarations. Refresh for current coordination.') : null);
}
