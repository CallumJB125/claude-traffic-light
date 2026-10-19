// Viewing presence (team depth lane C): the avatar stack on a card others are
// looking at, the "running on <repo>" dot and "viewing <card>" line in the
// member list, and the one client frame the socket sends (presence.view).
// Rendered into a real JSDOM document; every name and title is untrusted text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render, textOf, byClass } from '../js/h.js';
import { card, viewersOf } from '../js/render-board.js';
import { teamRows, teamScreen } from '../js/render-team.js';
import { connectBoard } from '../js/socket.js';
import { displayFace } from '../js/view.js';
import { validate } from '../../shared/protocol.js';
import { view, model, ALICE, BOB } from './fixtures.js';

const HOSTILE = '<img src=x onerror="globalThis.pwned=1">';
const CAROL = { member_id: 'm-carol', name: `Carol ${HOSTILE}`, login: 'carol', avatar_url: null };
const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const viewer = (m, cardId, extra = {}) => ({ member_id: m.member_id, name: m.name, card_id: cardId, key: 'BDL-1', title: `Fix login ${HOSTILE}`, at: '2026-10-19T10:00:00Z', ...extra });

function dom(t) {
  const d = new JSDOM('<main></main>');
  const prior = globalThis.document;
  globalThis.document = d.window.document;
  t.after(() => { globalThis.document = prior; d.window.close(); });
  return d.window.document.querySelector('main');
}

test('a card shows one avatar per teammate viewing it, never the viewer\'s own tabs, as text only', (t) => {
  const root = dom(t);
  const v = view({ id: 'c1' });
  const members = new Map([ALICE, BOB, CAROL].map((m) => [m.member_id, m]));
  // Alice (me) in two tabs, Bob twice (two connections), Carol once, plus someone on another card.
  const viewers = [viewer(ALICE, 'c1'), viewer(ALICE, 'c1'), viewer(BOB, 'c1'), viewer(BOB, 'c1'), viewer(CAROL, 'c1'), viewer(BOB, 'c2')];
  // app.js drops this member's own entries before the model reaches render; the renderer de-duplicates per member.
  const m = model([entry(v)], { members, viewers: viewers.filter((x) => x.member_id !== ALICE.member_id) });
  assert.deepEqual(viewersOf('c1', m).map((x) => x.member_id), ['m-bob', 'm-carol']);
  render(root, card(entry(v), m));
  const stack = root.querySelector('.card-viewers');
  assert.ok(stack, 'viewer stack rendered');
  assert.equal(stack.querySelectorAll('.avatar').length, 2);
  assert.equal(stack.querySelector('.avatars').getAttribute('aria-label'), `Viewing now: Bob, Carol ${HOSTILE}`);
  assert.equal(root.querySelector('img'), null, 'hostile names are text');
  assert.equal(globalThis.pwned, undefined);
  // Nobody viewing: no stack at all.
  render(root, card(entry(v), model([entry(v)], { members, viewers: [] })));
  assert.equal(root.querySelector('.card-viewers'), null);
  // The old model shape (no viewers field) still renders.
  render(root, card(entry(v), model([entry(v)], { members })));
  assert.equal(root.querySelector('.card-viewers'), null);
});

test('member list: a "running on <repo>" dot from runner presence and "viewing <card>" from viewers', (t) => {
  const root = dom(t);
  const members = new Map([ALICE, BOB, CAROL].map((m) => [m.member_id, m]));
  const sess = (repo_short, state = 'working') => ({ agent: 'claude', repo_short, branch: 'main', state, since: '2026-10-19T09:00:00Z' });
  const m = model([entry(view({ id: 'c1', key: 'BDL-1' }))], {
    members, nowMs: Date.parse('2026-10-19T10:00:00Z'), view: 'team',
    presence: { members: [{ member_id: 'm-bob', name: 'Bob', sessions: [sess('bondly'), sess('bondly', 'idle'), sess(`api ${HOSTILE}`)], viewing: { card_id: 'c1', since: '2026-10-19T10:00:00Z' } }], loaded: true, stale: false },
    viewers: [viewer(BOB, 'c1'), viewer(CAROL, 'c1', { key: null, title: `Only a title ${HOSTILE}` })],
  });
  const rows = teamRows(m);
  assert.deepEqual(rows.find((r) => r.member_id === 'm-bob').viewing, { card_id: 'c1', key: 'BDL-1', title: `Fix login ${HOSTILE}` });
  assert.deepEqual(rows.find((r) => r.member_id === 'm-carol').viewing, { card_id: 'c1', key: null, title: `Only a title ${HOSTILE}` });
  assert.equal(rows.find((r) => r.member_id === 'm-alice').viewing, null);
  render(root, teamScreen(m));
  const bob = [...root.querySelectorAll('.team-member')].find((el) => el.querySelector('.team-name').textContent.startsWith('Bob'));
  const now = bob.querySelector('.team-now');
  assert.ok(now, 'the now line is rendered');
  assert.ok(now.querySelector('.team-now-dot'), 'running dot');
  assert.equal(now.querySelector('[data-kind="running"]').textContent, `running on bondly, api ${HOSTILE}`, 'each repo once, in order');
  const viewing = now.querySelector('[data-kind="viewing"]');
  assert.equal(viewing.textContent, 'viewing BDL-1');
  assert.equal(viewing.dataset.card, 'c1', 'opens the card');
  assert.equal(viewing.title, `Fix login ${HOSTILE}`);
  const carol = [...root.querySelectorAll('.team-member')].find((el) => el.querySelector('.team-name').textContent.startsWith('Carol'));
  assert.equal(carol.querySelector('[data-kind="running"]'), null, 'no dot without a session');
  assert.equal(carol.querySelector('[data-kind="viewing"]').textContent, `viewing Only a title ${HOSTILE}`, 'falls back to the title');
  assert.equal(root.querySelector('img'), null);
  assert.equal(globalThis.pwned, undefined);
  // Without presence or viewers the line is absent (old payloads).
  render(root, teamScreen(model([], { members, view: 'team', presence: { members: [], loaded: true, stale: false } })));
  assert.equal(root.querySelector('.team-now'), null);
  assert.equal(textOf(teamScreen(model([], { members, view: 'team' }))).includes('running on'), false);
  assert.equal(byClass(teamScreen(m), 'team-now').length, 2, 'Bob and Carol each get one line');
});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  open() { this.onopen?.(); }
  push(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}

test('socket.send: presence.view goes out only on an open, snapshotted socket; board.presence frames validate', () => {
  FakeWS.all = [];
  const messages = [];
  const conn = connectBoard({ boardId: 'b1', url: 'ws://x/ws/board', WebSocketImpl: FakeWS, onStatus: () => {}, onMessage: (m) => messages.push(m), schedule: () => 1, cancel: () => {} });
  const ws = () => FakeWS.all.at(-1);
  assert.equal(conn.send({ type: 'presence.view', card_id: 'c1' }), false, 'nothing before the socket is open');
  ws().open();
  assert.equal(conn.send({ type: 'presence.view', card_id: 'c1' }), false, 'nothing before the first snapshot');
  ws().push({ type: 'snapshot', board_id: 'b1', board: {}, cards: [], members: [] });
  assert.equal(conn.send({ type: 'presence.view', card_id: 'c1' }), true);
  assert.equal(conn.send({ type: 'presence.view', card_id: null }), true);
  assert.deepEqual(ws().sent.slice(2), [{ type: 'presence.view', card_id: 'c1' }, { type: 'presence.view', card_id: null }]);
  for (const f of ws().sent) assert.equal(validate('browser→hub', f), null, 'every frame sent is a valid browser→hub frame');
  // A board.presence push is a known hub→browser frame and reaches the app.
  ws().push({ type: 'board.presence', board_id: 'b1', members: [], viewers: [viewer(BOB, 'c1')] });
  assert.equal(messages.at(-1).type, 'board.presence');
  assert.equal(validate('hub→browser', { type: 'board.presence', board_id: 'b1', members: [] }) !== null, true, 'viewers is required');
  ws().drop();
  assert.equal(conn.send({ type: 'presence.view', card_id: 'c1' }), false, 'nothing on a dropped socket');
  conn.close();
  assert.equal(conn.send({ type: 'presence.view', card_id: null }), false);
});
