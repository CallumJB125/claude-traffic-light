'use strict';
// Real team hub client (src/team-hub-client.js): untrusted-response shaping,
// token refresh per request, error mapping, request_id handling, change polls.
const test = require('node:test'), assert = require('node:assert/strict');
const { createTeamHubClient } = require('../src/team-hub-client');

const SHARED = '11111111-2222-4333-8444-555555555555';
const SESSION = '10000000-0000-4000-8000-000000000001';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch rig: routes GET /shared and POST .../call; `now` can rewrite payloads per call.
function rig({ shared = [], callStatus = 200, callBody = { result: { ok: true } }, text = JSON.stringify, calls = [] } = {}) {
  const state = { shared, callStatus, callBody, text, calls, delayMs: 0 };
  const fetch = async (url, init = {}) => {
    const entry = { url, method: init.method ?? 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null };
    state.calls.push(entry);
    if (state.delayMs) await wait(state.delayMs);
    if (String(url).endsWith('/api/interaction/v1/shared') && (init.method ?? 'GET') === 'GET') {
      return { status: 200, text: async () => state.text({ shared: state.shared }) };
    }
    return { status: state.callStatus, text: async () => state.text(state.callBody) };
  };
  return { fetch, state };
}

const share = (over = {}) => ({ id: SHARED, session: SESSION, scope: 'interact', expires_at: null, team: { id: 't1', name: 'Dev team' }, owner: { name: 'Bob' }, online: true, ...over });

test('teams: hub rows are whitelisted; hostile extras, oversize and wrong types never surface', async () => {
  const { fetch, state } = rig({ shared: [
    share({ cwd: '/Users/bob/secret', thread_id: 'thr_9', token: 'sk-live', device: { path: '/Users/bob' } }),
    share({ id: 'not-a-uuid' }),
    share({ session: 42 }),
    share({ team: 't1' }),
    share({ team: { id: '', name: 'x' } }),
    share({ scope: 'admin' }),
    share({ id: '22222222-2222-4333-8444-555555555555', scope: 'watch', owner: { name: 'x'.repeat(500) }, team: { id: 't2', name: 'y'.repeat(500) }, expires_at: 1234 }),
    share(),
    share(),
  ] });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 'tok-1', fetch });
  const out = await hub.teams({ id: 'u-me', name: 'Me' });
  assert.deepEqual(out, [{ id: 't1', name: 'Dev team' }, { id: 't2', name: 'y'.repeat(80) }], 'deduped teams, names capped, hostiles dropped');
  const row = (await hub.sessions({ id: 'u-me' }, 't1')).find((s) => s.ref === SHARED);
  assert.equal(row.owner.name, 'Bob');
  assert.equal(row.share.explicit, true); assert.equal(row.share.scope, 'interact');
  const json = JSON.stringify(out) + JSON.stringify(row);
  for (const leak of ['secret', 'thr_9', 'sk-live', '/Users/bob', 'not-a-uuid']) assert.equal(json.includes(leak), false, leak);
  assert.equal(row.online, true);
  const big = rig({ shared: [share({ owner: { name: 'z'.repeat(1_100_000) } })] });
  await assert.rejects(createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: big.fetch }).teams({ id: 'u' }), /unreadable/);
  state.shared.length = 0;
});

test('token is re-read for every request and the header is Bearer', async () => {
  const { fetch, state } = rig({ shared: [share()] });
  const tokens = ['tok-1', 'tok-2', 'tok-3'];
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => tokens.shift() ?? 'tok-empty', fetch });
  await hub.teams({ id: 'u-me' });
  await hub.sessions({ id: 'u-me' }, 't1');
  assert.deepEqual(state.calls.map((c) => c.auth), ['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-3'], 'one fresh token per request');
  await assert.rejects(createTeamHubClient({ baseUrl: 'https://hub.test', token: () => '', fetch }).teams({ id: 'u' }));
  assert.throws(() => createTeamHubClient({ baseUrl: 'https://hub.test', token: 'static', fetch }), /function/);
  assert.throws(() => createTeamHubClient({ baseUrl: 'ftp://x', token: () => 't', fetch }), /baseUrl/);
});

test('sessions: a state op answer shapes the entry; a broken state answer still lists the share', async () => {
  const { fetch, state } = rig({
    shared: [share({ scope: 'watch' }), share({ id: '33333333-3333-4333-8444-555555555555', team: { id: 't2', name: 'Other' } })],
    callBody: { result: { ok: true, state: { session: SESSION, generation: 3, status: 'working', provider: { id: 'claude', label: 'Claude Code' }, capabilities: { steer: true, interrupt: false }, deliveries: [{ id: 'd1', text: 'hi', by: 'Me', state: 'acknowledged', response: '', extra: 'x' }, { text: 5 }], thread_id: 'thr_1' } } },
  });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch });
  const rows = await hub.sessions({ id: 'u-me' }, 't1');
  assert.equal(rows.length, 1, 'only the asked team');
  const e = rows[0];
  assert.deepEqual([e.ref, e.team.id, e.owner.name, e.share.scope, e.share.explicit], [SHARED, 't1', 'Bob', 'watch', true]);
  assert.deepEqual(e.provider, { id: 'claude', label: 'Claude Code', kind: 'integrated' });
  assert.equal(e.state, 'working'); assert.equal(e.online, true); assert.equal(e.observed_at > 0, true);
  assert.deepEqual(e.capabilities, { steer: true, interrupt: false });
  assert.equal(e.deliveries.length, 1); assert.deepEqual(e.deliveries[0], { id: 'd1', text: 'hi', by: 'Me', state: 'acknowledged', response: '' });
  const json = JSON.stringify(e);
  for (const leak of ['thr_1', 'generation', 'extra']) assert.equal(json.includes(leak), false, leak);
  const broken = rig({ shared: [share()], callStatus: 200, callBody: { result: { ok: true, state: { deep: { leak: 'x' } } } } });
  const be = (await createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: broken.fetch }).sessions({ id: 'u' }, 't1'))[0];
  assert.equal(be.state, 'Unknown'); assert.deepEqual(be.provider, { id: 'unknown', label: 'AI', kind: 'integrated' }); assert.equal(JSON.stringify(be).includes('leak'), false);
  state.calls.length = 0;
});

test('send: forwards op send with session, hub generation, trimmed text and a fresh UUID request_id', async () => {
  const { fetch, state } = rig({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, generation: 7, status: 'ready' }, delivery: { id: 'd1', text: 'hello there', by: 'Me', state: 'queued', response: '' } } } });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch });
  await hub.teams({ id: 'u-me' });
  const out = await hub.send({ id: 'u-me' }, 't1', SHARED, '  hello there  ');
  assert.deepEqual(out, { ok: true, status: 'queued', delivery: { id: 'd1', text: 'hello there', by: 'Me', state: 'queued', response: '' } });
  const send = state.calls.find((c) => c.body?.op === 'send');
  assert.equal(send.method, 'POST');
  assert.match(send.body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(send.body.args, { session: SESSION, generation: 7, text: 'hello there' });
  assert.equal(state.calls.filter((c) => c.body?.op === 'send').length, 1, 'no automatic retry');
});

test('send: caller-supplied request_id is kept verbatim on a retry; invalid text never reaches the hub', async () => {
  const { fetch, state } = rig({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, generation: 2, status: 'ready' } } } });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch });
  await hub.teams({ id: 'u-me' });
  const rid = '99999999-9999-4999-8999-999999999999';
  await hub.send({ id: 'u-me' }, 't1', SHARED, 'again', rid);
  const first = state.calls.filter((c) => c.body?.op === 'send');
  await hub.send({ id: 'u-me' }, 't1', SHARED, 'again', rid);
  const both = state.calls.filter((c) => c.body?.op === 'send');
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((c) => c.body.request_id), [rid, rid], 'reused verbatim for dedupe');
  assert.equal(both[0].body.args.text, 'again');
  const before = state.calls.length;
  assert.equal((await hub.send({ id: 'u-me' }, 't1', SHARED, '   ')).ok, false);
  assert.equal((await hub.send({ id: 'u-me' }, 't1', SHARED, 'x\0y')).ok, false);
  assert.equal((await hub.send({ id: 'u-me' }, 't1', SHARED, 'x'.repeat(4001))).ok, false);
  assert.equal((await hub.send({ id: 'u-me' }, 't1', 'no-such-ref', 'hi')).ok, false);
  const newCalls = state.calls.slice(before);
  assert.deepEqual(newCalls.map((c) => c.body?.op).filter(Boolean), [], 'invalid input and unknown ref never send an op');
  assert.deepEqual(newCalls.filter((c) => c.method === 'GET').length, 1, 'an unknown ref costs one share-list refresh, nothing more');
});

test('send: hub HTTP 404/403/429/5xx and scope map to {ok:false,status,reason} with no hub text echoed', async () => {
  for (const [status, want] of [[404, 'stale'], [403, 'forbidden'], [429, 'unavailable'], [500, 'unavailable'], [503, 'unavailable']]) {
    const { fetch } = rig({ shared: [share({ scope: 'interact' })], callStatus: status, callBody: { error: { message: 'HUB-SECRET-TEXT' } } });
    const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch });
    const out = await hub.send({ id: 'u-me' }, 't1', SHARED, 'hi');
    assert.deepEqual([out.ok, out.status, typeof out.reason], [false, want, 'string'], `${status}`);
    assert.equal(JSON.stringify(out).includes('HUB-SECRET'), false, `${status} text echoed`);
    assert.equal(JSON.stringify(out).includes('reason'), true);
  }
  const watch = rig({ shared: [share({ scope: 'watch' })] });
  const w = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: watch.fetch });
  await w.teams({ id: 'u-me' });
  const out = await w.send({ id: 'u-me' }, 't1', SHARED, 'hi');
  assert.deepEqual([out.ok, out.status], [false, 'forbidden']);
  assert.match(out.reason, /watch only/);
  const wrongTeam = rig({ shared: [share({ team: { id: 't9', name: 'Elsewhere' } })] });
  const wt = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: wrongTeam.fetch });
  await wt.teams({ id: 'u-me' });
  assert.equal((await wt.send({ id: 'u-me' }, 't1', SHARED, 'hi')).status, 'forbidden');
  const dead = { fetch: async () => { throw new Error('down'); } };
  const d = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: dead.fetch });
  const dout = await d.send({ id: 'u-me' }, 't1', SHARED, 'hi');
  assert.equal(dout.ok, false, 'unreachable hub fails soft on send');
});

test('poll: starts with the first listener, stops after the last off, never overlaps, emits only on change', async () => {
  const { fetch, state } = rig({ shared: [share()] });
  state.delayMs = 15;
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { pollMs: 25 });
  let inFlight = 0, maxInFlight = 0, emits = 0;
  const off = hub.onChange(() => { emits++; });
  await wait(120);
  assert.ok(state.calls.length >= 2, 'polled repeatedly while a listener exists');
  maxInFlight = 0;
  await wait(120);
  assert.ok(state.calls.length >= 4, 'keeps polling');
  assert.equal(maxInFlight <= 1, true, 'polls never overlap');
  const emitsAtSteady = emits;
  assert.equal(emitsAtSteady, 1, 'unchanged payload emits once, not per poll');
  state.shared = [share({ owner: { name: 'Ana' } })];
  await wait(100);
  assert.equal(emits, 2, 'changed content emits again');
  state.shared = [share({ owner: { name: 'Ana' } })];
  await wait(100);
  assert.equal(emits, 2, 'identical payload emits nothing');
  const atOff = state.calls.length;
  off();
  await wait(120);
  assert.equal(state.calls.length, atOff, 'the last off stops the poll loop');
  const off2 = hub.onChange(() => {}), off3 = hub.onChange(() => {});
  await wait(80);
  off2();
  const afterFirst = state.calls.length;
  await wait(60);
  assert.ok(state.calls.length >= afterFirst, 'still polling while one listener remains');
  off3();
  await wait(120);
  const stopped = state.calls.length;
  await wait(100);
  assert.equal(state.calls.length, stopped, 'stops again when the last listener goes');
});

test('poll: an unreadable or failing shared list keeps the loop alive and emits nothing', async () => {
  let n = 0;
  const fetch = async () => { n++; return { status: 500, text: async () => '{"shared":[]}' }; };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { pollMs: 20 });
  let emits = 0;
  const off = hub.onChange(() => { emits++; });
  await wait(100);
  assert.ok(n >= 2, 'errors do not stop the loop');
  assert.equal(emits, 0, 'no emit on failure');
  off();
});
