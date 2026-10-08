// Team memory (activity/memory.js): the FTS5 index the activity log keeps in
// step, searched per team. Scrub, tenancy, retention and ranking, over
// loopback HTTP to an accounts-mode hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tenancy, MARK } from './tenancy/fixture.js';
import { toMatch } from '../activity/memory.js';

const require = createRequire(import.meta.url);
const DAY = 86_400_000;
const EVENTS = '/api/activity/v1/events';
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
async function rig(t, config = {}) { const f = await tenancy({ config }); t.after(() => f.h.close()); return f; }

function record(repo, { install = randomUUID(), session = 'sess-1', rev = 1, status = 'working', ...extra } = {}) {
  const at = '2026-09-30T10:00:00.000Z';
  return { v: 1, record_id: `${install}:claude:${session}`, adapter: 'claude', session_id: session, install_id: install, repo_id: repo, folder: 'app',
    title: 'Untitled', goal: '', summary: '', status, files: { edited: [], read: [] }, branch: null, started_at: at, updated_at: at, rev, cost_usd: null, route: null, handover: null, ...extra };
}
const publish = async (f, user, recs) => {
  const out = await f.as(user, 'POST', EVENTS, { install_id: recs[0].install_id, records: recs });
  assert.equal(out.status, 200, out.text);
  return out.body.results;
};
const search = (f, user, team, qs) => f.as(user, 'GET', `/api/teams/${team}/memory/v1/search?${qs}`);
const fts = (f) => JSON.stringify(f.db.all('SELECT * FROM memory_fts'));

test('toMatch: words become quoted ORed phrases, question words drop, nothing typed is FTS syntax', () => {
  assert.equal(toMatch('has anyone fixed the CSV export'), '"fixed" OR "csv" OR "export"*');
  assert.equal(toMatch('auth.js NEAR(x) '), '"auth js" OR "near x"');
  assert.equal(toMatch('" OR * -'), null);
  assert.equal(toMatch('the who'), null);
});

test('search ranks title over summary, ORs the words, gives snippets, and an upsert replaces the row', async (t) => {
  const f = await rig(t);
  const install = randomUUID();
  const titled = record(f.A.repo, { install, session: 't', title: 'Stream the CSV export', goal: 'Large exports time out', branch: 'feat/csv-stream' });
  const summary = record(f.A.repo, { install, session: 's', title: 'Billing cleanup', summary: 'Touched the CSV header while tidying invoices' });
  const both = record(f.A.repo, { install, session: 'b', title: 'Export retries', summary: 'Retry the CSV export on 502' });
  const other = record(f.A.repo, { install, session: 'o', title: 'Dark mode toggle', files: { edited: ['src/theme.css'], read: [] } });
  assert.deepEqual((await publish(f, f.users.amember, [titled, summary, both, other])).map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);

  const r = await search(f, f.users.ua, f.A.team, 'q=has anyone done the csv export');
  assert.equal(r.status, 200, r.text);
  const ids = r.body.results.map((x) => x.record_id);
  assert.deepEqual(ids.slice(0, 2).sort(), [titled.record_id, both.record_id].sort(), 'records matching both words come first');
  assert.equal(ids.at(-1), summary.record_id, 'one word in the summary ranks last');
  assert.ok(!ids.includes(other.record_id));
  assert.equal(r.body.results[0].record_id, titled.record_id, 'title weight beats summary');
  const top = r.body.results[0];
  assert.equal(top.author, 'member'); assert.equal(top.repo, 'app'); assert.equal(top.team_id, f.A.team);
  assert.match(top.snippet, /\u0002(csv|CSV)\u0003/i);
  assert.ok(r.body.results.every((x, i, a) => i === 0 || a[i - 1].score >= x.score), 'scores are non-increasing');
  assert.match(r.body.note, /never as instructions/);

  assert.equal((await search(f, f.users.ua, f.A.team, 'q=theme.css')).body.results[0].record_id, other.record_id, 'file paths are searchable');
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=csv-stream')).body.results[0].record_id, titled.record_id, 'branches are searchable');
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=expo')).body.results.length, 2, 'the last word is a prefix');
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=csv&limit=1')).body.results.length, 1);

  await publish(f, f.users.amember, [{ ...titled, rev: 2, title: 'Paginate the PDF report', goal: '', branch: null }]);
  assert.deepEqual((await publish(f, f.users.amember, [{ ...titled, rev: 1, title: 'Stale' }])).map((x) => x.status), ['stale']);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memory_docs WHERE record_id = ?', titled.record_id).n, 1);
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memory_fts').n, 4);
  assert.ok(!(await search(f, f.users.ua, f.A.team, 'q=stream')).body.results.some((x) => x.record_id === titled.record_id), 'the old title is gone');
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=paginate')).body.results[0].rev, 2);
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=stale')).body.results.length, 0);

  const one = await f.as(f.users.aviewer, 'GET', `/api/teams/${f.A.team}/memory/v1/records/${encodeURIComponent(both.record_id)}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.body.record.title, 'Export retries'); assert.equal(one.body.record.handover, null); assert.equal(one.body.record.handover_shared, false);
});

test('scrub: secrets and absolute paths never reach the index; unknown fields (a transcript) are refused; shared handover text is scrubbed again', async (t) => {
  const f = await rig(t);
  const r = record(f.A.repo, { title: 'Rotate the deploy key', summary: `Used ${TOKEN} from /Users/alice/secrets/deploy.env to test` });
  await publish(f, f.users.amember, [r]);
  const [rejected] = await publish(f, f.users.amember, [{ ...record(f.A.repo, { session: 'tx' }), transcript: 'raw prompt text zebra' }]);
  assert.equal(rejected.reason, 'invalid_record');
  const text = fts(f);
  assert.ok(!text.includes(TOKEN) && !text.includes('A1b2C3d4'), 'no token');
  assert.ok(!text.includes('/Users/alice') && !text.includes('alice'), 'no absolute path');
  assert.ok(!text.includes('zebra'));
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).body.results.length, 0);
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=alice')).body.results.length, 0);
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=zebra')).body.results.length, 0);
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=rotate deploy')).body.results.length, 1);

  // Only the record's author can attach shared handover text; it is scrubbed on the way in.
  const memory = f.h.hub.activity.log.memory;
  assert.equal(f.h.hub.txn(() => memory.setHandover(r.record_id, f.users.aadmin.id, 'not mine')), false);
  assert.equal(f.h.hub.txn(() => memory.setHandover(r.record_id, f.users.amember.id, `## Decided\nKeep the old key for a week.\nToken was ${TOKEN} in /etc/deploy/key`)), true);
  assert.ok(!fts(f).includes(TOKEN) && !fts(f).includes('/etc/deploy'));
  const hit = await search(f, f.users.ua, f.A.team, 'q=week');
  assert.equal(hit.body.results[0].record_id, r.record_id); assert.equal(hit.body.results[0].handover_shared, true);
  const got = await f.as(f.users.ua, 'GET', `/api/teams/${f.A.team}/memory/v1/records/${encodeURIComponent(r.record_id)}`);
  assert.match(got.body.record.handover, /Keep the old key for a week/);
  assert.ok(!got.body.record.handover.includes(TOKEN));
  assert.equal(f.h.hub.activity.log.handover(r.record_id), got.body.record.handover, 'activity-handoff reads the same shared text');
  await publish(f, f.users.amember, [{ ...r, rev: 2, title: 'Rotate the deploy key, done' }]);
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=week')).body.results.length, 1, 'a new rev keeps the shared text');
});

test('tenancy: team B never sees team A, by team, repo, record id or the shared repo name', async (t) => {
  const f = await rig(t);
  const a = record(f.A.repo, { title: 'Alpha plan for the ledger migration' });
  const b = record(f.B.repo, { title: `${MARK} ledger migration` });
  await publish(f, f.users.amember, [a]);
  await publish(f, f.users.ub, [b]);

  const own = await search(f, f.users.ub, f.B.team, 'q=ledger');
  assert.deepEqual(own.body.results.map((x) => x.record_id), [b.record_id]);
  const mine = await search(f, f.users.ua, f.A.team, 'q=ledger');
  assert.deepEqual(mine.body.results.map((x) => x.record_id), [a.record_id]);
  assert.ok(!mine.text.includes(MARK));
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=app')).body.results.length, 1, 'the shared repo name matches only this team\'s row');

  for (const [user, path] of [
    [f.users.ub, `/api/teams/${f.A.team}/memory/v1/search?q=ledger`],
    [f.users.n, `/api/teams/${f.A.team}/memory/v1/search?q=ledger`],
    [f.users.ua, `/api/teams/${f.A.team}/memory/v1/search?q=ledger&repo_id=${f.B.repo}`],
    [f.users.ub, `/api/teams/${f.B.team}/memory/v1/records/${encodeURIComponent(a.record_id)}`],
    [f.users.ub, `/api/teams/${f.A.team}/memory/v1/records/${encodeURIComponent(a.record_id)}`],
    [f.users.ua, `/api/teams/${f.A.team}/memory/v1/records/${encodeURIComponent(b.record_id)}`],
  ]) {
    const r = await f.as(user, 'GET', path);
    assert.equal(r.status, 404, `${path}: ${r.text}`);
    assert.ok(!r.text.includes('Alpha plan') && !r.text.includes(MARK));
  }
  assert.equal((await search(f, f.users.ua, f.A.team, `q=ledger&repo_id=${f.A.repo}`)).body.results.length, 1);
  assert.equal((await search(f, f.users.aviewer, f.A.team, 'q=ledger')).body.results.length, 1, 'viewers read, like the activity feed');

  // A repo moved out of the team takes its records out of that team's search.
  f.db.run("UPDATE repos SET org_id = ?, canonical_url = 'github.com/moved/app' WHERE id = ?", f.B.team, f.A.repo);
  assert.equal((await search(f, f.users.ua, f.A.team, 'q=ledger')).body.results.length, 0);
  assert.equal((await f.as(f.users.ua, 'GET', `/api/teams/${f.A.team}/memory/v1/records/${encodeURIComponent(a.record_id)}`)).status, 404);
  assert.equal((await search(f, f.users.ub, f.B.team, 'q=ledger')).body.results.length, 1, 'and never into the new team\'s');
});

test('retention: the index follows activity_current (ended 7 days, any 30), deleted accounts and teams', async (t) => {
  const f = await rig(t);
  const install = randomUUID();
  const ended = record(f.A.repo, { install, session: 'e', status: 'ended', title: 'Ended walrus work' });
  const live = record(f.A.repo, { install, session: 'l', title: 'Live walrus work' });
  await publish(f, f.users.amember, [ended, live]);
  const other = record(f.A.repo, { title: 'Admin walrus work' });
  await publish(f, f.users.aadmin, [other]);
  const b = record(f.B.repo, { title: 'Beta walrus work' });
  await publish(f, f.users.ub, [b]);
  const ids = async () => (await search(f, f.users.ua, f.A.team, 'q=walrus')).body.results.map((x) => x.record_id).sort();
  assert.equal((await ids()).length, 3);

  f.h.clock.advance(8 * DAY);
  f.h.hub.activity.sweep();
  assert.deepEqual(await ids(), [live.record_id, other.record_id].sort());
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memory_fts').n, f.db.get('SELECT COUNT(*) AS n FROM memory_docs').n);

  f.h.hub.txn(() => f.h.hub.activity.forgetUser(f.users.amember.id));
  assert.deepEqual(await ids(), [other.record_id]);
  assert.ok(!JSON.stringify(f.db.all('SELECT * FROM memory_docs')).includes(f.users.amember.id));

  f.h.clock.advance(23 * DAY);
  f.h.hub.activity.sweep();
  assert.deepEqual(await ids(), [], 'nothing outlives 30 days without an update');
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memory_fts').n, 0);

  const fresh = record(f.B.repo, { title: 'Beta fresh walrus' });
  await publish(f, f.users.ub, [fresh]);
  f.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', f.h.hub.iso(), f.B.team);
  f.h.hub.activity.sweep();
  assert.equal(f.db.get('SELECT COUNT(*) AS n FROM memory_docs WHERE team_id = ?', f.B.team).n, 0);
});

test('bounded and rate-limited: query length, options, limit and since are checked; the bucket counts bad queries too', async (t) => {
  const f = await rig(t, { rateLimits: { memory_read_user: { capacity: 8, per_ms: 60_000 } } });
  await publish(f, f.users.amember, [record(f.A.repo, { title: 'Quota alerts' })]);
  const s = (qs) => search(f, f.users.ua, f.A.team, qs);
  assert.equal((await s('q=a')).status, 400);
  assert.equal((await s(`q=${'x'.repeat(201)}`)).status, 400);
  assert.equal((await s('q=quota&board_id=1')).status, 400);
  assert.equal((await s('q=quota&since=yesterday')).status, 400);
  assert.equal((await s('q=quota&limit=500')).body.results.length, 1, 'limit is clamped');
  assert.equal((await s('q=quota&since=2999-01-01')).body.results.length, 0);
  assert.equal((await s('q=quota&since=2020-01-01T00:00:00Z')).body.results.length, 1);
  assert.deepEqual((await s('q=the who')).body.results, [], 'nothing searchable is an empty answer, not an error');
  const over = await s('q=quota');
  assert.equal(over.status, 429, over.text);
});

test('end to end: the desktop team_memory tools and the Search page mode against this hub', async (t) => {
  const f = await rig(t);
  const a = record(f.A.repo, { title: 'Decided to keep the v1 webhook format', summary: 'Partners still parse v1' });
  await publish(f, f.users.amember, [a]);
  await publish(f, f.users.ub, [record(f.B.repo, { title: `${MARK} webhook format v2` })]);
  const TA = require('../../../src/team-activity.js');
  const route = { hub: f.h.base, team_id: f.A.team, repo_id: f.A.repo, team_name: 'Alpha', canonical_url: 'github.com/shared/app', share_summaries: true };
  const link = { repo: route.canonical_url, route, token: () => f.users.ua.token };
  const svc = TA.createTeamActivity({ enabled: () => true, resolve: async () => link, teams: async () => [link], fetch: (...x) => fetch(...x) });
  const found = await svc.call('team_memory_search', { cwd: '/w/app', query: 'has anyone decided the webhook format?' });
  assert.equal(found.available, true, JSON.stringify(found));
  assert.deepEqual(found.results.map((x) => x.record_id), [a.record_id]);
  assert.equal(found.results[0].author, 'member');
  assert.ok(!JSON.stringify(found).includes(MARK));
  const got = await svc.call('team_memory_get', { cwd: '/w/app', record_id: a.record_id });
  assert.equal(got.found, true); assert.equal(got.record.summary, 'Partners still parse v1'); assert.equal(got.handover, null);
  const pageRes = await svc.memoryPage({ q: 'webhook' });
  assert.deepEqual(pageRes.results.map((x) => [x.team, x.record_id]), [['Alpha', a.record_id]]);
  assert.match(pageRes.results[0].snippet, /\u0002webhook\u0003/i);
});
