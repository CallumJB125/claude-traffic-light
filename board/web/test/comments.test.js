// Comments with @mentions on the web board (team depth lane A, acceptance A3):
// a stored mention renders as a chip with the member's display name, the
// composer's `@` picker comes from the member list the board already holds,
// and a moment gets its own thread under the Moments panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render, byAttr, byClass, textOf } from '../js/h.js';
import { commentBody, mentionPicker, pickerState, momentThread, applyMention } from '../js/comments.js';
import { momentsPanel } from '../js/moments.js';
import { drawer } from '../js/render-drawer.js';
import { model, view, MEMBERS, ALICE, BOB } from './fixtures.js';
import { displayFace } from '../js/view.js';

const moments = [{ id: 'm1', kind: 'ship', label: 'Checkout went live', note: '', by: 'Ben', at: new Date(Date.now() - 3600_000).toISOString() }];

test('A3: a mention renders as a chip with the member display name; unknown ids stay text', () => {
  const dom = new JSDOM('<main></main>');
  const before = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const root = document.querySelector('main');
    render(root, commentBody('@alice look at @gone', ['m-alice', 'm-gone'], MEMBERS));
    const chips = root.querySelectorAll('.chip-mention');
    assert.equal(chips.length, 1);
    assert.equal(chips[0].textContent, '@Alice');
    assert.equal(chips[0].dataset.member, 'm-alice');
    assert.equal(root.firstChild.textContent, '@Alice look at @gone');
    render(root, commentBody('plain text', [], MEMBERS));
    assert.equal(root.querySelectorAll('.chip-mention').length, 0);
    assert.equal(root.firstChild.textContent, 'plain text');
  } finally {
    globalThis.document = before;
    dom.window.close();
  }
});

test('the @ picker lists matching teammates for the textarea being typed in, and applying one rewrites the text', () => {
  assert.equal(pickerState('card:c-1', 'hello', 5, MEMBERS), null);
  const st = pickerState('card:c-1', 'hey @b', 6, MEMBERS);
  assert.deepEqual(st, { key: 'card:c-1', start: 4, query: 'b', items: [{ member_id: BOB.member_id, name: 'Bob', handle: 'bob' }] });
  assert.equal(pickerState('card:c-1', 'hey @zz', 7, MEMBERS), null, 'no match, no picker');
  const tree = mentionPicker({ mention: st }, 'card:c-1');
  const opts = byAttr(tree, 'data-action', 'mention-pick');
  assert.equal(opts.length, 1);
  assert.deepEqual([opts[0].props['data-member'], opts[0].props['data-name'], opts[0].props['data-mention-for']], ['m-bob', 'Bob', 'card:c-1']);
  assert.equal(mentionPicker({ mention: st }, 'card:other'), null, 'another composer shows nothing');
  assert.deepEqual(applyMention('hey @b', 4, 6, { name: 'Bob' }), { text: 'hey @Bob ', caret: 9 });
});

test('a moment thread: loading, comments with chips, a composer for writers only; the panel toggles it per moment', () => {
  const base = { view: 'board', board: { id: 'b', settings: { moments } } };
  const closed = momentsPanel(model([], base));
  const toggles = byAttr(closed, 'data-action', 'moment-comments');
  assert.equal(toggles.length, 1);
  assert.deepEqual([toggles[0].props['data-moment'], toggles[0].props['aria-expanded'], textOf(toggles[0])], ['m1', 'false', 'Comments']);
  assert.equal(byAttr(closed, 'data-moment-thread').length, 0);

  const loading = momentsPanel(model([], { ...base, momentOpen: new Set(['m1']), momentThreads: new Map() }));
  assert.match(textOf(byAttr(loading, 'data-moment-thread')[0]), /Loading comments/);

  const items = [{ id: 'cm1', author_name: 'Bob', body: '@alice ship it', mentions: ['m-alice'], reply_to: null, created_age_ms: 120_000 }];
  const ready = momentsPanel(model([], { ...base, momentOpen: new Set(['m1']), momentThreads: new Map([['m1', { status: 'ready', items }]]) }));
  const thread = byAttr(ready, 'data-moment-thread')[0];
  assert.equal(byClass(thread, 'chip-mention')[0].children[0].text, '@Alice');
  assert.match(textOf(thread), /Bob.*2 min ago/s);
  assert.equal(textOf(byAttr(ready, 'data-action', 'moment-comments')[0]), '1 comment');
  const form = byAttr(thread, 'data-form', 'moment-comment')[0];
  assert.equal(form.props['data-moment'], 'm1');
  assert.equal(byAttr(form, 'data-mentions')[0].props['data-mentions'], 'moment:m1');
  assert.equal(byAttr(ready, 'data-form', 'moment-mark').length, 1, 'the mark form stays');

  const ro = momentThread(model([], { readOnly: true, momentThreads: new Map([['m1', { status: 'ready', items: [] }]]) }), 'm1');
  assert.equal(byAttr(ro, 'data-form').length, 0);
  assert.match(textOf(ro), /No comments yet/);
  const err = momentThread(model([], { momentThreads: new Map([['m1', { status: 'error', items: [] }]]) }), 'm1');
  assert.match(textOf(err), /Could not load/);
});

test('the card drawer renders comment mentions as chips and its composer carries the picker key', () => {
  const v = view();
  const comments = [{ id: 'c1', author_name: 'Alice', source: 'web', trusted: true, body: 'ping @bob', mentions: ['m-bob'], for_agent: false, reply_to: null, created_age_ms: 1000 }];
  const m = model([{ view: v, elapsed_ms: 0, face: displayFace(v, { elapsed_ms: 0, connection_lost: false }) }], { detail: { cardId: v.id, data: { card: v, feed: [], comments, asks: [], permission_requests: [] }, elapsed_ms: 0, tab: 'comments' }, mention: { key: `card:${v.id}`, start: 0, query: 'a', items: [{ member_id: ALICE.member_id, name: 'Alice', handle: 'alice' }] } });
  const tree = drawer(m);
  const chips = byClass(tree, 'chip-mention');
  assert.equal(chips.length, 1);
  assert.equal(chips[0].children[0].text, '@Bob');
  assert.equal(byAttr(tree, 'data-mentions')[0].props['data-mentions'], `card:${v.id}`);
  assert.equal(byAttr(tree, 'data-action', 'mention-pick').length, 1);
});
