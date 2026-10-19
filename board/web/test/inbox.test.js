import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxBell, inboxText } from '../js/inbox.js';
import { topBar } from '../js/render-board.js';
import { byAttr, textOf } from '../js/h.js';
import { model } from './fixtures.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const items = [
  { id: 'i1', org_id: 'o', kind: 'mention', ref: { card_id: 'c1', by: 'm-ben', title: 'Fix login' }, created_at: new Date(NOW - 5 * 60_000).toISOString(), read_at: null },
  { id: 'i2', org_id: 'o', kind: 'handoff_request', ref: { card_id: 'c2', by_name: 'Cy', handoff_id: 'h1' }, created_at: new Date(NOW - 3_600_000).toISOString(), read_at: null },
  { id: 'i3', org_id: 'o', kind: 'moment', ref: { moment_id: 'm1', label: 'Checkout live' }, created_at: new Date(NOW - 2 * 86_400_000).toISOString(), read_at: new Date(NOW - 86_400_000).toISOString() },
];
const members = [{ id: 'm-ben', name: 'Ben', login: 'ben' }];

test('inbox bell: unread count on the bell, one row per item with Open (cards only) and Mark read (unread only), Mark all read when anything is unread', () => {
  const tree = inboxBell(model([], { inbox: { items, open: true }, members, now: NOW }));
  assert.equal(textOf(byAttr(tree, 'class').find((n) => n.props.class === 'inbox-count num')), '2');
  assert.equal(byAttr(tree, 'aria-label')[0].props['aria-label'], 'Inbox, 2 unread');
  const text = textOf(tree);
  assert.match(text, /Ben · Mentioned you: Fix login/);
  assert.match(text, /Cy · Handed you a card/);
  assert.match(text, /A teammate · Marked a moment: Checkout live/);
  assert.match(text, /5 min ago/); assert.match(text, /1 h ago/); assert.match(text, /2 d ago/);
  const actions = byAttr(tree, 'data-action').map((b) => [b.props['data-action'], b.props['data-inbox'] ?? null, b.props['data-card'] ?? null]);
  assert.deepEqual(actions, [['inbox-read-all', null, null], ['inbox-open', 'i1', 'c1'], ['inbox-read', 'i1', null], ['inbox-open', 'i2', 'c2'], ['inbox-read', 'i2', null]]);
  assert.equal(byAttr(tree, 'class').filter((n) => /\bis-read\b/.test(n.props.class)).length, 1, 'the read moment is dimmed and keeps no Mark read');
});

test('inbox bell: all read → no count and no Mark all read; empty → a hint; no inbox (older hub) → no bell at all', () => {
  const read = inboxBell(model([], { inbox: { items: [items[2]] }, now: NOW }));
  assert.equal(byAttr(read, 'class').some((n) => n.props.class === 'inbox-count num'), false);
  assert.equal(byAttr(read, 'data-action').some((b) => b.props['data-action'] === 'inbox-read-all'), false);
  assert.equal(byAttr(read, 'aria-label')[0].props['aria-label'], 'Inbox');
  assert.match(textOf(inboxBell(model([], { inbox: { items: [] } }))), /Nothing for you yet/);
  assert.equal(inboxBell(model([], { inbox: null })), null);
  assert.equal(byAttr(topBar(model([], { inbox: null }), {}), 'class').some((n) => /topbar-inbox/.test(n.props.class)), false);
  assert.equal(byAttr(topBar(model([], { inbox: { items } }), {}), 'class').some((n) => /topbar-inbox/.test(n.props.class)), true, 'the bell sits in the top bar');
});

test('inbox text: names the member from the board list or the ref, never echoes an oversized or non-string field', () => {
  assert.equal(inboxText({ kind: 'reply', ref: { by: 'm-ben' } }, members), 'Ben · Replied to you');
  assert.equal(inboxText({ kind: 'input_answered', ref: { by_name: 'x'.repeat(121) } }, members), "A teammate · Answered your session's question");
  assert.equal(inboxText({ kind: 'weird', ref: { title: 42 } }, []), 'A teammate · needs you to look');
});
