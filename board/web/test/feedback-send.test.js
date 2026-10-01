// The desktop "Send feedback" hand-off: strict fragment decoding, the dialog
// that shows the exact text, and the one POST a click makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textOf, byAttr } from '../js/h.js';
import { feedbackDialog } from '../js/render-dialogs.js';
import { decodeFeedback, sendFeedback, FRAGMENT_PREFIX, NO_BOARD_TEXT, FAILED_TEXT, SENT_TEXT, VIEWER_TEXT } from '../js/feedback-send.js';
import { model } from './fixtures.js';

const RID = '123e4567-e89b-42d3-a456-426614174000';
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const frag = (o) => FRAGMENT_PREFIX + b64u(o);
const good = { v: 1, kind: 'bug', title: 'It broke', body: 'Steps\n<script>alert(1)</script>', requestId: RID };

test('a valid fragment decodes to exactly the four fields', () => {
  assert.deepEqual(decodeFeedback(frag(good)), { kind: 'bug', title: 'It broke', body: good.body, requestId: RID });
  assert.equal(decodeFeedback(frag({ ...good, kind: 'idea', extra: 1 })).kind, 'idea');
});

test('bad input is rejected', () => {
  const bad = [
    frag({ ...good, v: 2 }), frag({ ...good, kind: 'rant' }), frag({ ...good, title: '' }), frag({ ...good, title: 'x'.repeat(201) }),
    frag({ ...good, body: 'x'.repeat(20_001) }), frag({ ...good, body: 5 }), frag({ ...good, requestId: 'nope' }),
    frag([1]), frag('null'), frag('not json'), `${FRAGMENT_PREFIX}!!!`, `${FRAGMENT_PREFIX}`, `${FRAGMENT_PREFIX}a`,
    `${FRAGMENT_PREFIX}${'A'.repeat(33_000)}`, '#card=1', undefined,
    `${FRAGMENT_PREFIX}${Buffer.from([0xff, 0xfe]).toString('base64url')}`,
  ];
  for (const h of bad) assert.equal(decodeFeedback(h), null, String(h).slice(0, 40));
});

const view = (extra, dlg = {}) => feedbackDialog({ kind: 'feedback', payload: decodeFeedback(frag(good)), busy: false, result: null, ...dlg }, model([], { me: { member: { id: 'a', role: 'member' }, org: { name: 'Acme' } }, ...extra }));
const sendBtn = (d) => byAttr(d, 'data-action', 'feedback-send')[0];

test('the dialog shows the exact title and body as text, the team line, and Cancel + Send', () => {
  const d = view();
  assert.equal(textOf(byAttr(d, 'data-feedback', 'title')[0]), 'It broke');
  assert.equal(textOf(byAttr(d, 'data-feedback', 'body')[0]), good.body);
  assert.match(textOf(d), /Everyone on Acme’s board can see this card\./);
  assert.match(textOf(d), /Cancel/);
  assert.equal(textOf(sendBtn(d)), 'Send to the Plexiform feedback board');
  assert.ok(!sendBtn(d).props.disabled);
});

test('a viewer sees the text with Send disabled and a note', () => {
  const d = view({ readOnly: true });
  assert.ok(sendBtn(d).props.disabled);
  assert.ok(textOf(d).includes(VIEWER_TEXT));
});

test('sent shows thanks and a link to the card; a failure shows only the fixed text', () => {
  const ok = view({}, { result: { ok: true, cardId: 'c 1', boardId: 'b1' } });
  assert.ok(textOf(ok).includes(SENT_TEXT));
  assert.equal(sendBtn(ok), undefined);
  assert.ok(JSON.stringify(ok).includes('/?board=b1#card=c%201'));
  assert.ok(textOf(view({}, { result: { ok: false, text: FAILED_TEXT } })).includes(FAILED_TEXT));
});

const boards = [{ id: 'b0', name: 'Main' }, { id: 'b9', name: 'Plexiform feedback' }];
const payload = decodeFeedback(frag(good));

test('Send posts exactly the shown text with labels and the request_id to the feedback board', async () => {
  const calls = [];
  const api = { createCard: async (id, body) => { calls.push([id, body]); return { card: { id: 'c1' } }; } };
  assert.deepEqual(await sendFeedback({ api, boards, payload }), { ok: true, cardId: 'c1', boardId: 'b9' });
  assert.deepEqual(calls, [['b9', { request_id: RID, title: 'It broke', body: good.body, labels: ['feedback', 'bug'] }]]);
});

test('no feedback board: nothing is posted; any failure gives the fixed text, never the hub message', async () => {
  const never = { createCard: async () => { throw new Error('should not be called'); } };
  assert.deepEqual(await sendFeedback({ api: never, boards: [boards[0]], payload }), { ok: false, text: NO_BOARD_TEXT });
  const boom = { createCard: async () => { throw Object.assign(new Error('internal: db path /srv/x'), { code: 'INTERNAL' }); } };
  assert.deepEqual(await sendFeedback({ api: boom, boards, payload }), { ok: false, text: FAILED_TEXT });
  assert.deepEqual(await sendFeedback({ api: { createCard: async () => ({}) }, boards, payload }), { ok: false, text: FAILED_TEXT });
});

test('app.js clears the fragment before it opens the dialog and never auto-sends', () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function takeFeedbackFromHash'), src.indexOf('function openPendingFeedback'));
  assert.ok(fn.indexOf('history.replaceState') < fn.indexOf('openPendingFeedback()'));
  assert.ok(fn.indexOf('history.replaceState') > fn.indexOf('decodeFeedback'));
  assert.ok(!/sendFeedback|submitFeedback/.test(fn));
  assert.match(src, /addEventListener\('hashchange', takeFeedbackFromHash\)/);
});
