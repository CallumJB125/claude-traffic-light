'use strict';
// T4d: "Allow ‹teammate› to send" in my own thread. The real owner-thread actions against a stand-in remote host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Owner = require('../src/thread-owner-main');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SESSION = crypto.randomUUID(), SHARE = crypto.randomUUID(), TEAM = 'team-1';
const BOB = '11111111-1111-4111-8111-111111111111', EVE = '22222222-2222-4222-8222-222222222222';

function rig({ allowOk = true, scope = 'watch', allowed = {} } = {}) {
  let t = 1_000_000;
  const calls = [];
  const share = () => ({ id: SHARE, session: SESSION, team: { id: TEAM, name: 'Design team' }, scope, expiresAt: null, allowOk,
    members: [{ id: BOB, name: 'Bob', acts: true, canSend: Object.hasOwn(allowed, BOB), allowedUntil: allowed[BOB] ?? null }, { id: EVE, name: 'Eve (viewer)', acts: false, canSend: false, allowedUntil: null }] });
  const host = {
    shared: () => [share()],
    async listShares() { return { ok: true, teams: [{ id: TEAM, name: 'Design team' }], shares: [share()] }; },
    async grantAllowance(req) { calls.push(['grant', req]); allowed[req.user] = t + req.seconds * 1000; return { ok: true }; },
    async revokeAllowance(req) { calls.push(['revoke', req]); delete allowed[req.user]; return { ok: true }; },
    connected: () => true,
  };
  const actions = Owner.createOwnerThreadActions({ owner: { target: () => ({ session: SESSION, provider: 'Codex' }), host: () => host, account: () => 'acct' }, now: () => t, timers: { setInterval: () => 0, clearInterval() {} } });
  const c = { contents: { id: 1 }, generation: 1, boundId: 'b'.repeat(64), window: { isVisible: () => true, isMinimized: () => false } };
  const still = () => true;
  return { actions, c, still, calls, advance: (ms) => { t += ms; }, host };
}

test('T4d owner: a watch share lists each acting teammate to allow; a viewer-role member is never offered', async () => {
  const r = rig();
  const v = await r.actions.state(r.c, r.still);
  const s = v.shares[0];
  assert.equal(s.allowNote, '');
  assert.deepEqual(s.allowable.map((m) => m.name), ['Bob']);
  assert.deepEqual(s.allowed, []);
  assert.ok(/^[0-9a-f]{32}$/.test(s.allowable[0].key));
  assert.ok(!JSON.stringify(v).includes(BOB), 'no member id reaches the page');
});

test('T4d owner: review shows the card (who, how long, quota), 600 ms arm, confirm grants once through the host', async () => {
  const r = rig();
  const s = (await r.actions.state(r.c, r.still)).shares[0];
  const rev = await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: s.allowable[0].key, seconds: '1800' }, r.still);
  assert.equal(rev.status, 'review');
  assert.equal(rev.card.title, 'Allow Bob to send');
  assert.match(rev.card.notes.join(' '), /send, steer and stop in this session for 30 min, using your Codex account and quota/);
  assert.match(rev.card.notes.join(' '), /ends when Plexiform quits/);
  assert.equal(rev.card.confirm, 'Allow · 30 min'); assert.equal(rev.card.armMs, 600);
  assert.equal((await r.actions.confirm(r.c, { selection: rev.selection }, r.still)).status, 'not-ready');
  r.advance(700);
  const done = await r.actions.confirm(r.c, { selection: rev.selection }, r.still);
  assert.deepEqual([done.ok, done.status], [true, 'allowed-one']);
  assert.deepEqual(r.calls, [['grant', { share: SHARE, user: BOB, seconds: 1800 }]]);
  assert.equal((await r.actions.confirm(r.c, { selection: rev.selection }, r.still)).status, 'stale', 'one use');
});

test('T4d owner: only 15 min, 30 min, 1 hour and 4 hours; unknown keys and extra fields are refused', async () => {
  const r = rig();
  const s = (await r.actions.state(r.c, r.still)).shares[0], m = s.allowable[0].key;
  for (const seconds of ['60', '7200', '1800.5', '', 'x']) assert.equal((await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: m, seconds }, r.still)).status, 'invalid', seconds);
  assert.equal((await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: m, seconds: '900', extra: '1' }, r.still)).status, 'invalid');
  assert.equal((await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: 'f'.repeat(32), seconds: '900' }, r.still)).status, 'stale');
  for (const seconds of ['900', '1800', '3600', '14400']) assert.equal((await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: m, seconds }, r.still)).status, 'review', seconds);
  assert.deepEqual(r.calls, []);
});

test('T4d owner: a viewer-role member (not acting) cannot be offered even with a forged key; an interact share offers nothing', async () => {
  const r = rig();
  const s = (await r.actions.state(r.c, r.still)).shares[0];
  const eve = crypto.createHmac('sha256', 'x').update('y').digest('hex').slice(0, 32);
  assert.equal((await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: eve, seconds: '900' }, r.still)).status, 'stale');
  const i = rig({ scope: 'interact' });
  const is = (await i.actions.state(i.c, i.still)).shares[0];
  assert.equal(is.allowable, undefined); assert.equal(is.allowed, undefined);
  assert.equal((await i.actions.review(i.c, { op: 'allow-send', share: is.key, member: 'a'.repeat(32), seconds: '900' }, i.still)).status, 'stale');
});

test('T4d owner: an older hub gets main\'s own sentence and no Allow; review refuses', async () => {
  const r = rig({ allowOk: false });
  const s = (await r.actions.state(r.c, r.still)).shares[0];
  assert.equal(s.allowNote, 'Your team hub needs an update before you can allow one teammate to send.');
  assert.deepEqual([s.allowable, s.allowed], [[], []]);
  const rev = await r.actions.review(r.c, { op: 'allow-send', share: s.key, member: 'a'.repeat(32), seconds: '900' }, r.still);
  assert.equal(rev.status, 'unavailable'); assert.match(rev.error, /needs an update/);
});

test('T4d owner: an allowed teammate shows with the time, and Stop allowing is one click through the host', async () => {
  const until = 1_000_000 + 600_000, r = rig({ allowed: { [BOB]: until } });
  const s = (await r.actions.state(r.c, r.still)).shares[0];
  assert.deepEqual([s.allowed.length, s.allowed[0].until, s.allowable.length], [1, until, 0]);
  const out = await r.actions.act(r.c, { op: 'stop-allow', key: s.allowed[0].key }, r.still);
  assert.deepEqual([out.ok, out.status], [true, 'allow-stopped']);
  assert.deepEqual(r.calls, [['revoke', { share: SHARE, user: BOB }]]);
  assert.equal((await r.actions.act(r.c, { op: 'stop-allow', key: 'a'.repeat(32) }, r.still)).status, 'stale');
});

test('T4d wiring: the page and preload carry only keys, the share list sends Propose-free copy, and no hub text is shown', () => {
  const pre = read('thread-preload.js'), page = read('thread-owner.js'), shared = read('thread-shared.js');
  assert.match(pre, /\['op', 'team', 'scope', 'expiry', 'share', 'proposal', 'member', 'seconds'\]/);
  assert.match(page, /review\(\{ op: 'allow-send', share: s\.key, member: m\.key, seconds: sel\.value \}\)/);
  assert.match(page, /act\('stop-allow', a\.key\)/);
  assert.match(page, /Allow \$\{m\.name\} to send · /);
  assert.match(shared, /viaAllowance && o\.op === 'propose'/);
  assert.match(shared, /\$\{h\.owner\} let you send/);
});
