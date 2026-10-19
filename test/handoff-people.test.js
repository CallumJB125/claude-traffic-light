'use strict';
// A teammate hands you a card on the team board (src/handoff-people.js): it
// waits on Sessions as a "Needs you" card of kind person; Accept answers the
// hub and reads the handover packet; Decline answers. The sender's card shows
// "handed to <name>, waiting" in Overview. Only ids, names and the note travel.
const test = require('node:test');
const assert = require('node:assert/strict');
const People = require('../src/handoff-people.js');

const ho = (extra = {}) => ({ id: 'h1', state: 'requested', from: 'm-bob', to: 'm-alice', from_name: 'Bob', to_name: 'Alice', note: 'Tests are left', ...extra });
const card = (extra = {}) => ({ id: 'c1', key: 'DEV-7', title: 'Fix login', handoff: ho(), ...extra });

function hub({ cards: given = [card()], me = 'm-alice', packet = { version: 2, data: { brief: 'Finish the login fix', summary: 'Parser done', paths: ['src/a.js'] } } } = {}) {
  const cards = typeof given === 'function' ? given : () => given;
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, json) => ({ status, json: async () => json });
    if (url.endsWith('/api/me')) return reply(200, { member: { id: me } });
    if (/\/api\/boards\/b1$/.test(url)) return reply(200, { cards: cards(), members: [] });
    if (/\/handoffs\/h1\/(accept|decline)$/.test(url)) { const h = cards()[0].handoff; if (h.state !== 'requested') return reply(409, { error: { message: 'answered' } }); h.state = url.endsWith('accept') ? 'accepted' : 'declined'; return reply(200, { handoff: h, card: cards()[0] }); }
    if (/\/api\/cards\/c1\/packet$/.test(url)) return reply(200, { packet });
    return reply(404, {});
  };
  const links = async () => [{ route: { hub: 'https://hub.test', board_id: 'b1', team_id: 't1', user_id: 'u1' }, token: () => 'tok' }];
  return { calls, fetch, links };
}
const rig = (over = {}) => {
  let t = 1_000_000;
  const notes = [], changes = [];
  const h = hub(over.hub);
  const p = People.create({ links: h.links, fetch: h.fetch, now: () => t, onChange: () => changes.push(1), notify: (r) => notes.push(r), ...over.create });
  return { p, h, notes, changes, tick: (ms) => { t += ms; } };
};

test('personHandoffs: the card payload becomes a directory handoff row as the viewer sees it', () => {
  assert.deepEqual(People.personHandoffs(card(), 'm-bob'), [{ direction: 'out', with: 'Alice', state: 'offered', summary: 'Tests are left' }]);
  assert.deepEqual(People.personHandoffs(card(), 'm-alice'), [{ direction: 'in', with: 'Bob', state: 'offered', summary: 'Tests are left' }]);
  assert.deepEqual(People.personHandoffs(card(), 'm-cara'), [{ direction: 'out', with: 'Alice', state: 'offered', summary: 'Tests are left' }]);
  assert.deepEqual(People.personHandoffs(card({ handoff: ho({ state: 'accepted', note: null }) }), 'm-bob'), [{ direction: 'out', with: 'Alice', state: 'accepted', summary: '' }]);
  assert.deepEqual(People.personHandoffs(card({ handoff: ho({ state: 'cancelled' }) }), 'm-bob'), []);
  assert.deepEqual(People.personHandoffs(card({ handoff: null }), 'm-bob'), []);
  assert.deepEqual(People.personHandoffs(null, 'm-bob'), []);
  assert.equal(People.personHandoffs(card({ handoff: ho({ to_name: `<img> ${'x'.repeat(200)}` }) }), 'm-bob')[0].with.length, 80);
});

test('refresh lists a card handed to me as a pending person hand-off and notifies once; nothing of this computer goes up', async () => {
  const { p, h, notes, changes } = rig();
  assert.equal(await p.refresh({ force: true }), true);
  const [item] = p.list();
  assert.equal(item.kind, 'person'); assert.equal(item.state, 'pending'); assert.equal(item.direction, 'in');
  assert.equal(item.from, 'Bob'); assert.equal(item.reason, 'Tests are left'); assert.deepEqual(item.card, { id: 'c1', key: 'DEV-7', title: 'Fix login' });
  assert.equal(p.pending(), 1);
  assert.equal(notes.length, 1); assert.equal(changes.length, 1);
  assert.deepEqual(h.calls.map((c) => c.method + ' ' + c.url), ['GET https://hub.test/api/me', 'GET https://hub.test/api/boards/b1']);
  for (const c of h.calls) { assert.equal(c.headers.authorization, 'Bearer tok'); assert.equal(c.headers['x-board-team'], 't1'); assert.equal(c.body, null); }
  await p.refresh({ force: true });
  assert.equal(notes.length, 1, 'no second notification for the same hand-off'); assert.equal(p.list().length, 1);
  assert.equal(await p.refresh(), false, 'throttled without force');
});

test('accept answers the hub, then reads the packet and shows it on the card; a second answer is refused', async () => {
  const { p, h } = rig();
  await p.refresh({ force: true });
  const r = await p.accept('h1');
  assert.equal(r.ok, true, r.error); assert.equal(r.state, 'accepted');
  assert.match(r.packet, /Goal: Finish the login fix/); assert.match(r.packet, /Summary: Parser done/); assert.match(r.packet, /Paths: src\/a\.js/); assert.match(r.packet, /Packet version 2/);
  const posts = h.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].url, 'https://hub.test/api/cards/c1/handoffs/h1/accept'); assert.match(posts[0].body.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(h.calls.at(-1).url, 'https://hub.test/api/cards/c1/packet');
  assert.equal(p.list()[0].note, r.packet); assert.equal(p.list()[0].state, 'accepted'); assert.equal(p.pending(), 0);
  assert.equal((await p.accept('h1')).ok, false); assert.equal((await p.decline('h1')).ok, false);
});

test('decline answers the hub and keeps no packet; the sender side cannot answer; a hub 409 ends the wait', async () => {
  const { p, h } = rig();
  await p.refresh({ force: true });
  const r = await p.decline('h1');
  assert.equal(r.ok, true); assert.equal(r.state, 'declined'); assert.equal(r.packet, null);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/packet')).length, 0);

  const sender = rig({ hub: { me: 'm-bob' } });
  await sender.p.refresh({ force: true });
  assert.equal(sender.p.list()[0].direction, 'out'); assert.equal(sender.p.pending(), 0);
  assert.match((await sender.p.accept('h1')).error, /Only the person it was handed to/);

  const stale = rig();
  await stale.p.refresh({ force: true });
  stale.h.calls.length = 0;
  const cards = [card({ handoff: ho({ state: 'accepted' }) })];
  const late = rig({ hub: { cards: () => cards } });
  cards[0].handoff.state = 'requested';
  await late.p.refresh({ force: true });
  cards[0].handoff.state = 'accepted';
  const res = await late.p.accept('h1');
  assert.equal(res.ok, false); assert.match(res.error, /already answered/); assert.equal(late.p.list()[0].state, 'cancelled');
});

test('a request that disappears from the board stops waiting; answered cards leave the list after a while; unreachable hubs are quiet', async () => {
  const cards = [card()];
  const { p, tick } = rig({ hub: { cards: () => cards } });
  await p.refresh({ force: true });
  cards.length = 0;
  await p.refresh({ force: true });
  assert.equal(p.list()[0].state, 'cancelled');
  tick(People.LIMITS.keepDoneMs + 1);
  assert.deepEqual(p.list(), []);
  const logs = [];
  const q = People.create({ links: async () => [{ route: { hub: 'https://down.test', board_id: 'b1' }, token: () => 'tok' }], fetch: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, log: (m) => logs.push(m) });
  assert.equal(await q.refresh({ force: true }), false); assert.deepEqual(q.list(), []); assert.match(logs[0], /refresh failed ECONNREFUSED/);
  const noToken = People.create({ links: async () => [{ route: { hub: 'https://hub.test', board_id: 'b1' }, token: () => null }], fetch: async () => { throw new Error('must not be called'); } });
  assert.equal(await noToken.refresh({ force: true }), false);
});

test('packetText is bounded and survives odd shapes', () => {
  assert.equal(People.packetText(null), 'No handover packet has been written for this card yet.');
  assert.equal(People.packetText({ data: {} }), 'The packet has no text sections yet.');
  assert.ok(People.packetText({ data: { summary: 'y'.repeat(10_000), decisions: ['a', 1, 'b'] } }).length <= People.LIMITS.packet);
  assert.match(People.packetText({ data: { decisions: ['a', 1, 'b'] } }), /Decisions: a; b/);
});
