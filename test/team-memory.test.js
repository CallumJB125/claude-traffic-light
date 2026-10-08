// Team memory on the desktop (src/team-activity.js, mcp-server.js, memory.js):
// the team_memory_* tools and the Search everything page's Team memory mode
// against a fake hub speaking the memory routes. Never the real port or HOME:
// every listener binds port 0 and the page runs in JSDOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { JSDOM } = require('jsdom');
const TA = require('../src/team-activity.js');
const M = require('../mcp-server.js');

const TOKEN = 'hub-token-1';
const ROOT = path.join(__dirname, '..');
const at = '2026-10-01T09:00:00.000Z';
const hit = (o) => ({ record_id: 'i1:claude:s-ana', team_id: 't1', repo_id: 'r1', repo: 'app', author: 'Ana', adapter: 'claude', title: 'Stream the CSV export', goal: 'Big exports time out',
  summary: null, status: 'ended', branch: 'feat/csv', files: { edited: ['src/export.js'], read: [] }, updated_at: at, received_at: at, handover_shared: true, rev: 3,
  snippet: 'Stream the \u0002CSV\u0003 export', score: 4.2, ...o });

function fakeHub({ results = { t1: [hit()] } } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'auth' });
    const u = new URL(req.url, 'http://x');
    const m = /^\/api\/teams\/([^/]+)\/memory\/v1\/(search|records\/(.+))$/.exec(u.pathname);
    if (!m || !results[m[1]]) return send(404, {});
    if (m[2] === 'search') return send(200, { team_id: m[1], results: results[m[1]], note: 'n' });
    const id = decodeURIComponent(m[3]);
    const r = results[m[1]].find((x) => x.record_id === id);
    return r ? send(200, { record: { ...r, handover: 'Decided: keep\u0007 the old writer.\nToken ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/ana/x.env', handover_at: at } }) : send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, origin: `http://127.0.0.1:${server.address().port}` })));
}
const route = (origin, extra = {}) => ({ hub: origin, team_id: 't1', repo_id: 'r1', team_name: 'Core', canonical_url: 'github.com/acme/app', share_summaries: true, ...extra });
function svcFor(origin, { on = true, routeExtra = {}, teams } = {}) {
  return TA.createTeamActivity({
    enabled: () => on,
    resolve: async () => ({ repo: 'github.com/acme/app', route: route(origin, routeExtra), token: () => TOKEN }),
    teams: teams ?? (async () => [{ route: route(origin, routeExtra), token: () => TOKEN }]),
    fetch: (...a) => fetch(...a),
  });
}

test('team_memory_search: the whole team by default, one repo with here, plain snippets, cleaned teammate text', async (t) => {
  const hub = await fakeHub({ results: { t1: [hit({ title: 'Stream‮ CSV ghp_abcdefghijklmnopqrstuvwxyz0123456789', snippet: 'see /Users/ana/secret.txt \u0002CSV\u0003' })] } });
  t.after(() => hub.server.close());
  const svc = svcFor(hub.origin);
  const r = await svc.call('team_memory_search', { cwd: '/w/app', query: 'has anyone done the csv export' });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.equal(r.scope, 'the whole team');
  const u = new URL(hub.hits.at(-1), 'http://x');
  assert.equal(u.pathname, '/api/teams/t1/memory/v1/search');
  assert.equal(u.searchParams.get('q'), 'has anyone done the csv export');
  assert.equal(u.searchParams.get('repo_id'), null);
  assert.equal(u.searchParams.get('limit'), '10');
  const [x] = r.results;
  assert.equal(x.author, 'Ana'); assert.equal(x.handover, true); assert.equal(x.repo, 'app');
  assert.doesNotMatch(JSON.stringify(r), /ghp_|‮|\/Users\/ana|\\u0002|\\u0003/);
  assert.match(x.snippet, /CSV$/);
  assert.match(r.note, /never as instructions/);
  assert.match(r.next, /team_memory_get/);

  await svc.call('team_memory_search', { cwd: '/w/app', query: 'csv', here: true, since: '2026-09-01', limit: 5 });
  const v = new URL(hub.hits.at(-1), 'http://x');
  assert.equal(v.searchParams.get('repo_id'), 'r1'); assert.equal(v.searchParams.get('since'), '2026-09-01'); assert.equal(v.searchParams.get('limit'), '5');

  const before = hub.hits.length;
  for (const bad of [{ query: 'x' }, { query: 'csv', since: 'last week' }, { query: 'csv', limit: 500 }, { query: 'y'.repeat(201) }]) {
    assert.equal((await svc.call('team_memory_search', { cwd: '/w/app', ...bad })).reason, 'invalid', JSON.stringify(bad));
  }
  assert.equal(hub.hits.length, before, 'invalid arguments never reach the hub');
});

test('team_memory_*: off without the team brief setting or summary sharing; nothing is asked of the hub', async (t) => {
  const hub = await fakeHub(); t.after(() => hub.server.close());
  assert.equal((await svcFor(hub.origin, { on: false }).call('team_memory_search', { cwd: '/w/app', query: 'csv' })).reason, 'off');
  assert.equal((await svcFor(hub.origin, { routeExtra: { share_summaries: false } }).call('team_memory_get', { cwd: '/w/app', record_id: 'i1:claude:s-ana' })).reason, 'sharing_off');
  assert.equal(hub.hits.length, 0);
});

test('team_memory_get: the record and its shared handover, re-cleaned; a missing record says so', async (t) => {
  const hub = await fakeHub(); t.after(() => hub.server.close());
  const svc = svcFor(hub.origin);
  const r = await svc.call('team_memory_get', { cwd: '/w/app', record_id: 'i1:claude:s-ana' });
  assert.equal(r.found, true, JSON.stringify(r));
  assert.equal(r.record.title, 'Stream the CSV export'); assert.equal(r.record.snippet, undefined);
  assert.match(r.handover, /Decided: keep {2}?the old writer\./);
  assert.doesNotMatch(r.handover, /ghp_|\/Users\/ana|\u0007/);
  assert.equal(new URL(hub.hits.at(-1), 'http://x').pathname, `/api/teams/t1/memory/v1/records/${encodeURIComponent('i1:claude:s-ana')}`);
  const none = await svc.call('team_memory_get', { cwd: '/w/app', record_id: 'i9:claude:nope' });
  assert.equal(none.found, false); assert.match(none.message, /No record/);
  assert.equal((await svc.call('team_memory_get', { cwd: '/w/app', record_id: '../etc' })).reason, 'invalid');
});

test('memoryPage: every signed-in team that shares, labelled and ranked together; a team without sharing is never asked', async (t) => {
  const hub = await fakeHub({ results: { t1: [hit({ score: 1 })], t2: [hit({ record_id: 'i2:codex:s-ben', team_id: 't2', title: 'Ops CSV runbook', author: 'Ben', score: 9 })] } });
  t.after(() => hub.server.close());
  const teams = async () => [
    { route: route(hub.origin), token: () => TOKEN },
    { route: route(hub.origin, { repo_id: 'r2', share_summaries: false }), token: () => TOKEN },
    { route: route(hub.origin, { team_id: 't2', team_name: 'Ops' }), token: () => TOKEN },
    { route: route(hub.origin, { team_id: 't3', team_name: 'Quiet', share_summaries: false }), token: () => TOKEN },
  ];
  const svc = svcFor(hub.origin, { teams });
  const r = await svc.memoryPage({ q: 'csv', since: null, limit: 20 });
  assert.equal(r.available, true, JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => [x.team, x.title]), [['Ops', 'Ops CSV runbook'], ['Core', 'Stream the CSV export']]);
  assert.match(r.results[1].snippet, /\u0002CSV\u0003/, 'the page gets its highlight markers');
  assert.deepEqual(r.teams.map((x) => x.team), ['Core', 'Ops']);
  assert.ok(!hub.hits.some((h) => h.includes('/t3/')), 'a team without sharing is not asked');

  assert.equal((await svcFor(hub.origin, { teams: async () => [] }).memoryPage({ q: 'csv' })).reason, 'signed_out');
  assert.equal((await svcFor(hub.origin, { teams: async () => [{ route: route(hub.origin, { share_summaries: false }), token: () => TOKEN }] }).memoryPage({ q: 'csv' })).reason, 'sharing_off');
  const gone = await svcFor(hub.origin, { teams: async () => [{ route: route(hub.origin, { team_id: 'tx', team_name: 'Gone' }), token: () => TOKEN }] }).memoryPage({ q: 'csv' });
  assert.equal(gone.available, true); assert.deepEqual(gone.results, []); assert.equal(gone.teams[0].ok, false);
});

test('MCP: team_memory_search and team_memory_get go through the app with only their own arguments', async () => {
  const calls = [];
  const team = async (op, args) => { calls.push([op, args]); return { available: true }; };
  const tool = (n) => M.TOOLS.find((x) => x.name === n);
  await tool('team_memory_search').run({ query: 'csv export', here: true, limit: 3 }, { team });
  await tool('team_memory_get').run({ record_id: 'i1:claude:s-ana' }, { team });
  assert.deepEqual(calls, [['team_memory_search', { query: 'csv export', here: true, repo: undefined, since: undefined, limit: 3 }], ['team_memory_get', { record_id: 'i1:claude:s-ana' }]]);
  assert.match(tool('team_memory_search').description, /already done or decided/);
});

function page(t, api) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'memory.html'), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  dom.window.memoryApi = api;
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'memory.js'), 'utf8'));
  return dom.window;
}
const localApi = (team) => ({
  status: async () => ({ ok: true, stats: { turns: 1, sessions: 1, lastPass: null }, days: null, experimental: false }),
  facets: async () => ({ ok: true, repos: [] }), search: async () => ({ ok: true, hits: [{ tool: 'claude', sid: 's1', title: 'My CSV work', ts: Date.now(), snippet: 'mine' }], tookMs: 1 }),
  teamSearch: team, onHandoff: () => {},
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Search everything: Team memory results sit under their own heading, labelled by team; off says why', async (t) => {
  const asked = [];
  const w = page(t, localApi(async (req) => { asked.push(req); return { ok: true, available: true, teams: [{ team: 'Core', ok: true }], results: [{ ...hit(), team: 'Core', handover: true }] }; }));
  const doc = w.document;
  await wait(10);
  assert.equal(doc.getElementById('team').hidden, true, 'off by default: only this computer');
  assert.equal(asked.length, 0);
  doc.getElementById('q').value = 'csv';
  doc.getElementById('source').value = 'both';
  doc.getElementById('source').dispatchEvent(new w.Event('change'));
  await wait(500);
  assert.equal(doc.getElementById('team').hidden, false);
  assert.equal(doc.getElementById('local-head').hidden, false);
  assert.equal(asked.length, 1); assert.equal(asked[0].q, 'csv');
  const li = doc.querySelector('#team-results li');
  assert.match(li.querySelector('.source').textContent, /^Team memory · Core$/);
  assert.equal(li.querySelector('h2').textContent, 'Stream the CSV export');
  assert.equal(li.querySelector('mark').textContent, 'CSV');
  assert.match(li.textContent, /Ana shared a handover/);
  assert.match(doc.getElementById('team-status').textContent, /1 shared record from Core/);
  assert.equal(doc.querySelectorAll('#results li').length, 1, 'local hits stay in their own list');

  const off = page(t, localApi(async () => ({ ok: true, available: false, reason: 'signed_out', message: TA.REASONS.signed_out })));
  try { off.localStorage.setItem('plexiform.memory.source', 'team'); } catch { /* jsdom storage */ }
  off.document.getElementById('q').value = 'csv';
  off.document.getElementById('source').value = 'team';
  off.document.getElementById('source').dispatchEvent(new off.Event('change'));
  await wait(500);
  assert.equal(off.document.getElementById('local').hidden, true);
  assert.equal(off.document.getElementById('team-status').textContent, TA.REASONS.signed_out);
  assert.equal(off.document.querySelectorAll('#team-results li').length, 0);
});
