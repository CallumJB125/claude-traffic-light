// Team presence (D37b): in memory, per device, TTL after the last frame,
// default deny on board-linked repos, never journaled; browsers of a board see
// only their org's sessions in that board's repos, over WS and HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PRESENCE_TTL_MS } from '../../shared/liveness.js';
import { DEFAULT_LIMITS } from '../ratelimit.js';
import { startHub, settle } from './helpers.js';

const sess = (over = {}) => ({ session_id: 'h-1', agent: 'claude', repo_id: 'x', branch: 'feat/a', state: 'working', since: 1_790_000_000_000, summary: 'editing the parser', ...over });
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
    assert.deepEqual(f, { type: 'team.presence', members: [{ member_id: h.ids.alice, name: 'Alice', sessions: [{ agent: 'claude', repo_short: 'app', branch: 'feat/a', state: 'working', since: 1_790_000_000_000, summary: 'editing the parser' }] }] });
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
  const { h, r, b } = await setup();
  try {
    r.send({ type: 'presence', sessions: [sess({ repo_id: h.ids.repo })] });
    await b.next('team.presence', (m) => m.members.length === 1, { fresh: true });
    r.send({ type: 'presence', sessions: [] });
    await b.next('team.presence', (m) => m.members.length === 0, { fresh: true });

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

test('presence: malformed frames are refused (agent, state, summary over 120, no repo)', async () => {
  const { h, r, b } = await setup();
  try {
    for (const bad of [sess({ repo_id: h.ids.repo, agent: 'bogus' }), sess({ repo_id: h.ids.repo, state: 'busy' }), sess({ repo_id: h.ids.repo, summary: 'x'.repeat(121) }), { ...sess(), repo_id: undefined }]) {
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
