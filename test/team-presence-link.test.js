'use strict';
// Board presence link (team depth lane C): one /ws/board socket per linked team
// board with the person's own bearer, board.presence kept per board and merged
// per team, presence.view beats every BEAT_MS while a card is open, cleared on
// close, nothing after stop(). Fake socket and fake timers throughout.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPresenceLink, reduce, BEAT_MS } = require('../src/team-presence-link');

class FakeWS extends EventEmitter {
  static all = [];
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.closed = null; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closed = code; }
  frames(type) { return this.sent.filter((f) => f.type === type); }
}

function timers() {
  let now = 1_000_000; const queue = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn, unref() {} }; queue.push(t); return t; },
    clearTimeout: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
    advance(ms) { const end = now + ms; for (;;) { const due = queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; queue.splice(queue.indexOf(due), 1); now = due.at; due.fn(); } now = end; },
    pending: () => queue.length,
  };
}

const route = (over = {}) => ({ repo: 'github.com/acme/app', route: { hub: 'https://hub.example', team_id: 'team-1', board_id: 'board-1', ...over }, token: () => 'bdt_secret' });
const push = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
const open = (ws) => { ws.emit('open'); push(ws, { type: 'welcome', protocol: 1 }); push(ws, { type: 'snapshot', board_id: ws.sent[1].board_id, board: {}, cards: [], members: [] }); };

test('one socket per linked board, bearer and team headers, hello then subscribe; latest() merges a team\'s boards', async () => {
  FakeWS.all = [];
  const t = timers(); let changes = 0;
  const links = [route(), route({ board_id: 'board-2' }), route({ team_id: 'team-2', board_id: 'board-9' }), { route: { hub: 'ftp://nope', team_id: 'x', board_id: 'y' } }, null];
  const link = createPresenceLink({ links: async () => links, WebSocket: FakeWS, ...t, onChange: () => changes++ });
  await link.refresh();
  assert.equal(FakeWS.all.length, 3, 'only http(s) routes with team and board');
  assert.equal(FakeWS.all[0].url, 'wss://hub.example/ws/board');
  assert.equal(FakeWS.all[0].opts.headers.Authorization, 'Bearer bdt_secret');
  assert.equal(FakeWS.all[0].opts.headers['X-Board-Team'], 'team-1');
  assert.equal(FakeWS.all[0].sent.length, 0, 'nothing before open');
  for (const ws of FakeWS.all) open(ws);
  assert.deepEqual(FakeWS.all[0].sent, [{ type: 'hello', protocol: 1 }, { type: 'subscribe', board_id: 'board-1' }]);
  assert.equal(link.latest('team-1'), null, 'no presence yet');
  push(FakeWS.all[0], { type: 'board.presence', board_id: 'board-1', members: [{ member_id: 'm-bob', name: 'Bob', sessions: [{ agent: 'claude', repo_short: 'app', state: 'working', since: 'x' }], viewing: { card_id: 'c1', since: 's' } }], viewers: [{ member_id: 'm-bob', name: 'Bob', card_id: 'c1', key: 'K-1', title: 'One', at: 'a' }] });
  push(FakeWS.all[0], { type: 'board.presence', board_id: 'other-board', members: [{ member_id: 'm-x', name: 'X', sessions: [] }], viewers: [] });
  push(FakeWS.all[1], { type: 'board.presence', board_id: 'board-2', members: [{ member_id: 'm-bob', name: 'Bob', sessions: [{ agent: 'codex', repo_short: 'docs', state: 'idle', since: 'x' }] }, { member_id: 'm-cara', name: 'Cara', sessions: [] }], viewers: [] });
  push(FakeWS.all[2], { type: 'board.presence', board_id: 'board-9', members: [{ member_id: 'm-eve', name: 'Eve', sessions: [] }], viewers: [] });
  assert.equal(changes, 3, 'one change per accepted frame; another board\'s frame is ignored');
  const l = link.latest('team-1');
  assert.deepEqual(l.members.map((m) => m.member_id).sort(), ['m-bob', 'm-cara']);
  const bob = l.members.find((m) => m.member_id === 'm-bob');
  assert.deepEqual(bob.sessions.map((s) => s.repo_short), ['app', 'docs'], 'sessions merged over the team\'s boards');
  assert.deepEqual(bob.viewing, { card_id: 'c1', since: 's' });
  assert.deepEqual(l.viewers, [{ member_id: 'm-bob', name: 'Bob', card_id: 'c1', key: 'K-1', title: 'One', at: 'a' }]);
  assert.equal(JSON.stringify(l).includes('m-x'), false);
  assert.deepEqual(link.latest('team-2').members.map((m) => m.name), ['Eve']);
  assert.equal(link.latest('team-3'), null);
  // team.presence alone (an older hub) still yields members with no viewers.
  push(FakeWS.all[2], { type: 'team.presence', members: [{ member_id: 'm-eve', name: 'Eve2', sessions: [] }] });
  assert.equal(link.latest('team-2').members[0].name, 'Eve', 'team.presence does not override a board.presence already held');
  // A route that disappears closes its socket and forgets its presence.
  links.splice(2, 1);
  await link.refresh();
  assert.equal(FakeWS.all[2].closed, 1000);
  assert.equal(link.latest('team-2'), null);
  assert.equal(link.size(), 2);
  link.stop();
  assert.equal(FakeWS.all[0].closed, 1000);
  assert.equal(link.latest('team-1'), null);
});

test('view(): presence.view at once, a beat every BEAT_MS while set, null clears and stops the beats; re-sent after a reconnect snapshot', async () => {
  FakeWS.all = [];
  const t = timers(); let changes = 0;
  const link = createPresenceLink({ links: async () => [route(), route({ board_id: 'board-2' }), route({ team_id: 'team-2', board_id: 'b9' })], WebSocket: FakeWS, ...t, onChange: () => changes++ });
  await link.refresh();
  const [a, b, other] = FakeWS.all;
  open(a); open(b); open(other);
  assert.equal(link.view({ team: 'team-1', card_id: 'card-7' }), 2, 'both of the team\'s boards');
  assert.deepEqual(a.frames('presence.view'), [{ type: 'presence.view', card_id: 'card-7' }]);
  assert.deepEqual(b.frames('presence.view'), [{ type: 'presence.view', card_id: 'card-7' }]);
  assert.equal(other.frames('presence.view').length, 0, 'another team hears nothing');
  assert.equal(link.view({ team: 'team-1', card_id: 'card-7' }), 0, 'same card: nothing new');
  t.advance(BEAT_MS - 1);
  assert.equal(a.frames('presence.view').length, 1);
  t.advance(1);
  assert.equal(a.frames('presence.view').length, 2, 'a beat at BEAT_MS');
  t.advance(BEAT_MS * 3);
  assert.equal(a.frames('presence.view').length, 5, 'and every BEAT_MS after');
  assert.equal(BEAT_MS, 20_000, 'the module constant from src/session-presence.js');
  // A reconnect: the new socket announces the card again after its snapshot.
  a.emit('close');
  assert.equal(FakeWS.all.length, 3, 'reconnect waits for the backoff');
  t.advance(5_000);
  assert.equal(FakeWS.all.length, 4);
  const a2 = FakeWS.all[3];
  assert.equal(a2.frames('presence.view').length, 0);
  open(a2);
  assert.deepEqual(a2.frames('presence.view'), [{ type: 'presence.view', card_id: 'card-7' }]);
  // Clearing.
  assert.equal(link.view({ team: 'team-1', card_id: null }), 2);
  assert.deepEqual(a2.frames('presence.view').at(-1), { type: 'presence.view', card_id: null });
  const n = a2.frames('presence.view').length;
  t.advance(BEAT_MS * 2);
  assert.equal(a2.frames('presence.view').length, n, 'no beats once cleared');
  assert.equal(link.view({ team: 'team-1', card_id: null }), 2, 'a repeated clear is sent (cheap, idempotent on the hub)');
  link.stop();
  assert.equal(t.pending(), 0, 'no timers left after stop');
  t.advance(BEAT_MS * 5);
  assert.equal(FakeWS.all.length, 4, 'no reconnects after stop');
});

test('a missing token or a throwing constructor just backs off; frames are reduced to the fields the page needs', async () => {
  FakeWS.all = [];
  const t = timers();
  class Boom { constructor() { throw new Error('no network'); } }
  const link = createPresenceLink({ links: async () => [{ ...route(), token: () => { throw new Error('vault locked'); } }], WebSocket: Boom, ...t });
  await link.refresh();
  assert.equal(link.size(), 1);
  assert.equal(t.pending(), 1, 'a reconnect is scheduled, nothing thrown');
  link.stop();
  const r = reduce({ members: [{ member_id: 'm', name: 'N', sessions: [{ agent: 'claude', repo_short: 'r', branch: 'b', state: 'working', since: 'x', summary: 'SECRET summary' }], viewing: { card_id: 'c', since: 's', extra: 1 } }, 'junk', { name: 'no id' }], viewers: [{ member_id: 'm', name: 'N', card_id: 'c', key: 'K', title: 'T', at: 'a', extra: 2 }, { member_id: 'm' }] });
  assert.deepEqual(r, { members: [{ member_id: 'm', name: 'N', sessions: [{ agent: 'claude', repo_short: 'r', branch: 'b', state: 'working' }], viewing: { card_id: 'c', since: 's' } }], viewers: [{ member_id: 'm', name: 'N', card_id: 'c', key: 'K', title: 'T', at: 'a' }] });
  assert.equal(JSON.stringify(r).includes('SECRET'), false, 'summaries never reach the page');
});

test('E3: an inbox.item pushed down the presence socket reaches the badge count at once, with no timer and no poll', async () => {
  FakeWS.all = [];
  const t = timers();
  const { createTeamInbox } = require('../src/team-inbox');
  const inbox = createTeamInbox({ now: t.now });
  const seen = [];
  const link = createPresenceLink({ links: async () => [route()], WebSocket: FakeWS, ...t, onInbox: (hub, item) => { seen.push(hub); inbox.ingest(hub, [item]); } });
  await link.refresh();
  const [ws] = FakeWS.all;
  open(ws);
  assert.equal(inbox.unread(), 0);
  const before = t.pending();
  push(ws, { type: 'inbox.item', item: { id: 'i1', org_id: 'o', kind: 'mention', ref: { by_name: 'Ana', title: 'Fix login' }, created_at: new Date(t.now()).toISOString(), read_at: null } });
  assert.equal(inbox.unread(), 1, 'badge count rose on the frame itself');
  assert.deepEqual(seen, ['https://hub.example'], 'tagged with the socket\'s hub origin, not anything in the frame');
  assert.equal(t.pending(), before, 'no timer was armed or needed');
  assert.equal(inbox.items()[0].title, 'Ana mentioned you: Fix login');
  // Malformed frames never reach the inbox; a repeat of the same id is not a second row.
  push(ws, { type: 'inbox.item', item: { kind: 'mention' } });
  push(ws, { type: 'inbox.item', item: 'nope' });
  push(ws, { type: 'inbox.item', item: { id: 'i1', kind: 'mention', ref: {} } });
  assert.equal(seen.length, 2);
  assert.equal(inbox.unread(), 1);
  // The poll later reconciling read_at for the same key drops it from the badge.
  inbox.ingest('https://hub.example', [{ id: 'i1', kind: 'mention', ref: {}, created_at: 'x', read_at: '2026-10-19T12:00:00Z' }]);
  assert.equal(inbox.unread(), 0);
  link.stop();
});
