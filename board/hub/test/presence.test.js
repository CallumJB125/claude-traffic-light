// Team presence (D37b): in memory, per device, TTL after the last frame,
// default deny on board-linked repos, never journaled; browsers of a board see
// only their org's sessions in that board's repos, over WS and HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PRESENCE_TTL_MS, PRESENCE_MIN_MS, PRESENCE_PUSH_MS } from '../../shared/liveness.js';
import { DEFAULT_LIMITS } from '../ratelimit.js';
import { startHub, settle } from './helpers.js';

const sess = (over = {}) => ({ session_id: 'h-1', agent: 'claude', repo_id: 'x', branch: 'feat/a', state: 'working', since: '2026-09-30T10:00:00Z', summary: 'editing the parser', ...over });
const latest = (b) => b.all('team.presence').at(-1);

async function setup(opts) {
  const h = await startHub(opts);
  const alice = await h.login('alice');
  const r = await h.runner(await h.enroll(alice));
  const b = await h.browser(alice);
  return { h, alice, r, b };
}

test('presence: board-linked repos only, exact browser shape, same view over HTTP, never journaled', async () => {
  const { h, alice, r, b } = await setup();
  try {
    assert.deepEqual((await b.next('team.presence')).members, [], 'a subscriber gets the (empty) view right after its snapshot');
    const journal0 = h.db.get('SELECT COUNT(*) AS n FROM journal').n;
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo }), sess({ session_id: 'h-2', repo_id: 'repo-not-on-any-board', summary: 'secret project' })] });
    const { __taken, ...f } = await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    assert.deepEqual(f, { type: 'team.presence', members: [{ member_id: h.ids.alice, name: 'Alice', sessions: [{ agent: 'claude', repo_short: 'app', branch: 'feat/a', state: 'working', since: '2026-09-30T10:00:00Z', summary: 'editing the parser' }] }] });
    const http = await h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`);
    assert.equal(http.status, 200);
    assert.deepEqual(http.body, { members: f.members });
    assert.equal(JSON.stringify(f).includes('secret project'), false);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM journal').n, journal0, 'presence is never journaled');

    // A board of the same org that doesn't link the repo shows nothing.
    h.db.insert('boards', { id: 'b2', org_id: h.ids.org, name: 'Other', key_prefix: 'OTH' });
    const b2 = await h.browser(alice, 'b2');
    assert.deepEqual((await b2.next('team.presence')).members, []);
    assert.deepEqual((await h.api(alice, 'GET', '/api/boards/b2/presence')).body, { members: [] });
  } finally {
    await h.destroy();
  }
});

test('presence: enabled:false (an empty frame) clears at once; a disconnect keeps it until the TTL', async () => {
  const { h, alice, r, b } = await setup();
  try {
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    r.send({ type: 'presence', sessions: [] });
    await settle(50);
    assert.deepEqual((await h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`)).body.members, [], 'the hub forgets at once');
    const cleared = b.next('team.presence', (m) => m.members.length === 0, { fresh: true });
    await h.tick(PRESENCE_PUSH_MS);   // the push itself is coalesced (≤ 1/s/board)
    await cleared;

    await h.tick(PRESENCE_MIN_MS);
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo, state: 'waiting' })] });
    await b.next('team.presence', (m) => m.members[0]?.sessions[0]?.state === 'waiting', { fresh: true });
    r.terminate();
    await settle(50);
    await h.tick(PRESENCE_TTL_MS - 1000);
    await settle(50);
    assert.equal(latest(b).members.length, 1, 'still shown before the TTL');
    const gone = b.next('team.presence', (m) => m.members.length === 0, { fresh: true });
    await h.tick(2000);
    await gone;
  } finally {
    await h.destroy();
  }
});

test('presence: a live runner that stops sending expires after the TTL; a keepalive refreshes it', async () => {
  const { h, r, b } = await setup();
  try {
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    await h.tick(PRESENCE_TTL_MS - 1000);
    const n = b.all('team.presence').length;
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await settle(50);
    assert.equal(b.all('team.presence').length, n, 'an unchanged keepalive pushes nothing');
    await h.tick(2000);
    await settle(50);
    assert.equal(latest(b).members.length, 1, 'the keepalive restarted the TTL');
    const gone = b.next('team.presence', (m) => m.members.length === 0, { fresh: true });
    await h.tick(PRESENCE_TTL_MS);
    await gone;
  } finally {
    await h.destroy();
  }
});

test('presence: org B never sees org A (WS, HTTP) and cannot publish into org A repos', async () => {
  const { h, alice, r, b } = await setup();
  try {
    const now = new Date().toISOString();
    h.db.insert('orgs', { id: 'o2', name: 'other', created_at: now });
    h.db.insert('members', { id: 'm-eve', org_id: 'o2', github_id: 99, github_login: 'eve', email: 'eve@x.io', display_name: 'Eve', role: 'owner', created_at: now });
    h.db.insert('boards', { id: 'b-eve', org_id: 'o2', name: 'Eve', key_prefix: 'EVE' });
    h.db.insert('repos', { id: 'repo-eve', org_id: 'o2', canonical_url: 'github.com/eve/app', short_name: 'eveapp' });
    h.db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', 'b-eve', 'repo-eve');
    const eve = await h.login('eve');
    const re = await h.runner(await h.enroll(eve), { advertise: false });
    const be = await h.browser(eve, 'b-eve');

    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo, summary: 'alice work' })] });
    await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    // Eve names alice's repo id: not on her org's boards → dropped.
    re.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo, summary: 'eve spoof' }), sess({ session_id: 'e-2', repo_id: 'repo-eve', summary: 'eve work' })] });
    await be.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    await settle(50);

    assert.deepEqual(latest(be).members.map((m) => m.name), ['Eve']);
    assert.deepEqual(latest(be).members[0].sessions.map((s) => s.summary), ['eve work']);
    assert.ok(!JSON.stringify(be.all('team.presence')).includes('alice work'));
    assert.deepEqual(latest(b).members.map((m) => m.name), ['Alice']);
    assert.ok(!JSON.stringify(b.all('team.presence')).includes('eve'));

    assert.equal((await h.api(eve, 'GET', `/api/boards/${h.ids.board}/presence`)).status, 404);
    assert.equal((await h.api(alice, 'GET', '/api/boards/b-eve/presence')).status, 404);
    assert.deepEqual((await h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`)).body.members.map((m) => m.name), ['Alice']);
  } finally {
    await h.destroy();
  }
});

test('presence: GET is rate limited per member (429 + Retry-After)', async () => {
  const { h, alice } = await setup({ config: { rateLimits: { ...DEFAULT_LIMITS, presence_member: { capacity: 2, per_ms: 60_000 } } } });
  try {
    const get = () => h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`);
    assert.equal((await get()).status, 200);
    assert.equal((await get()).status, 200);
    const r = await get();
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'RATE_LIMITED');
    assert.equal(r.headers.get('retry-after'), '30');
    const bob = await h.login('bob');
    assert.equal((await h.api(bob, 'GET', `/api/boards/${h.ids.board}/presence`)).status, 200, 'per member');
    await h.tick(30_000);
    assert.equal((await get()).status, 200, 'refills with time');
  } finally {
    await h.destroy();
  }
});

test('presence: malformed frames are refused (agent, state, summary over 120, no repo, since not ISO-8601 ≤ 40)', async () => {
  const { h, r, b } = await setup();
  try {
    const badSince = [1_790_000_000_000, '1790000000000', '2026-09-30', '2026-09-30T10:00:00', `2026-09-30T10:00:00.${'1'.repeat(30)}Z`, null].map((since) => sess({ repo_id: h.ids.repo, since }));
    for (const bad of [sess({ repo_id: h.ids.repo, agent: 'bogus' }), sess({ repo_id: h.ids.repo, state: 'busy' }), sess({ repo_id: h.ids.repo, summary: 'x'.repeat(121) }), { ...sess(), repo_id: undefined }, ...badSince]) {
      const id = randomUUID();
      r.send({ type: 'presence', id, sessions: [bad] });
      const e = await r.next('error', (m) => m.re === id);
      assert.equal(e.code, 'VALIDATION');
    }
    await settle(50);
    assert.deepEqual(latest(b).members, []);
  } finally {
    await h.destroy();
  }
});

test('presence flood: 500 alternating frames → a bounded number of pushes; the last accepted state always goes out', async () => {
  const { h, alice, r, b } = await setup();
  try {
    await b.next('team.presence');
    const before = b.all('team.presence').length;
    const frame = (i) => ({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo, state: i % 2 ? 'working' : 'idle' })] });
    for (let i = 0; i < 500; i++) r.send(frame(i));
    await settle(300);
    assert.ok(b.all('team.presence').length - before <= 1, 'same instant: one frame accepted, one push');

    // Spread over 5 s of hub time with the reaper running: still ≤ 1 accepted frame per PRESENCE_MIN_MS/2.
    const n0 = b.all('team.presence').length;
    for (let i = 0; i < 500; i++) {
      r.send(frame(i));
      if (i % 10 === 9) { await settle(2); await h.tick(100); }
    }
    await settle(100);
    await h.tick(PRESENCE_PUSH_MS);
    await settle(50);
    const pushes = b.all('team.presence').length - n0;
    assert.ok(pushes <= Math.ceil(5000 / (PRESENCE_MIN_MS / 2)) + 1, `bounded pushes (${pushes})`);
    const shown = (await h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`)).body.members;
    assert.deepEqual(latest(b).members, shown, 'browsers end on the hub\'s current view');

    // An empty frame is never throttled.
    r.send({ type: 'presence', sessions: [] });
    await settle(50);
    assert.deepEqual((await h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`)).body.members, []);
  } finally {
    await h.destroy();
  }
});

test('presence pushes: ≤ 1 per board per second, trailing edge carries the last state; other orgs\' boards are not recomputed', async () => {
  const { h, alice, r, b } = await setup();
  try {
    await b.next('team.presence');
    const r2 = await h.runner(await h.enroll(alice));
    const n0 = b.all('team.presence').length;
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    const views = [];
    const view = h.hub.presence.view.bind(h.hub.presence);
    h.hub.presence.view = (id) => { views.push(id); return view(id); };
    r2.send({ type: 'presence', sessions: [sess({ session_id: 'h-9', repo_id: h.ids.repo, state: 'idle' })] });
    await settle(100);
    assert.equal(b.all('team.presence').length - n0, 1, 'held back inside the push interval');
    const trailing = b.next('team.presence', (m) => m.members[0]?.sessions.length === 2, { fresh: true });
    await h.tick(PRESENCE_PUSH_MS);
    await trailing;
    assert.equal(b.all('team.presence').length - n0, 2);

    // A frame from another org marks only that org's boards.
    const now = new Date().toISOString();
    h.db.insert('orgs', { id: 'o2', name: 'other', created_at: now });
    h.db.insert('members', { id: 'm-eve', org_id: 'o2', github_id: 99, github_login: 'eve', email: 'eve@x.io', display_name: 'Eve', role: 'owner', created_at: now });
    const eve = await h.login('eve');
    const re = await h.runner(await h.enroll(eve), { advertise: false });
    await h.tick(PRESENCE_PUSH_MS);   // alice's board could push again now
    views.length = 0;
    re.send({ type: 'presence', sessions: [] });
    await settle(50);
    assert.deepEqual(views, [], 'alice\'s board is not recomputed for org o2');
  } finally {
    await h.destroy();
  }
});

test('presence: DELETE /api/devices/:id and removing the member drop the device\'s presence at once', async () => {
  const { h, alice, r, b } = await setup();
  try {
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    const dev = h.db.get('SELECT id FROM devices WHERE member_id = ?', h.ids.alice);
    assert.equal((await h.api(alice, 'DELETE', `/api/devices/${dev.id}`, { request_id: randomUUID() })).status, 200);
    assert.deepEqual((await h.api(alice, 'GET', `/api/boards/${h.ids.board}/presence`)).body.members, [], 'gone before the TTL');
    const gone = b.next('team.presence', (m) => m.members.length === 0, { fresh: true });
    await h.tick(PRESENCE_PUSH_MS);
    await gone;

    const bob = await h.login('bob');
    const rb = await h.runner(await h.enroll(bob));
    rb.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await settle(50);
    assert.equal(h.hub.presence.byDevice.size, 1);
    assert.equal((await h.api(alice, 'DELETE', `/api/members/${h.ids.bob}`, { request_id: randomUUID() })).status, 200);
    assert.equal(h.hub.presence.byDevice.size, 0, 'the removed member\'s devices are dropped');
  } finally {
    await h.destroy();
  }
});

test('presence: markup stays text, control and bidi characters are stripped, a session carrying a local path is dropped', async () => {
  const { h, r, b } = await setup();
  try {
    h.db.run('UPDATE members SET display_name = ? WHERE id = ?', 'Ali\u202Ece\u0007', h.ids.alice);
    h.db.run('UPDATE repos SET short_name = ? WHERE id = ?', 'ap\u2066p\u009b', h.ids.repo);
    r.send({ type: 'presence', sessions: [
      sess({ repo_id: h.ids.repo, branch: '<img src=x onerror=alert(1)>\u202E', summary: '\u202Egnp.exe\u0000 <b>done</b>\u2069' }),
      sess({ session_id: 'h-2', repo_id: h.ids.repo, summary: 'see file:///Users/callum/.ssh/id_rsa' }),
    ] });
    const f = await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    assert.equal(f.members[0].name, 'Alice');
    assert.deepEqual(f.members[0].sessions, [{ agent: 'claude', repo_short: 'app', branch: '<img src=x onerror=alert(1)>', state: 'working', since: '2026-09-30T10:00:00Z', summary: 'gnp.exe <b>done</b>' }],
      'markup is passed through as text for textContent rendering; controls and bidi are gone; the path-carrying session is dropped');
    assert.doesNotMatch(JSON.stringify(b.all('team.presence')), /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\/Users\//);
  } finally {
    await h.destroy();
  }
});
