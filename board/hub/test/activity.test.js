// Team activity log (docs/TEAM-CONTEXT-CONTRACT.md, activity/): publish,
// idempotent upsert by rev, team/repo authority, feed, current, collisions,
// retention and the SSE stream, over loopback HTTP to an accounts-mode hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tenancy, MARK } from './tenancy/fixture.js';

const require = createRequire(import.meta.url);
const DAY = 86_400_000;
const EVENTS = '/api/activity/v1/events';
async function rig(t, config = {}) { const f = await tenancy({ config }); t.after(() => f.h.close()); return f; }

function record(repo, { install = randomUUID(), session = 'sess-1', adapter = 'claude', rev = 1, status = 'working', edited = [], ...extra } = {}) {
  const at = '2026-09-30T10:00:00.000Z';
  return { v: 1, record_id: `${install}:${adapter}:${session}`, adapter, session_id: session, install_id: install, repo_id: repo, folder: 'app',
    title: 'Fix the export', goal: 'Make CSV export stream', summary: 'Rewrote the writer', status, files: { edited, read: [] }, branch: 'feat/export',
    started_at: at, updated_at: at, rev, cost_usd: 0.42, route: 'primary', handover: null, ...extra };
}
const post = (f, user, records, install = records[0]?.install_id) => f.as(user, 'POST', EVENTS, { install_id: install, records });

test('a writer publishes a record; teammates read it by display name; another team sees nothing', async (t) => {
  const f = await rig(t);
  const r = record(f.A.repo);
  const out = await post(f, f.users.amember, [r]);
  assert.equal(out.status, 200, out.text);
  assert.equal(out.body.results[0].status, 'applied');
  const feed = await f.as(f.users.ua, 'GET', `/api/activity/v1/feed?repo_id=${f.A.repo}`);
  assert.equal(feed.status, 200, feed.text);
  assert.equal(feed.body.events.length, 1);
  const [e] = feed.body.events;
  assert.equal(e.type, 'record.upsert'); assert.equal(e.author, 'member'); assert.equal(e.record.title, 'Fix the export');
  assert.equal(feed.body.next_seq, e.seq);
  assert.equal((await f.as(f.users.aviewer, 'GET', '/api/activity/v1/feed')).body.events.length, 1, 'a viewer reads');
  assert.equal((await f.as(f.users.ub, 'GET', '/api/activity/v1/feed')).body.events.length, 0);
  assert.equal((await f.as(f.users.ub, 'GET', `/api/activity/v1/feed?repo_id=${f.A.repo}`)).status, 404);
  assert.equal((await f.as(f.users.n, 'GET', '/api/activity/v1/current')).body.records.length, 0);
  const cur = await f.as(f.users.aadmin, 'GET', `/api/activity/v1/current?repo_id=${f.A.repo}`);
  assert.equal(cur.body.records.length, 1); assert.equal(cur.body.records[0].record_id, r.record_id); assert.equal(cur.body.records[0].author, 'member');
  assert.equal((await f.as(f.users.ua, 'GET', `/api/activity/v1/feed?after=${e.seq}`)).body.events.length, 0, 'cursor resumes after seq');
  assert.ok(!JSON.stringify(feed.body).includes(MARK));
});

test('upsert is idempotent by record_id and rev; ended appends record.end', async (t) => {
  const f = await rig(t);
  const r = record(f.A.repo);
  await post(f, f.users.amember, [r]);
  assert.equal((await post(f, f.users.amember, [r])).body.results[0].status, 'stale');
  assert.equal((await post(f, f.users.amember, [{ ...r, rev: 0 }])).body.results[0].status, 'stale');
  assert.equal((await post(f, f.users.amember, [{ ...r, rev: 2, title: 'Second' }])).body.results[0].status, 'applied');
  assert.equal((await post(f, f.users.amember, [{ ...r, rev: 3, status: 'ended' }])).body.results[0].status, 'applied');
  const types = (await f.as(f.users.ua, 'GET', '/api/activity/v1/feed')).body.events.map((e) => e.type);
  assert.deepEqual(types, ['record.upsert', 'record.upsert', 'record.end']);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM activity_current').n, 1);
  assert.equal((await f.as(f.users.ua, 'GET', '/api/activity/v1/current')).body.records[0].status, 'ended');
});

test('records for repos the team does not own, by viewers, or hijacking another account\'s record_id are rejected per record', async (t) => {
  const f = await rig(t);
  const install = randomUUID();
  const out = await post(f, f.users.amember, [
    record(f.B.repo, { install, session: 'b' }),
    record(f.A.repo, { install, session: 'ok' }),
    { ...record(f.A.repo, { install, session: 'x' }), record_id: `${install}:claude:other` },
    { ...record(f.A.repo, { install, session: 'k' }), secret: 1 },
    record(f.A.repo, { install, session: 'p', edited: ['/etc/passwd'] }),
    record(f.A.repo, { install, session: 'q', folder: 'Users/me/app' }),
    record(null, { install, session: 'n' }),
  ], install);
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.body.results.map((r) => r.reason ?? r.status),
    ['repo_not_owned', 'applied', 'invalid_record_id', 'invalid_record', 'invalid_path', 'invalid_folder', 'no_repo']);
  assert.equal((await post(f, f.users.aviewer, [record(f.A.repo)])).body.results[0].reason, 'repo_not_owned');
  const mine = record(f.A.repo, { install, session: 'ok', rev: 5 });
  assert.equal((await post(f, f.users.aadmin, [mine], install)).body.results[0].reason, 'record_not_yours');
  assert.equal((await post(f, f.users.amember, [record(f.A.repo)], randomUUID())).body.results[0].reason, 'install_mismatch');
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM activity_events WHERE repo_id = ?", f.B.repo).n, 0);
});

test('batch and body size limits; device sign-in required to publish', async (t) => {
  const f = await rig(t);
  const install = randomUUID();
  const many = Array.from({ length: 51 }, (_, i) => record(f.A.repo, { install, session: `s${i}` }));
  assert.equal((await post(f, f.users.amember, many, install)).status, 413);
  const big = [record(f.A.repo, { install, summary: 'x'.repeat(300 * 1024) })];
  assert.equal((await post(f, f.users.amember, big, install)).status, 413);
  assert.equal((await post(f, f.users.amember, [record(f.A.repo, { install, summary: 'x'.repeat(1501) })], install)).body.results[0].reason, 'text_too_long');
  const web = await f.h.webSignIn(f.users.amember.email);
  const r = await f.h.call('POST', EVENTS, { cookie: web.cookie, body: { install_id: install, records: [record(f.A.repo, { install })] }, headers: { origin: f.h.base, 'x-csrf-token': web.csrf } });
  assert.equal(r.status, 403, r.text);
  const read = await f.h.call('GET', '/api/activity/v1/feed', { cookie: web.cookie });
  assert.equal(read.status, 200, 'a web session can read');
  assert.equal((await f.h.call('GET', '/api/activity/v1/feed')).status, 401);
});

test('collisions: overlapping edited paths among working records of one repo, once per new overlap', async (t) => {
  const f = await rig(t);
  const a = record(f.A.repo, { edited: ['src/a.js', 'src/b.js'] });
  const b = record(f.A.repo, { edited: ['src/b.js', 'src/c.js'] });
  await post(f, f.users.amember, [a]);
  const out = await post(f, f.users.aadmin, [b]);
  assert.equal(out.body.results[0].collisions, 1);
  let feed = (await f.as(f.users.ua, 'GET', '/api/activity/v1/feed')).body.events.filter((e) => e.type === 'collision');
  assert.equal(feed.length, 1);
  assert.deepEqual([feed[0].path, feed[0].records, feed[0].people], ['src/b.js', [b.record_id, a.record_id], ['admin', 'member']]);
  await post(f, f.users.aadmin, [{ ...b, rev: 2 }]);
  await post(f, f.users.amember, [{ ...a, rev: 2, edited: undefined, files: { edited: ['src/a.js', 'src/b.js', 'src/c.js'], read: [] } }]);
  feed = (await f.as(f.users.ua, 'GET', '/api/activity/v1/feed')).body.events.filter((e) => e.type === 'collision');
  assert.deepEqual(feed.map((e) => e.path), ['src/b.js', 'src/c.js'], 'only the new overlap is flagged');
  await post(f, f.users.aadmin, [{ ...b, rev: 3, status: 'review' }]);
  await post(f, f.users.amember, [{ ...a, rev: 3, files: { edited: ['src/b.js'], read: [] } }]);
  assert.equal((await f.as(f.users.ua, 'GET', '/api/activity/v1/feed')).body.events.filter((e) => e.type === 'collision').length, 2, 'not against a record in review');
  const noFiles = await post(f, f.users.ua, [record(f.A.repo)]);
  assert.equal(noFiles.body.results[0].collisions, undefined, 'never without file paths');
  const other = await post(f, f.users.s, [record(f.A.repo, { edited: ['src/b.js'] })]);
  assert.equal(other.body.results[0].collisions, 1, 'collides only with live records');
});

test('retention: ended current rows after 7 days, events after 30; deleted accounts are forgotten', async (t) => {
  const f = await rig(t);
  const ended = record(f.A.repo, { session: 'e', status: 'ended' });
  const live = record(f.A.repo, { session: 'l' });
  await post(f, f.users.amember, [ended]);
  await post(f, f.users.amember, [live]);
  f.h.clock.advance(8 * DAY);
  f.h.hub.activity.sweep();
  assert.deepEqual(f.db.all('SELECT record_id FROM activity_current').map((r) => r.record_id), [live.record_id]);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM activity_events').n, 2);
  f.h.clock.advance(23 * DAY);
  f.h.hub.activity.sweep();
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM activity_events').n, 0);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM activity_current').n, 0);
  const fresh = await post(f, f.users.amember, [record(f.A.repo, { edited: ['x.js'] })]);
  assert.equal(fresh.status, 200);
  await post(f, f.users.aadmin, [record(f.A.repo, { edited: ['x.js'] })]);
  const truncated = await f.as(f.users.ua, 'GET', '/api/activity/v1/feed?after=1');
  assert.equal(truncated.body.truncated, true);
  f.h.hub.txn(() => f.h.hub.activity.forgetUser(f.users.amember.id));
  const left = JSON.stringify([f.db.all('SELECT * FROM activity_events'), f.db.all('SELECT * FROM activity_current')]);
  assert.ok(!left.includes(f.users.amember.id), 'nothing names the deleted account');
  assert.ok(left.includes(f.users.aadmin.id));
});

// A minimal SSE reader over fetch.
async function sse(f, user, query = '', headers = {}) {
  const ctl = new AbortController();
  const res = await fetch(`${f.h.base}/api/activity/v1/stream${query}`, { headers: { authorization: `Bearer ${user.token}`, origin: f.h.base, ...headers }, signal: ctl.signal });
  const out = { status: res.status, headers: res.headers, events: [], comments: 0, ended: false, waiters: [] };
  if (res.status !== 200) { out.text = await res.text(); return out; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) { out.comments++; continue; }
          const ev = {};
          for (const line of block.split('\n')) { const k = line.slice(0, line.indexOf(':')); ev[k] = line.slice(line.indexOf(':') + 2); }
          if (ev.data) out.events.push({ id: Number(ev.id), type: ev.event, data: JSON.parse(ev.data) });
        }
        for (const w of out.waiters.splice(0)) w();
      }
    } catch { /* aborted */ }
    out.ended = true;
    for (const w of out.waiters.splice(0)) w();
  })();
  out.until = async (pred, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!pred(out)) {
      if (Date.now() > deadline) throw new Error(`timed out; events=${JSON.stringify(out.events.map((e) => e.type))} ended=${out.ended}`);
      await new Promise((r) => { out.waiters.push(r); setTimeout(r, 50); });
    }
  };
  out.close = () => ctl.abort();
  return out;
}

test('stream: live events, Last-Event-ID resume, heartbeat, and it ends when membership ends', async (t) => {
  const f = await rig(t, { activityLimits: { heartbeatMs: 60 } });
  const s = await sse(f, f.users.ua, '?after=0');
  t.after(() => s.close());
  assert.equal(s.status, 200, s.text);
  assert.match(s.headers.get('content-type'), /text\/event-stream/);
  const r1 = record(f.A.repo, { session: 'one' });
  await post(f, f.users.amember, [r1]);
  await s.until((x) => x.events.length >= 1);
  assert.equal(s.events[0].type, 'record.upsert'); assert.equal(s.events[0].data.record.record_id, r1.record_id);
  await post(f, f.users.ub, [record(f.B.repo, { session: 'beta' })]);
  const r2 = record(f.A.repo, { session: 'two' });
  await post(f, f.users.amember, [r2]);
  await s.until((x) => x.events.length >= 2);
  assert.deepEqual(s.events.map((e) => e.data.record.record_id), [r1.record_id, r2.record_id], 'never another team\'s events');
  await s.until((x) => x.comments >= 1);
  s.close();

  const resumed = await sse(f, f.users.ua, '?after=0', { 'last-event-id': String(s.events[0].id) });
  t.after(() => resumed.close());
  await resumed.until((x) => x.events.length >= 1);
  assert.equal(resumed.events[0].data.record.record_id, r2.record_id);

  const scoped = await sse(f, f.users.s, `?repo_id=${f.A.repo}`);
  t.after(() => scoped.close());
  f.db.run('UPDATE members SET removed_at = ? WHERE id = ?', f.h.hub.iso(), f.A.s);
  await scoped.until((x) => x.ended);
  assert.equal((await sse(f, f.users.ub, `?repo_id=${f.A.repo}`)).status, 404);
});

test('stream: at most a few open streams per user', async (t) => {
  const f = await rig(t, { activityLimits: { streamsPerUser: 2 } });
  const a = await sse(f, f.users.ua); const b = await sse(f, f.users.ua);
  t.after(() => { a.close(); b.close(); });
  const c = await sse(f, f.users.ua);
  assert.equal(c.status, 429);
});

test('end to end: the desktop publisher and stream against this hub, with a collision alert', async (t) => {
  const { createActivityPublisher, hubPoster } = require('../../../src/activity-publisher.js');
  const { createActivityStream } = require('../../../src/activity-stream.js');
  const f = await rig(t);
  const route = { hub: f.h.base, team_id: f.A.team, repo_id: f.A.repo, share_summaries: true, share_files: true };
  const publisher = (u) => createActivityPublisher({ getRoutes: async () => ({ routes: [route], complete: true }), post: hubPoster({ token: () => u.token }), debounceMs: 1 });
  const pa = publisher(f.users.amember), pb = publisher(f.users.aadmin);
  t.after(() => { pa.stop(); pb.stop(); });
  const got = [];
  const stream = createActivityStream({ hubs: () => [{ origin: f.h.base, token: () => f.users.ua.token }], onEvent: (o, e) => got.push(e) });
  t.after(() => stream.stop());
  stream.start();
  for (let i = 0; i < 100 && stream.state()[0]?.state !== 'open'; i++) await new Promise((r) => setTimeout(r, 10));
  const a = record(f.A.repo, { edited: ['src/shared.js'] }), b = record(f.A.repo, { edited: ['src/shared.js'] });
  await pa.offer([a]); await pa.flush();
  await pb.offer([b, record(f.B.repo)]); await pb.flush();
  for (let i = 0; i < 200 && !got.some((e) => e.type === 'collision'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got.map((e) => e.type), ['record.upsert', 'record.upsert', 'collision']);
  assert.deepEqual(got[2].people, ['admin', 'member']);
  assert.equal(got[2].path, 'src/shared.js');
  assert.equal(pa.pending() + pb.pending(), 0);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM activity_current').n, 2, 'the record for an unshared repo never left');
});
