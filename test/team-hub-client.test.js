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
    share({ id: '22222222-2222-4333-8444-555555555555', scope: 'watch', owner: { id: 'u-a'.padEnd(20, 'x'), name: 'x'.repeat(500) }, team: { id: 't2', name: 'y'.repeat(500) }, expires_at: 1234 }),
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
  let hungStart = 0, abortedAt = 0;
  hung.fetch = async (url, init) => {
    if (String(url).endsWith('/shared')) return slow(url, init);
    hungStart = Date.now();
    return new Promise((resolve) => {
      init.signal?.addEventListener('abort', () => { abortedAt = Date.now(); resolve({ status: 0, headers: { get: () => null }, text: async () => '', body: null }); });
    });
  };
  const hub2 = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: hung.fetch }, { now: () => T0, deadlineMs: 120, timeoutMs: 9_000 });
  const t2 = Date.now();
  const out2 = await hub2.sessions({ id: 'u' }, 't1');
  assert.ok(Date.now() - t2 < 3000, 'the overall deadline returns promptly');
  assert.deepEqual(out2.map((e) => [e.ref, e.state]), [[SHARED, 'Unknown']], 'a stragglers row is listed without state');
  assert.equal(out2[0].observed_at, null);
  await wait(60);
  assert.ok(abortedAt > 0 && abortedAt - hungStart <= 1000, `N2: the in-flight state request aborts at the deadline (${abortedAt - hungStart}ms after start)`);
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
  const marks = [];
  let lastAt = 0;
  const json = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body), body: null });
  const fetch = async () => {
    const at = Date.now();
    marks.push({ gap: lastAt ? at - lastAt : 0, ok: mode === 'ok' });
    lastAt = at;
    return mode === 'fail' ? json(500, { shared: [] }) : json(200, { shared: [share()] });
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { now: () => T0, pollMs: 20 });
  const off = hub.onChange(() => {});
  await wait(330);
  mode = 'ok';
  await wait(420);
  off();
  const gaps = marks.slice(1).map((m) => m.gap);
  assert.ok(gaps.length >= 3, `several polls happened (${gaps.length})`);
  assert.ok(Math.max(...gaps) >= 35, 'L6: failures back off beyond the base interval (generous bound)');
  const firstOk = marks.findIndex((m, i) => i > 0 && m.ok);
  assert.ok(firstOk > 0, 'a successful poll happened');
  assert.ok(marks.slice(firstOk + 1).every((m) => m.gap <= 90), 'L6: after the first success every following interval is back near the base');
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

test('N1: a rejecting reader.cancel() on an oversize stream never fires unhandledRejection', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e?.message ?? e));
  process.on('unhandledRejection', onUnhandled);
  let cancelled = 0;
  const fetch = async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => { throw new Error('must not fall back to text()'); },
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(400_001).fill(120) }),
      cancel: () => { cancelled++; return Promise.reject(new Error('AbortError: This operation was aborted')); },
    }) },
  });
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch }, { now: () => T0 });
  await assert.rejects(hub.teams({ id: 'u' }), /unreadable/);
  assert.equal(cancelled, 1);
  await wait(50);
  await wait(0);
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'cancel() rejection is always handled');
});

test('N3: delivery text/response keep newlines and tabs; other controls and excess blank lines are collapsed', async () => {
  const { hub } = mk({
    shared: [share()],
    callBody: { result: { ok: true, state: { session: SESSION, generation: 1, status: 'ready', deliveries: [
      { id: 'd1', text: 'line1\nline2\tindented\n\n- item', by: 'Ana', state: 'replied', response: 'a\n\n\n\nb' },
      { id: 'd2', text: 'bad\u0007bell\r\nok', by: 'Bob', state: 'acknowledged', response: '' },
    ] } } },
  });
  const e = (await hub.sessions({ id: 'u' }, 't1'))[0];
  assert.equal(e.deliveries[0].text, 'line1\nline2\tindented\n\n- item', 'multi-line reply preserved');
  assert.equal(e.deliveries[0].response, 'a\n\nb', '3+ newlines collapse to 2');
  assert.equal(e.deliveries[1].text, 'badbell\nok', 'C0 stripped, CRLF normalised to the kept newline');
});

test('N3: control, bidi and zero-width characters are stripped from hub names and ids', async () => {
  const { hub } = mk({ shared: [
    share({ owner: { id: '  u-bob-777  ', name: 'A\u200bd\u202ei\u061cs\u200b' }, team: { id: 't1', name: 'De\u202bv team\u2066' } }),
    share({ id: '22222222-2222-4333-8444-555555555555', owner: { id: 'u-ana', name: 'Ana\u00ad' }, team: { id: 't2', name: 'Other\u200e' } }),
  ] });
  const rows = await hub.sessions({ id: 'u' }, 't1');
  assert.equal(rows[0].owner.name, 'Adis', 'bidi/zero-width stripped, letters kept');
  assert.equal(rows[0].owner.id, 'u-bob-777', 'owner.id is trimmed');
  assert.equal(rows[0].team.name, 'Dev team');
  const teams = await hub.teams({ id: 'u' });
  assert.deepEqual(teams.map((t) => t.name), ['Dev team', 'Other'], 'stripping applied across rows (a mutant without it fails)');
});

test('N4: a whitespace owner.id drops the row; an over-100-char owner.id is rejected, never truncated', async () => {
  const long = 'x'.repeat(140);
  const { hub } = mk({ shared: [
    { id: '33333333-3333-4333-8444-555555555555', session: SESSION, scope: 'watch', team: { id: 't1', name: 'D' }, owner: { id: '   ', name: 'Ghost' }, online: true },
    { id: '44444444-4444-4333-8444-555555555555', session: SESSION, scope: 'watch', team: { id: 't1', name: 'D' }, owner: { id: long, name: 'Long' }, online: true },
    share({ owner: { id: `  ${OWNER}  `, name: 'Bob' } }),
  ] });
  const rows = await hub.sessions({ id: 'u' }, 't1');
  assert.deepEqual(rows.map((r) => r.owner.id), [OWNER], 'only the trimmed valid row survives');
  assert.equal(JSON.stringify(rows).includes('x'.repeat(101)), false, 'no 100-char truncation happened');
});

test('onChange: the first poll emits by design (shares go from unknown to known), then only on real change', async () => {
  const { hub, r } = mk({ shared: [share()] });
  r.state.delayMs = 10;
  const client = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch }, { now: () => T0, pollMs: 25 });
  let emits = 0;
  const off = client.onChange(() => { emits++; });
  await wait(90);
  assert.equal(emits, 1, 'exactly one initial emit');
  await wait(80);
  assert.equal(emits, 1, 'and none for an unchanged list');
  off();
});

test('poll: off() then on() during an in-flight poll reschedules exactly once (the running guard)', async () => {
  const { r } = mk({ shared: [share()] });
  r.state.delayMs = 60;
  const client = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch }, { now: () => T0, pollMs: 20 });
  let emits = 0;
  const off = client.onChange(() => { emits++; });
  await wait(40);
  assert.equal(r.state.inFlight === 1, true, 'a poll is genuinely in flight now');
  off();
  const back = client.onChange(() => { emits++; });
  await wait(120);
  assert.equal(r.state.maxInFlight <= 1, true, `no overlap: a resubscribe during an in-flight poll must not start a second one (max ${r.state.maxInFlight})`);
  const scheduledAt = r.state.calls.length;
  await wait(200);
  assert.ok(r.state.calls.length > scheduledAt, 'the poll loop resumed after re-subscribe during an in-flight poll');
  assert.ok(r.state.calls.length > 2, 'polling continued, not stuck');
  off();
  back();
  await wait(80);
  back();
  const stoppedAt = r.state.calls.length;
  await wait(180);
  assert.equal(r.state.calls.length, stoppedAt, 'stops when the last listener goes');
});

test('F1: a late state response that ignores the abort signal never mutates entries already returned', async () => {
  const r = rig({ shared: [share()] });
  const base = r.fetch;
  let release;
  const gate = new Promise((res) => { release = res; });
  r.fetch = async (url, init) => {
    if (String(url).endsWith('/shared')) return base(url, init);
    await gate;
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(stateOk()), body: null };
  };
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch }, { now: () => T0, deadlineMs: 80, timeoutMs: 9_000 });
  const out = await hub.sessions({ id: 'u' }, 't1');
  const snapshot = JSON.stringify(out);
  assert.equal(out[0].state, 'Unknown');
  release();
  await wait(40);
  assert.equal(JSON.stringify(out), snapshot, 'returned entries are not mutated after the deadline');
});

test('F2/F3: bidi, zero-width, line-separator, invisible-format and tag characters are stripped from prose, names and ids', async () => {
  const bad = ['‮', '​', '⁦', ' ', ' ', '⁠', '⁢', '⁤', '\u{e0001}', '\u{e0041}', '\u{e007f}'];
  for (const c of bad) {
    const { hub } = mk({
      shared: [share({ owner: { id: `u-${c}bob`, name: `Bo${c}b` }, team: { id: 't1', name: `Te${c}am` } })],
      callBody: { result: { ok: true, state: { session: SESSION, generation: 1, status: 'ready', deliveries: [{ id: 'd1', text: `a${c}b\nc`, by: 'Ana', state: 'replied', response: `x${c}y` }] } } },
    });
    const e = (await hub.sessions({ id: 'u' }, 't1'))[0];
    const label = `U+${c.codePointAt(0).toString(16)}`;
    assert.equal(e.deliveries[0].text, 'ab\nc', `text ${label}`);
    assert.equal(e.deliveries[0].response, 'xy', `response ${label}`);
    assert.equal(e.owner.name, 'Bob', `name ${label}`);
    assert.equal(e.owner.id, 'u-bob', `id ${label}`);
    assert.equal(e.team.name, 'Team', `team ${label}`);
  }
});

test('L8: send() maps a stale refusal or a generation race to stale/"changed"; other refusals are not retryable', async () => {
  const run = async (sendResult) => {
    const r = rig({ shared: [share()], callBody: { result: { ok: true, state: { session: SESSION, generation: 1, status: 'ready' } } } });
    const base = r.fetch;
    r.fetch = async (url, init) => {
      const out = await base(url, init);
      if (init?.body && JSON.parse(init.body).op === 'send') return { ...out, text: async () => JSON.stringify({ result: sendResult }) };
      return out;
    };
    const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', fetch: r.fetch }, { now: () => T0 });
    await hub.teams({ id: 'u' });
    return hub.send({ id: 'u' }, 't1', SHARED, 'hi');
  };
  for (const res of [{ ok: false, status: 'generation_mismatch' }, { ok: false, status: 'stale' }, { ok: false, error: 'generation mismatch' }]) {
    const out = await run(res);
    assert.deepEqual([out.ok, out.status, out.reason, out.error], [false, 'stale', 'The session changed; try again.', 'The session changed; try again.']);
  }
  assert.equal((await run({ ok: false })).status, 'unavailable');
  assert.equal((await run({ ok: false, error: 'image generation unavailable' })).status, 'unavailable');
  for (const status of ['invalid', 'something_new', 'busy']) assert.equal((await run({ ok: false, status })).status, 'unavailable', status);
  assert.equal((await run({ ok: false, status: 'forbidden' })).status, 'forbidden');
});
