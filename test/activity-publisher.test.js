'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityPublisher, hubPoster, shareable } = require('../src/activity-publisher');
const { workRecord } = require('./fixtures/work-record');

const HUB = 'https://hub.example.test';
const route = (extra = {}) => ({ hub: HUB, team_id: 'team-a', repo_id: 'repo-a', share_summaries: true, share_files: false, ...extra });

function rig(t, { routes = [route()], answer, ...opts } = {}) {
  let time = 1_000_000;
  const calls = [];
  const timers = [];
  const answerFn = answer ?? ((body) => ({ ok: true, status: 200, body: { results: body.records.map((r) => ({ record_id: r.record_id, rev: r.rev, status: 'applied' })) } }));
  const p = createActivityPublisher({
    getRoutes: async () => ({ routes, complete: true }),
    post: async (hub, path, body) => { calls.push({ hub, path, body: structuredClone(body) }); return answerFn(body, calls.length); },
    now: () => time,
    timers: { setTimeout: (fn, ms) => { const h = { fn, at: time + ms }; timers.push(h); return h; }, clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } },
    debounceMs: 10, ...opts,
  });
  t.after(() => p.stop());
  const run = async (ms) => { time += ms; for (const h of timers.filter((x) => x.at <= time)) { timers.splice(timers.indexOf(h), 1); await h.fn(); } };
  return { p, calls, run, timers };
}

test('only repos whose route shares summaries publish; files only with share_files', async (t) => {
  const r = rig(t, { routes: [route(), route({ repo_id: 'repo-b', share_summaries: false }), route({ repo_id: 'repo-c', share_files: true })] });
  await r.p.offer([workRecord({ edited: ['src/a.js'] }), workRecord({ session: 'b', repo: 'repo-b' }), workRecord({ session: 'c', repo: 'repo-c', edited: ['src/c.js'] }), workRecord({ session: 'd', repo: null })]);
  await r.p.flush();
  assert.equal(r.calls.length, 1);
  const sent = r.calls[0].body.records;
  assert.deepEqual(sent.map((x) => x.session_id), ['sess-1', 'c']);
  assert.deepEqual(sent[0].files, { edited: [], read: [] });
  assert.deepEqual(sent[1].files.edited, ['src/c.js']);
  assert.equal(r.calls[0].path, '/api/activity/v1/events');
  assert.equal(r.calls[0].body.install_id, sent[0].install_id);
  assert.equal(shareable(workRecord(), undefined), null);
});

test('idempotent: a rev already answered is not resent; only the newest rev queued', async (t) => {
  const r = rig(t);
  await r.p.offer([workRecord({ rev: 1 })]);
  await r.p.offer([workRecord({ rev: 3 })]);
  await r.p.offer([workRecord({ rev: 2 })]);
  await r.p.flush();
  assert.deepEqual(r.calls[0].body.records.map((x) => x.rev), [3]);
  await r.p.offer([workRecord({ rev: 3 })]);
  assert.equal(r.p.pending(), 0);
  await r.p.offer([workRecord({ rev: 4 })]);
  await r.p.flush();
  assert.deepEqual(r.calls.map((c) => c.body.records[0].rev), [3, 4]);
});

test('offline: backoff keeps the queue, honours Retry-After, then delivers', async (t) => {
  let up = false;
  const r = rig(t, { answer: (body) => (up ? { ok: true, status: 200, body: { results: body.records.map((x) => ({ record_id: x.record_id, status: 'applied' })) } } : { ok: false, status: 0 }) });
  await r.p.offer([workRecord()]);
  await r.p.flush();
  assert.equal(r.p.pending(), 1);
  assert.ok(r.p.stats().hold_ms >= 2000);
  await r.run(1000);
  assert.equal(r.calls.length, 1, 'waits out the backoff');
  await r.run(1500);
  assert.equal(r.calls.length, 2);
  assert.ok(r.p.stats().hold_ms >= 5000, 'backoff grows');
  up = true;
  await r.run(6000);
  await r.p.flush();
  assert.equal(r.p.pending(), 0);
  assert.equal(r.p.stats().failures, 0);
});

test('the offline queue is bounded; batches are at most 50 records', async (t) => {
  const r = rig(t, { queueMax: 120, answer: () => ({ ok: false, status: 503, retryAfter: 30_000 }) });
  await r.p.offer(Array.from({ length: 200 }, (_, i) => workRecord({ session: `s${i}` })));
  assert.equal(r.p.pending(), 120);
  assert.equal(r.p.stats().dropped, 80);
  await r.p.flush();
  assert.equal(r.calls[0].body.records.length, 50);
  assert.equal(r.calls[0].body.records[0].session_id, 's80', 'oldest dropped first');
  assert.ok(r.p.stats().hold_ms >= 30_000);
});

test('rejected records and refused batches are dropped, not retried forever', async (t) => {
  const r = rig(t, { answer: (body, n) => (n === 1 ? { ok: true, status: 200, body: { results: [{ record_id: body.records[0].record_id, status: 'rejected', reason: 'repo_not_owned' }] } } : { ok: false, status: 400 }) });
  await r.p.offer([workRecord()]);
  await r.p.flush();
  assert.equal(r.p.pending(), 0);
  await r.p.offer([workRecord()]);
  assert.equal(r.p.pending(), 0, 'the same rev is not offered again');
  await r.p.offer([workRecord({ session: 'x' })]);
  await r.p.flush();
  assert.equal(r.p.pending(), 0);
});

test('hubPoster: https only, own bearer, no redirects; refuses without a token', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, headers: new Map([['retry-after', null]]), json: async () => ({ results: [] }) }; };
  const post = hubPoster({ token: (hub) => (hub === HUB ? 'tok' : null), fetch });
  assert.equal((await post(HUB, '/api/activity/v1/events', { a: 1 })).ok, true);
  assert.equal(seen[0].url, `${HUB}/api/activity/v1/events`);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.equal((await post('http://hub.example.test', '/x', {})).reason, 'signed_out');
  assert.equal((await post('https://other.example.test', '/x', {})).reason, 'signed_out');
  assert.equal(seen.length, 1);
});
