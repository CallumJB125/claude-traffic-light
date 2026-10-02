'use strict';
// Real team hub client (src/team-hub-client.js): untrusted-response shaping,
// token refresh per request, error mapping, request_id handling, polls,
// deadline/bounded fan-out, and the security-review contracts (M1-M7).
const test = require('node:test'), assert = require('node:assert/strict');
const { createTeamHubClient } = require('../src/team-hub-client');

const T0 = 1_800_000_000_000;
const SHARED = '11111111-2222-4333-8444-555555555555';
const SESSION = '10000000-0000-4000-8000-000000000001';
const OWNER = 'u-bob-777';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch rig: GET /shared -> {shared}; any call -> state.callBody/status. Records
// every request and the REAL in-flight concurrency seen by the fake transport.
function rig({ shared = [], callStatus = 200, callBody = { result: { ok: true } }, delayMs = 0 } = {}) {
  const state = { shared, callStatus, callBody, delayMs, calls: [], inFlight: 0, maxInFlight: 0 };
  const json = (status, body) => ({
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(JSON.stringify(body).length) : null) },
    text: async () => JSON.stringify(body),
    body: null,
  });
  const fetch = async (url, init = {}) => {
    const entry = { url: String(url), method: init.method ?? 'GET', auth: init.headers?.authorization, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : null };
    state.calls.push(entry);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (state.delayMs) await wait(state.delayMs);
      if (entry.url.endsWith('/api/interaction/v1/shared') && entry.method === 'GET') return json(200, { shared: state.shared });
      return json(state.callStatus, state.callBody);
    } finally { state.inFlight--; }
  };
  return { fetch, state };
}

const share = (over = {}) => ({ id: SHARED, session: SESSION, scope: 'interact', expires_at: null, team: { id: 't1', name: 'Dev team' }, owner: { id: OWNER, name: 'Bob' }, online: true, ...over });
const stateOk = (over = {}) => ({ result: { ok: true, state: { session: SESSION, generation: 3, status: 'working', observed_at: T0 - 1000, provider: { id: 'claude', label: 'Claude Code' }, capabilities: { steer: true, interrupt: false }, deliveries: [{ id: 'd1', text: 'hi', by: 'Ana', state: 'acknowledged', response: '', extra: 'x' }, { text: 5 }], thread_id: 'thr_1' }, ...over } });
const mk = ({ shared, callBody, callStatus, delayMs } = {}) => {
  const r = rig({ shared, callBody, callStatus, delayMs });
  return { r, hub: createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 'tok-1', fetch: r.fetch }, { now: () => T0 }) };
};

test('viewer: injected options are returned (bounded), otherwise null', () => {
  const r = rig({});
  const opt = { baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch };
  assert.deepEqual(createTeamHubClient({ ...opt, viewer: { id: 'u-me', name: 'Me' } }).viewer(), { id: 'u-me', name: 'Me' });
  assert.deepEqual(createTeamHubClient({ ...opt, viewerId: 'u-only' }).viewer(), { id: 'u-only', name: 'You' });
  assert.equal(createTeamHubClient(opt).viewer(), null, 'the wiring supplies the real identity');
  const big = createTeamHubClient({ ...opt, viewer: { id: 'x'.repeat(300), name: 'n'.repeat(300) } }).viewer();
  assert.equal(big.id.length, 100);
  assert.equal(big.name.length, 80);
});

test('teams + sessions: hostile rows whitelisted; missing owner.id drops the row; owner.id is the hub field', async () => {
  const noOwner = { id: '33333333-3333-4333-8444-555555555555', session: SESSION, scope: 'watch', team: { id: 't1', name: 'Dev team' }, owner: { name: 'NoId' }, online: true };
  const { hub, r } = mk({ shared: [
    share({ cwd: '/Users/bob/secret', thread_id: 'thr_9', token: 'sk-live', device: { path: '/Users/bob' } }),
    share({ id: 'not-a-uuid' }),
    share({ session: 42 }),
    share({ team: 't1' }),
    share({ team: { id: '', name: 'x' } }),
    share({ scope: 'admin' }),
    noOwner,
    share({ id: '22222222-2222-4333-8444-555555555555', scope: 'watch', owner: { id: 'u-a'.padEnd(120, 'x'), name: 'x'.repeat(500) }, team: { id: 't2', name: 'y'.repeat(500) }, expires_at: 1234 }),
    share({ owner: { id: 'u-c', name: 'Cara', real_name: 'spoof' } }),
    share(),
    share(),
  ] });
  const out = await hub.teams({ id: 'u-me' });
  assert.deepEqual(out, [{ id: 't1', name: 'Dev team' }, { id: 't2', name: 'y'.repeat(80) }], 'deduped teams, names capped, hostiles dropped');
  const rows = await hub.sessions({ id: 'u-me' }, 't1');
  const row = rows.find((s) => s.ref === SHARED);
  assert.equal(row.owner.id, OWNER, 'M1: owner.id is the hub row field');
  assert.notEqual(row.owner.id, SHARED, 'never the share id');
  assert.equal(rows.some((s) => s.ref === noOwner.id), false, 'a row without owner.id is dropped');
  const json = JSON.stringify(out) + JSON.stringify(rows);
  for (const leak of ['secret', 'thr_9', 'sk-live', '/Users/bob', 'not-a-uuid', 'spoof', 'real_name', 'NoId']) assert.equal(json.includes(leak), false, leak);
  r.state.calls.length = 0;
});

test('token re-read per request as Bearer; redirect:error passed; a failing token makes no request', async () => {
  const { r } = mk({ shared: [share()] });
  const tokens = ['tok-1', 'tok-2', 'tok-3'];
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => tokens.shift() ?? 'tok-x', fetch: r.fetch }, { now: () => T0 });
  await hub.teams({ id: 'u-me' });
  await hub.sessions({ id: 'u-me' }, 't1');
  assert.deepEqual(r.state.calls.map((c) => c.auth), ['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-3'], 'one fresh token per request');
  assert.ok(r.state.calls.every((c) => c.redirect === 'error'), 'M6: redirect:error on every request');
  let used = 0;
  const throwing = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => { used++; throw new Error('refresh failed'); }, fetch: rig({}).fetch }, { now: () => T0 });
  await assert.rejects(throwing.teams({ id: 'u' }), /refresh failed/);
  assert.equal(used, 1);
  const empty = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => '', fetch: rig({}).fetch }, { now: () => T0 });
  await assert.rejects(empty.teams({ id: 'u' }), /token/);
});

test('sessions: state shapes the entry; broken state still lists; observed_at from the hub, clamped, never fabricated', async () => {
  const { hub, r } = mk({ shared: [share({ scope: 'watch' }), share({ id: '44444444-4444-4333-8444-555555555555', team: { id: 't2', name: 'Other' } })], callBody: stateOk() });
  const rows = await hub.sessions({ id: 'u-me' }, 't1');
  assert.equal(rows.length, 1, 'only the asked team');
  const e = rows[0];
  assert.deepEqual([e.ref, e.team.id, e.owner.name, e.owner.id, e.share.scope, e.share.explicit], [SHARED, 't1', 'Bob', OWNER, 'watch', true]);
  assert.deepEqual(e.provider, { id: 'claude', label: 'Claude Code', kind: 'integrated' });
  assert.equal(e.state, 'working');
  assert.equal(e.observed_at, T0 - 1000, 'M4: the hub stamp, not now');
  assert.deepEqual(e.capabilities, { steer: true, interrupt: false });
  assert.deepEqual(e.deliveries[0], { id: 'd1', text: 'hi', by: 'Ana', state: 'acknowledged', response: '' });
  const json = JSON.stringify(e);
  for (const leak of ['thr_1', 'generation', 'extra']) assert.equal(json.includes(leak), false, leak);
  const clamped = mk({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, status: 'ready', observed_at: T0 + 5000 } } } });
  assert.equal((await clamped.hub.sessions({ id: 'u' }, 't1'))[0].observed_at, T0, 'a future hub stamp clamps to now');
  const none = mk({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, status: 'idle', deep: { leak: 'x' } } } } });
  const ne = (await none.hub.sessions({ id: 'u' }, 't1'))[0];
  assert.equal(ne.state, 'Unknown', 'an unmapped status stays Unknown');
  assert.deepEqual(ne.provider, { id: 'unknown', label: 'AI', kind: 'integrated' });
  assert.equal(ne.observed_at, null, 'no hub stamp: null, never Date.now()');
  assert.equal(JSON.stringify(ne).includes('leak'), false);
  r.state.calls.length = 0;
});

test('send: state op then send op; generation fetched fresh; fresh UUID request_id; no auto-retry', async () => {
  const { hub, r } = mk({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, generation: 7, status: 'ready', observed_at: T0 - 5 }, delivery: { id: 'd1', text: 'hello there', by: 'Me', state: 'queued', response: '' } } } });
  await hub.teams({ id: 'u-me' });
  const out = await hub.send({ id: 'u-me' }, 't1', SHARED, '  hello there  ');
  assert.deepEqual(out, { ok: true, status: 'queued', delivery: { id: 'd1', text: 'hello there', by: 'Me', state: 'queued', response: '' } });
  const sends = r.state.calls.filter((c) => c.body?.op === 'send');
  assert.equal(sends.length, 1, 'no automatic retry');
  assert.match(sends[0].body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(sends[0].body.args, { session: SESSION, generation: 7, text: 'hello there' });
});

test('send: a valid caller request_id is kept verbatim; an invalid one is replaced by a UUID', async () => {
  const { hub, r } = mk({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, generation: 2, status: 'ready', observed_at: T0 - 5 } } } });
  await hub.teams({ id: 'u-me' });
  const rid = '99999999-9999-4999-8999-999999999999';
  await hub.send({ id: 'u-me' }, 't1', SHARED, 'again', rid);
  await hub.send({ id: 'u-me' }, 't1', SHARED, 'again', rid);
  const sends = r.state.calls.filter((c) => c.body?.op === 'send');
  assert.deepEqual(sends.map((c) => c.body.request_id), [rid, rid], 'L1: reused verbatim for dedupe');
  await hub.send({ id: 'u-me' }, 't1', SHARED, 'again', 'not-a-uuid');
  const third = r.state.calls.filter((c) => c.body?.op === 'send')[2];
  assert.notEqual(third.body.request_id, 'not-a-uuid');
  assert.match(third.body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('send: invalid text and missing/mismatched team fail closed before any op call', async () => {
  const { hub, r } = mk({ shared: [share()] });
  await hub.teams({ id: 'u-me' });
  const before = r.state.calls.length;
  for (const text of ['   ', 'x\0y', 'x'.repeat(4001)]) assert.equal((await hub.send({ id: 'u-me' }, 't1', SHARED, text)).ok, false);
  assert.equal((await hub.send({ id: 'u-me' }, undefined, SHARED, 'hi')).status, 'forbidden', 'L4: missing teamId fails closed');
  assert.equal((await hub.send({ id: 'u-me' }, 't2', SHARED, 'hi')).status, 'forbidden', 'L4: mismatched teamId');
  assert.equal((await hub.send({ id: 'u-me' }, 't1', 'no-such-ref', 'hi')).ok, false);
  const made = r.state.calls.slice(before);
  assert.deepEqual(made.map((c) => c.body?.op).filter(Boolean), [], 'no op call for invalid input');
  assert.deepEqual(made.filter((c) => c.method === 'GET').length, 1, 'an unknown ref costs one share-list refresh, nothing more');
});

test('send: the SEND op own non-200 mapping with state ok; error and reason both set; no hub text echoed', async () => {
  for (const [status, want] of [[404, 'stale'], [403, 'forbidden'], [429, 'unavailable'], [500, 'unavailable'], [503, 'unavailable']]) {
    const r = rig({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, generation: 1, status: 'ready' } } } });
    const base = r.fetch;
    let n = 0;
    r.fetch = async (url, init) => {
      const out = await base(url, init);
      n++;
      if (n === 3) return { ...out, status, text: async () => JSON.stringify({ error: { message: 'HUB-SECRET-TEXT' } }) };
      return out;
    };
    const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch }, { now: () => T0 });
    await hub.teams({ id: 'u-me' });
    const out = await hub.send({ id: 'u-me' }, 't1', SHARED, 'hi');
    assert.deepEqual([out.ok, out.status], [false, want], `${status} mapped from the send op itself`);
    assert.equal(typeof out.reason, 'string');
    assert.equal(out.error, out.reason, 'M3: error and reason, same whitelisted string');
    assert.equal(JSON.stringify(out).includes('HUB-SECRET'), false, `${status}: hub text never echoed`);
    assert.equal(r.state.calls.filter((c) => c.body?.op === 'send').length, 1);
  }
  const watch = mk({ shared: [share({ scope: 'watch' })] });
  await watch.hub.teams({ id: 'u-me' });
  const out = await watch.hub.send({ id: 'u-me' }, 't1', SHARED, 'hi');
  assert.deepEqual([out.ok, out.status], [false, 'forbidden']);
  assert.match(out.reason, /watch only/);
  const dead = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: async () => { throw new Error('down'); } }, { now: () => T0 });
  const dout = await dead.send({ id: 'u-me' }, 't1', SHARED, 'hi');
  assert.equal(dout.ok, false, 'unreachable hub fails soft on send');
  assert.equal(dout.error, dout.reason);
});

test('M5: oversize content-length refused unread; streaming aborts above the cap counting bytes; text() fallback only without a stream', async () => {
  let readAtAll = false;
  const byLen = async (bytes) => ({
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(bytes) : null) },
    text: async () => { readAtAll = true; return '{"shared":[]}'; },
    body: { getReader: () => ({ read: async () => { readAtAll = true; return { done: true }; } }) },
  });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: async () => byLen(1_100_000) }, { now: () => T0 });
  await assert.rejects(hub.teams({ id: 'u' }), /unreadable/, 'content-length above the cap is refused before reading');
  assert.equal(readAtAll, false);
  let reads = 0, cancelled = false;
  const fetch2 = async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => { throw new Error('must not fall back to text() when a stream exists'); },
    body: { getReader: () => ({ read: async () => (reads++ < 3 ? { done: false, value: new Uint8Array(400_001).fill(120) } : { done: true }), cancel: async () => { cancelled = true; } }) },
  });
  const hub2 = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: fetch2 }, { now: () => T0 });
  await assert.rejects(hub2.teams({ id: 'u' }), /unreadable/, 'a streamed body over the cap aborts');
  assert.ok(reads >= 3, 'read until past the cap');
  assert.equal(cancelled, true, 'the stream is cancelled');
  const hub3 = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ shared: [] }), body: null }) }, { now: () => T0 });
  assert.deepEqual(await hub3.teams({ id: 'u' }), [], 'no stream: byte-capped text() fallback');
});

test('M6: https required, http only loopback; credentials/query/hash/invalid rejected', () => {
  const ok = (url) => createTeamHubClient({ baseUrl: url, token: () => 't', fetch: rig({}).fetch }, { now: () => T0 });
  assert.doesNotThrow(() => ok('https://hub.test/prefix'));
  assert.doesNotThrow(() => ok('http://localhost:8080'));
  assert.doesNotThrow(() => ok('http://127.0.0.1:8080'));
  assert.doesNotThrow(() => ok('http://[::1]:9000'));
  assert.throws(() => ok('http://hub.example'), /https/);
  assert.throws(() => ok('https://user:pw@hub.test'), /credentials/);
  assert.throws(() => ok('https://hub.test?x=1'), /query/);
  assert.throws(() => ok('https://hub.test/#frag'), /fragment/);
  assert.throws(() => ok('not a url'), /URL/);
  assert.throws(() => createTeamHubClient({ token: () => 't', fetch: rig({}).fetch }), /baseUrl/);
});

test('M7: fan-out bounded, deadline lists stragglers without state, per-team rows capped at 100', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => share({ id: `${String(i + 1).padStart(8, '0')}-2222-4333-8444-555555555555` }));
  let calls = 0, maxInFlight = 0, inFlight = 0;
  const json = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body), body: null });
  const fetch = async (url) => {
    if (String(url).endsWith('/shared')) return json(200, { shared: rows });
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try { await wait(40); return json(200, { result: { ok: true, state: { session: SESSION, generation: 1, status: 'working', observed_at: T0 - 5 } } }); }
    finally { inFlight--; }
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { now: () => T0, deadlineMs: 500, timeoutMs: 5_000 });
  const t0 = Date.now();
  const out = await hub.sessions({ id: 'u-me' }, 't1');
  const ms = Date.now() - t0;
  assert.equal(out.length, 30, 'every row is listed');
  assert.ok(out.every((e) => e.state === 'working'), 'rows inside the deadline are shaped');
  assert.equal(maxInFlight <= 6, true, `bounded concurrency 6 (saw ${maxInFlight})`);
  assert.ok(ms < 1500, `fanned out (${ms}ms), not serial`);
  assert.ok(calls <= 30);
  const hung = rig({ shared: [share()] });
  const slow = hung.fetch;
  hung.fetch = async (url, init) => {
    if (String(url).endsWith('/shared')) return slow(url, init);
    await wait(10_000);
    return slow(url, init);
  };
  const hub2 = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: hung.fetch }, { now: () => T0, deadlineMs: 120, timeoutMs: 9_000 });
  const t2 = Date.now();
  const out2 = await hub2.sessions({ id: 'u' }, 't1');
  assert.ok(Date.now() - t2 < 3000, 'the overall deadline returns promptly');
  assert.deepEqual(out2.map((e) => [e.ref, e.state]), [[SHARED, 'Unknown']], 'a stragglers row is listed without state');
  assert.equal(out2[0].observed_at, null);
  const many = Array.from({ length: 150 }, (_, i) => share({ id: `${String(i + 1).padStart(8, '0')}-2222-4333-8444-555555555555` }));
  let stateCalls = 0;
  const fetch3 = async (url) => {
    if (String(url).endsWith('/shared')) return json(200, { shared: many });
    stateCalls++;
    return json(200, { result: { ok: true, state: { session: SESSION, generation: 1, status: 'ready', observed_at: T0 - 5 } } });
  };
  const hub3 = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: fetch3 }, { now: () => T0, deadlineMs: 5_000, timeoutMs: 5_000 });
  const out3 = await hub3.sessions({ id: 'u' }, 't1');
  assert.equal(out3.length, 100, 'MAX_PER_TEAM caps the fan-out');
  assert.equal(stateCalls, 100);
});

test('poll: real in-flight counted in the transport; no overlap; emit only on change; starts/stops with listeners', async () => {
  const { r } = mk({ shared: [share()] });
  r.state.delayMs = 20;
  const client = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch }, { now: () => T0, pollMs: 30 });
  let emits = 0;
  const off = client.onChange(() => { emits++; });
  await wait(160);
  assert.ok(r.state.calls.length >= 3, 'polled repeatedly while a listener exists');
  assert.equal(r.state.maxInFlight <= 1, true, `polls never overlap (max in-flight ${r.state.maxInFlight})`);
  assert.equal(emits, 1, 'unchanged payload emits once, not per poll');
  r.state.shared = [share({ owner: { id: OWNER, name: 'Ana' } })];
  await wait(120);
  assert.equal(emits, 2, 'changed content emits again');
  r.state.shared = [share({ owner: { id: OWNER, name: 'Ana' } })];
  await wait(120);
  assert.equal(emits, 2, 'identical payload emits nothing');
  const atOff = r.state.calls.length;
  off();
  await wait(140);
  assert.equal(r.state.calls.length, atOff, 'the last off stops the poll loop');
  const off2 = client.onChange(() => {}), off3 = client.onChange(() => {});
  await wait(100);
  off2();
  await wait(80);
  const still = r.state.calls.length;
  await wait(80);
  assert.ok(r.state.calls.length > still, 'still polling while one listener remains');
  off3();
  await wait(140);
  const stopped = r.state.calls.length;
  await wait(100);
  assert.equal(r.state.calls.length, stopped, 'stops again when the last listener goes');
});

test('poll: exponential backoff after failures, reset on success', async () => {
  let mode = 'fail';
  const gaps = [];
  let lastAt = 0;
  const json = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body), body: null });
  const fetch = async () => {
    const at = Date.now();
    if (lastAt) gaps.push(at - lastAt);
    lastAt = at;
    return mode === 'fail' ? json(500, { shared: [] }) : json(200, { shared: [share()] });
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { now: () => T0, pollMs: 20 });
  const off = hub.onChange(() => {});
  await wait(260);
  mode = 'ok';
  await wait(120);
  off();
  assert.ok(gaps.length >= 3, `several polls happened (${gaps.length})`);
  assert.ok(Math.max(...gaps) >= 40, 'L6: failures back off beyond the base interval');
  assert.ok(gaps[gaps.length - 1] <= 45, 'success resets the interval to the base');
});

test('timeout/abort: a hung hub is cut at the timeout; send fails closed, teams surfaces it', async () => {
  const json = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body), body: null });
  const fetch = (url, init = {}) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    void url;
  });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { now: () => T0, timeoutMs: 60 });
  const out = await hub.send({ id: 'u-me' }, 't1', SHARED, 'hi');
  assert.equal(out.ok, false, 'send swallows the abort and fails closed');
  assert.equal(out.error, out.reason);
  const teamsOut = await createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { now: () => T0, timeoutMs: 60 })
    .teams({ id: 'u' }).then(() => 'resolved', (e) => String(e));
  assert.ok(/unreadable|Abort/i.test(teamsOut), 'teams() surfaces the abort to its caller');
  void json;
});

test('token never appears in failures, results or thrown messages', async () => {
  const { hub, r } = mk({ shared: [share()] });
  r.state.callStatus = 500;
  r.state.callBody = { error: { message: 'x' } };
  await hub.teams({ id: 'u-me' }).catch(() => {});
  const out = await hub.send({ id: 'u-me' }, 't1', SHARED, 'hi');
  assert.equal(out.ok, false);
  const blob = JSON.stringify(out) + String(out.error) + String(out.reason);
  assert.equal(blob.includes('tok-1'), false, 'no token in a failure');
  const throwing = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => { throw new Error('refresh failed'); }, fetch: rig({}).fetch }, { now: () => T0 });
  const thrown = await throwing.teams({ id: 'u' }).then(() => '', (e) => String(e));
  assert.equal(thrown.includes('tok-1'), false, 'no token via a thrown token() error either');
  r.state.calls.length = 0;
});
