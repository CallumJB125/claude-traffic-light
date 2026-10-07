'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const C = require('../src/collision-alerts');
const SessionOverview = require('../src/session-overview');

const MINE = 'inst-a:claude:sess-1', THEIRS = 'inst-b:codex:sess-9', ALSO_MINE = 'inst-a:codex:sess-2';
const rows = [{ sessionId: 'sess-1', cwd: '/x/app', updatedAt: new Date().toISOString(), signal: 'tool-use' }, { sessionId: 'sess-2', source: 'codex', cwd: '/x/app', updatedAt: new Date().toISOString() }];
const mine = C.mineFrom(rows);
const ev = (over = {}) => ({ type: 'collision', repo_id: 'repo-1', path: 'src/auth.js', records: [{ record_id: THEIRS, title: 'Fix login', author: 'James' }, MINE], seq: 7, ...over });

test('a collision with one of my sessions notifies once and marks that session', () => {
  const alerts = C.createCollisions();
  const r = alerts.handle(ev(), mine);
  assert.equal(r.notify, true); assert.equal(r.changed, true);
  assert.equal(r.collision.mine.record_id, MINE); assert.equal(r.collision.other.record_id, THEIRS);
  assert.equal(C.text(r.collision), "James's session (Fix login) is also editing auth.js");
  assert.equal(alerts.handle(ev({ seq: 8 }), mine).notify, false, 'one notification per collision');
  assert.deepEqual(alerts.forSession('claude', 'sess-1').map((x) => x.other), [THEIRS]);
  assert.deepEqual(alerts.forSession('codex', 'sess-1'), [], 'adapter must match');
});

test('collisions not involving me, malformed events and unsafe paths are ignored', () => {
  const alerts = C.createCollisions();
  assert.equal(alerts.handle(ev({ records: [THEIRS, 'inst-c:gemini:s'] }), mine).changed, false);
  for (const bad of [null, {}, { type: 'collision' }, ev({ path: '/etc/passwd' }), ev({ path: '../x' }), ev({ records: [MINE] }), ev({ records: [MINE, MINE] }), ev({ records: [MINE, 'nope'] }), ev({ repo_id: 'a b' })]) {
    assert.equal(alerts.handle(bad, mine).changed, false);
  }
  assert.equal(alerts.list().length, 0);
});

test('two of my own sessions colliding marks both, each pointing at the other', () => {
  const alerts = C.createCollisions();
  const r = alerts.handle(ev({ records: [MINE, ALSO_MINE] }), mine);
  assert.equal(r.collision.both_mine, true);
  assert.match(C.text(r.collision), /^Another of your sessions/);
  assert.deepEqual(alerts.forSession('claude', 'sess-1').map((x) => x.other), [ALSO_MINE]);
  assert.deepEqual(alerts.forSession('codex', 'sess-2').map((x) => x.other), [MINE]);
});

test('record.end clears the collision and lets a new one notify again', () => {
  const alerts = C.createCollisions();
  alerts.handle(ev(), mine);
  assert.equal(alerts.handle({ type: 'record.end', record_id: THEIRS }, mine).changed, true);
  assert.deepEqual(alerts.forSession('claude', 'sess-1'), []);
  assert.equal(alerts.handle(ev(), mine).notify, true);
});

test('the board link names only the other record and repo', () => {
  const alerts = C.createCollisions();
  const { collision } = alerts.handle(ev(), mine);
  const [k, v] = C.fragment(collision).split('=');
  assert.equal(k, 'plexiform-record');
  assert.deepEqual(JSON.parse(Buffer.from(v, 'base64url').toString()), { v: 1, record_id: THEIRS, repo_id: 'repo-1' });
});

test('attach subscribes to a fake activity stream (emitter or subscribe shape)', () => {
  const seen = [];
  const emitter = new EventEmitter();
  const off = C.attach(emitter, (e) => seen.push(e));
  emitter.emit('event', ev()); off(); emitter.emit('event', ev());
  assert.equal(seen.length, 1);
  let fn = null;
  assert.equal(typeof C.attach({ subscribe: (f) => { fn = f; } }, (e) => seen.push(e)), 'function');
  fn(ev()); assert.equal(seen.length, 2);
  assert.equal(C.attach({}, () => {}), null);
});

test('Sessions and Home rows carry the collision for that session only', () => {
  const alerts = C.createCollisions();
  alerts.handle(ev(), mine);
  const snap = SessionOverview.snapshot({ sessions: rows, collisions: C.rowCollisions(alerts) });
  const claude = snap.sessions.find((s) => s.provider !== 'Codex');
  const codex = snap.sessions.find((s) => s.provider === 'Codex');
  assert.equal(claude.collisions.length, 1);
  assert.equal(claude.collisions[0].other, THEIRS);
  assert.equal(codex.collisions, undefined);
  const { running } = require('../src/home-main');
  const home = running(rows, Date.now(), C.rowCollisions(alerts));
  assert.match(home.items.find((i) => i.collision)?.collision ?? '', /also editing auth\.js/);
});
