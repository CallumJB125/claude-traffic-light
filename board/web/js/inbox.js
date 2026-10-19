// The hub inbox bell in the board header (team depth lane B): every row the hub
// kept for you (mentions, replies, moments, hand-offs, answered inputs) from
// GET /api/account/inbox, with Mark read and Mark all read. Text only; a row
// names a card so Open can show it, and nothing else is read from the row.
import { h } from './h.js';
import { icon } from './icons.js';

export const INBOX_LABEL = Object.freeze({ mention: 'Mentioned you', reply: 'Replied to you', moment: 'Marked a moment', handoff_request: 'Handed you a card', handoff_answer: 'Answered your hand-off', input_answered: 'Answered your session\'s question' });
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');
const ago = (ms) => (!Number.isFinite(ms) || ms < 0 ? '' : ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`);

// Who did it and to what, from the row's ref and the members the board already lists.
export function inboxText(item, members = []) {
  const id = str(item.ref?.by, 100);
  const list = Array.isArray(members) ? members : members instanceof Map ? [...members.values()] : [];
  const by = id ? list.find((m) => m.id === id || m.member_id === id) : null;
  const who = str(item.ref?.by_name, 120) || str(by?.display_name ?? by?.name, 120) || 'A teammate';
  const thing = str(item.ref?.title, 200) || str(item.ref?.label, 120) || str(item.ref?.excerpt, 200);
  return `${who} · ${INBOX_LABEL[item.kind] ?? 'needs you to look'}${thing ? `: ${thing}` : ''}`;
}

export function inboxBell(model) {
  const inbox = model.inbox;
  if (!inbox) return null;
  const items = Array.isArray(inbox.items) ? inbox.items : [];
  const unread = items.filter((i) => !i.read_at).length;
  const now = model.now ?? Date.now();
  return h('details', { class: 'menu-wrap topbar-inbox', open: inbox.open || undefined, 'data-action-toggle': 'inbox' },
    h('summary', { class: `btn btn-ghost btn-sm inbox-bell${unread ? ' has-unread' : ''}`, 'aria-label': unread ? `Inbox, ${unread} unread` : 'Inbox', title: 'Inbox' },
      icon('bell', 'icon-lead'), unread ? h('span', { class: 'inbox-count num', 'aria-hidden': 'true' }, String(Math.min(unread, 99))) : null),
    h('div', { class: 'menu inbox-menu', role: 'region', 'aria-label': 'Inbox' },
      h('div', { class: 'inbox-head' }, h('strong', {}, unread ? `${unread} unread` : 'Inbox'),
        unread ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'inbox-read-all' }, 'Mark all read') : null),
      items.length ? h('ul', { class: 'inbox-list' }, items.slice(0, 50).map((it) => h('li', { key: it.id, class: `inbox-item${it.read_at ? ' is-read' : ''}`, 'data-inbox': it.id },
        h('div', { class: 'inbox-text' }, h('span', { class: 'inbox-title' }, inboxText(it, model.members)),
          h('span', { class: 'muted small' }, ago(now - Date.parse(it.created_at)))),
        h('div', { class: 'inbox-actions' },
          str(it.ref?.card_id, 100) ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'inbox-open', 'data-inbox': it.id, 'data-card': it.ref.card_id }, 'Open') : null,
          it.read_at ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'inbox-read', 'data-inbox': it.id }, 'Mark read')))))
        : h('p', { class: 'muted small inbox-empty' }, 'Nothing for you yet. Mentions, replies, moments and hand-offs land here.')));
}
