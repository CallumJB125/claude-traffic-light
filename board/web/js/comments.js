// Comments with @mentions (team depth lane A): a comment body renders its
// stored mentions (member ids from the hub) as chips carrying the member's
// current display name; the composer offers an `@` picker from the member
// list the board already holds for assignees; a moment gets a thread of its
// own under the Moments panel. Pure: (model, …) → vnodes.
import { h } from './h.js';
import { segmentMentions, mentionQuery, mentionMatches, applyMention } from '../../shared/mentions.js';

export { mentionQuery, mentionMatches, applyMention };

const memberName = (members, id) => (members?.get ? members.get(id)?.name : null) ?? null;

// The body of one comment: text, with each stored mention as a chip. An id
// the member list no longer knows (left the team) stays as the typed text.
export function commentBody(body, mentions, members, props = {}) {
  const parts = segmentMentions(body, mentions, members ? [...members.values()] : []);
  return h('p', { class: 'comment-body', ...props }, parts.map((p) => (p.mention && memberName(members, p.mention)
    ? h('span', { class: 'chip chip-mention', 'data-member': p.mention, title: p.text }, `@${memberName(members, p.mention)}`)
    : p.text)));
}

// The picker under the composer the person is typing an `@` in. `model.mention`
// is {key, start, query, items:[{member_id, name, handle}]} or null.
export function mentionPicker(model, key) {
  const m = model.mention;
  if (!m || m.key !== key || !m.items?.length) return null;
  return h('ul', { class: 'mention-pick', role: 'listbox', 'aria-label': 'Mention a teammate', 'data-mention-for': key },
    m.items.map((it, i) => h('li', { key: it.member_id, role: 'option', 'aria-selected': i === 0 ? 'true' : 'false' },
      h('button', { type: 'button', class: 'mention-option', 'data-action': 'mention-pick', 'data-mention-for': key, 'data-member': it.member_id, 'data-name': it.name }, it.name,
        it.handle !== it.name.toLowerCase() ? h('span', { class: 'muted small' }, ` @${it.handle}`) : null))));
}

// What the composer needs on input: the picker state for this textarea, or null when the caret is not in an `@`.
export function pickerState(key, text, caret, members) {
  const q = mentionQuery(text, caret);
  if (!q) return null;
  const items = mentionMatches(q.query, members ? [...members.values()] : []);
  return items.length ? { key, start: q.start, query: q.query, items } : null;
}

const ago = (ms) => (!(ms >= 0) ? '' : ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`);

// A moment's thread: its comments (oldest first) and a composer for writers.
// `thread` is model.momentThreads.get(id): {status:'loading'|'ready'|'error', items:[comment]}.
export function momentThread(model, momentId) {
  const thread = model.momentThreads?.get?.(momentId) ?? { status: 'loading', items: [] };
  const key = `moment:${momentId}`;
  const busy = model.busy?.has?.(key);
  return h('div', { class: 'moment-thread', 'data-moment-thread': momentId },
    thread.status === 'loading' ? h('p', { class: 'muted small' }, 'Loading comments…')
      : thread.status === 'error' ? h('p', { class: 'muted small' }, 'Could not load the comments.')
        : thread.items.length ? h('ul', { class: 'comments' }, thread.items.map((c) => h('li', { key: c.id, class: 'comment' },
          h('div', { class: 'comment-head' },
            h('span', { class: 'comment-author' }, c.author_name ?? 'Someone'),
            h('span', { class: 'num muted' }, ago(c.created_age_ms))),
          commentBody(c.body, c.mentions, model.members))))
          : h('p', { class: 'muted small' }, 'No comments yet.'),
    model.readOnly ? null : h('form', { class: 'composer', 'data-form': 'moment-comment', 'data-moment': momentId, 'aria-label': 'Comment on this moment' },
      h('textarea', { name: 'body', class: 'input', rows: 2, required: true, maxlength: '10000', placeholder: 'Write a comment… @ mentions a teammate', 'aria-label': 'Comment', 'data-mentions': key }),
      mentionPicker(model, key),
      h('div', { class: 'composer-row' }, h('button', { type: 'submit', class: 'btn btn-primary btn-sm', disabled: busy || null }, 'Add comment'))));
}
