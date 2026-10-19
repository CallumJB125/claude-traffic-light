// Person-to-person hand-off on the board (team depth lane D): the card menu
// offers "Hand to…" with a teammate picker and note; the recipient gets a
// banner with Accept / Decline; the sender sees "handed to <name>, waiting"
// and the outcome afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawer, handoffBanner } from '../js/render-drawer.js';
import { dialog } from '../js/render-dialogs.js';
import { textOf, byAttr } from '../js/h.js';
import { view, model } from './fixtures.js';
import { displayFace } from '../js/view.js';

const ho = (extra = {}) => ({ id: 'h1', state: 'requested', from: 'm-bob', to: 'm-alice', from_name: 'Bob', to_name: 'Alice', note: 'Parser is done, tests are not.', created_at: '2026-10-19T10:00:00.000Z', answered_at: null, ...extra });
function render(card, extra = {}) {
  const v = view({ run: null, run_state: null, assignee_ids: ['m-alice', 'm-bob'], ...card });
  const detail = { cardId: v.id, tab: 'overview', elapsed_ms: 0, data: { card: v, feed: [], comments: [], asks: [], permission_requests: [] }, packetLoaded: true };
  return drawer(model([{ view: v, face: displayFace(v), elapsed_ms: 0 }], { detail, ...extra }));
}
const options = (n) => byAttr(n, 'name', 'to_member_id')[0]?.children.map((o) => o.props.value) ?? [];

test('the recipient sees who handed it, the note, and Accept / Decline', () => {
  const n = render({ handoff: ho() });
  const text = textOf(n);
  assert.match(text, /Bob handed this to you/);
  assert.match(text, /Parser is done, tests are not\./);
  assert.equal(byAttr(n, 'data-action', 'handoff-accept').length, 1);
  assert.equal(byAttr(n, 'data-action', 'handoff-decline').length, 1);
  assert.equal(byAttr(n, 'data-action', 'handoff-accept')[0].props['data-handoff'], 'h1');
  assert.equal(byAttr(n, 'data-action', 'hand_to_person').length, 0, 'no second hand-off while one waits');
  assert.equal(byAttr(n, 'data-action', 'handoff-cancel').length, 0);
});

test('the sender sees "handed to <name>, waiting" with Take it back, and the outcome once answered', () => {
  const waiting = render({ handoff: ho({ from: 'm-alice', to: 'm-bob' }) });
  assert.match(textOf(waiting), /Handed to Bob, waiting for their answer\./);
  assert.equal(byAttr(waiting, 'data-action', 'handoff-cancel').length, 1);
  assert.equal(byAttr(waiting, 'data-action', 'handoff-accept').length, 0);
  const accepted = render({ handoff: ho({ from: 'm-alice', to: 'm-bob', state: 'accepted', answered_at: '2026-10-19T10:05:00.000Z' }) });
  assert.match(textOf(accepted), /Bob accepted the hand-off from you\./);
  assert.equal(byAttr(accepted, 'data-action', 'hand_to_person').length, 1, 'an answered hand-off frees the menu again');
  const declined = render({ handoff: ho({ from: 'm-alice', to: 'm-bob', state: 'declined', answered_at: '2026-10-19T10:05:00.000Z' }) });
  assert.match(textOf(declined), /Bob declined the hand-off from you\./);
  assert.equal(handoffBanner(view({ handoff: ho({ state: 'cancelled', answered_at: 'x' }) }), model([])), null);
});

test('a third person sees who holds it and cannot answer; a viewer sees no buttons', () => {
  const n = render({ handoff: ho({ from: 'm-bob', to: 'm-bob', to_name: 'Cara', from_name: 'Dan', from: 'm-dan', to: 'm-cara' }) });
  assert.match(textOf(n), /Dan handed this to Cara, waiting/);
  assert.equal(byAttr(n, 'data-action', 'handoff-accept').length, 0);
  assert.equal(byAttr(n, 'data-action', 'handoff-cancel').length, 0);
  const ro = render({ handoff: ho() }, { readOnly: true });
  assert.equal(byAttr(ro, 'data-action', 'handoff-accept').length, 0);
});

test('"Hand to…" opens a dialog with every teammate but me and a note field', () => {
  const n = render({});
  assert.equal(byAttr(n, 'data-action', 'hand_to_person').length, 1);
  assert.match(textOf(byAttr(n, 'data-action', 'hand_to_person')[0]), /Hand to…/);
  const v = view({ run: null, run_state: null });
  const d = dialog(model([{ view: v, face: displayFace(v), elapsed_ms: 0 }], { dialog: { kind: 'hand-to-person', cardId: v.id } }));
  assert.deepEqual(options(d), ['m-bob']);
  assert.equal(byAttr(d, 'name', 'note').length, 1);
  assert.equal(byAttr(d, 'data-form', 'hand-to-person').length, 1);
  assert.match(textOf(d), /Hand BDL-1 to…/);
});
