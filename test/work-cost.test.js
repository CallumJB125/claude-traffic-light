const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WorkCost = require('../src/work-cost.js');
const Usage = require('../usage.js');
const { createWorkCapture } = require('../src/work-capture.js');

const NOW = new Date(2026, 9, 20, 12).getTime();
const DAY = 86400000;
let n = 0;
const turn = (over) => ({ id: `t${n++}`, ts: NOW - 3600000, sessionId: 's-card', cwd: '/w/app', project: 'app', branch: 'feat/login', model: 'claude-sonnet-4-5', modelKey: 'sonnet', subagent: false, input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300, cacheWrite1h: 0, ...over });
const priced = (t) => Usage.costOf(t);
const task = (over) => ({ provider: 'claude', session_id: 's-card', task_id: 'session', card_id: 'card-1', title: 'Claude Code · app', repo: 'github.com/o/app', pr: { number: 42, url: 'https://github.com/o/app/pull/42' }, last_seen: NOW - 3600000, ...over });
const record = (over) => ({ adapter: 'claude', session_id: 's-card', title: 'Fix the login redirect', branch: 'feat/login', ...over });

test('attribution: a session\'s turns join to its captured card, with the record\'s title, branch and the card\'s PR', () => {
  const turns = [turn(), turn({ ts: NOW - 2 * DAY }), turn({ sessionId: 's-other', project: 'site', branch: 'main' })];
  const r = WorkCost.attribute({ turns, tasks: [task()], records: [record()], now: NOW });
  const card = r.week.items.find((x) => x.kind === 'card');
  assert.equal(card.title, 'Fix the login redirect');
  assert.equal(card.branch, 'feat/login');
  assert.deepEqual(card.pr, { number: 42, url: 'https://github.com/o/app/pull/42' });
  assert.equal(card.toolLabel, 'Claude Code');
  assert.ok(Math.abs(card.usd - 2 * priced(turns[0])) < 1e-4);
  assert.equal(card.sessions, 1);
  const loose = r.week.items.find((x) => x.kind === 'branch');
  assert.equal(loose.title, 'site · main', 'no card: project and the branch Claude Code recorded');
  assert.ok(Math.abs(r.week.total.usd - 3 * priced(turns[0])) < 1e-4);
  assert.ok(Math.abs(r.week.total.onCards - card.usd) < 1e-4);
  assert.equal(r.week.total.unpriced, 0);
  assert.match(r.basis, /API-price equivalent/);
});

test('attribution: two sessions captured as one card add up; the week and month windows count separately', () => {
  const lastMonth = new Date(2026, 8, 30, 12).getTime();
  const turns = [turn(), turn({ sessionId: 's-two' }), turn({ ts: NOW - 15 * DAY }), turn({ ts: lastMonth })];
  const r = WorkCost.attribute({ turns, tasks: [task(), task({ session_id: 's-two', task_id: 't2' })], records: [], now: NOW });
  const week = r.week.items.find((x) => x.card_id === 'card-1');
  const month = r.month.items.find((x) => x.card_id === 'card-1');
  assert.equal(week.sessions, 2);
  assert.ok(Math.abs(week.usd - 2 * priced(turns[0])) < 1e-4, 'the 15-day-old turn is outside the week');
  assert.ok(Math.abs(month.usd - 3 * priced(turns[0])) < 1e-4, 'September is outside October');
  assert.equal(r.month.label, 'October 2026');
});

test('unpriced: requests on a model with no price are counted, never priced, and flagged on the item, tool and total', () => {
  const turns = [turn(), turn({ model: 'gpt-x', modelKey: null }), turn({ model: 'gpt-x', modelKey: null })];
  const r = WorkCost.attribute({ turns, tasks: [task()], records: [], now: NOW });
  const card = r.week.items[0];
  assert.equal(card.unpriced, 2);
  assert.ok(Math.abs(card.usd - priced(turns[0])) < 1e-4);
  assert.equal(r.week.total.unpriced, 2);
  assert.equal(r.week.byTool[0].unpriced, 2);
  assert.equal(WorkCost.unpricedText(2), '2 requests could not be priced');
  assert.equal(WorkCost.unpricedText(1), '1 request could not be priced');
  assert.equal(WorkCost.unpricedText(0), '');
});

test('per tool: a Codex card has no local token counts, so it is listed without a price rather than as $0', () => {
  const r = WorkCost.attribute({ turns: [turn()], tasks: [task(), task({ provider: 'codex', session_id: 'thread-9', card_id: 'card-9', title: 'Codex · api', pr: null })], records: [], now: NOW });
  const codex = r.week.items.find((x) => x.tool === 'codex');
  assert.equal(codex.usd, null);
  assert.deepEqual(r.week.byTool.map((g) => [g.label, g.usd === null]), [['Claude Code', false], ['Codex', true]]);
  assert.deepEqual(r.week.total.unpricedTools, ['Codex']);
  assert.equal(r.week.items.at(-1).tool, 'codex', 'unpriced work sorts after priced work');
});

test('top lists keep 10; ranking is by cost', () => {
  const turns = Array.from({ length: 12 }, (_, i) => turn({ sessionId: `s${i}`, project: `p${i}`, branch: null, output: 1000 * (i + 1) }));
  const r = WorkCost.attribute({ turns, now: NOW });
  assert.equal(r.week.top.length, 10);
  assert.equal(r.week.items.length, 12);
  assert.equal(r.week.top[0].title, 'p11');
  assert.equal(r.week.top[0].kind, 'project');
});

test('sessionSpend: whole-session cost and unpriced count for Claude Code only', () => {
  const turns = [turn(), turn(), turn({ model: 'gpt-x', modelKey: null }), turn({ sessionId: 'x' })];
  const s = WorkCost.sessionSpend(turns, { provider: 'claude', session_id: 's-card' });
  assert.ok(Math.abs(s.cost_usd - 2 * priced(turns[0])) < 1e-4);
  assert.equal(s.unpriced, 1);
  assert.equal(WorkCost.sessionSpend(turns, { provider: 'codex', session_id: 's-card' }), null);
  assert.equal(WorkCost.sessionSpend(turns, { provider: 'claude', session_id: 'missing' }), null);
  assert.equal(WorkCost.sessionSpend(null, { provider: 'claude', session_id: 's-card' }), null);
});

test('CSV: both windows, every item, quoted, formula cells defused, unpriced column present', () => {
  const r = WorkCost.attribute({ turns: [turn(), turn({ model: 'gpt-x', modelKey: null })], tasks: [task()], records: [record({ title: '=HYPERLINK("x"), "quoted"' })], now: NOW });
  const csv = WorkCost.toCsv(r);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'window,kind,title,tool,repo,branch,pr_number,pr_url,card_id,sessions,cost_usd_api_equivalent,unpriced_requests');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^Last 7 days,card,"'=HYPERLINK\(""x""\), ""quoted""",Claude Code,github.com\/o\/app,feat\/login,42,https:\/\/github.com\/o\/app\/pull\/42,card-1,1,\d+\.\d{4},1$/);
  assert.match(lines[2], /^October 2026,card,/);
});

test('work capture: a local card report carries the session cost, a team report never does; the card PR is kept for cost rows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const R = { hub: 'https://hub.example.test', user_id: 'user-a', team_id: 'team-a', board_id: 'board-a', repo_id: 'repo-a', canonical_url: 'github.com/org/app', role: 'member' };
  const time = 100000;
  const make = (file, resolveRepo) => createWorkCapture({
    startEnabled: true, file: path.join(dir, file), host: 'mac', now: () => time, getRoutes: async () => ({ routes: [R], complete: true }), resolveRepo,
    spendFor: (o) => ({ cost_usd: 3.456, unpriced: 2, session: o.session_id }),
    sendLocal: async (body) => { calls.push({ kind: 'local', body }); return { ok: true, card: { id: 'local-card', pr: { number: 7, url: 'https://github.com/org/app/pull/7', state: 'open' } } }; },
    sendTeam: async (destination, body) => { calls.push({ kind: 'team', body }); return { ok: true, card: { id: 'team-card' } }; },
  });
  const event = { source: 'claude', sessionId: 'sess-1', host: 'mac', cwd: '/working/app', signal: 'tool-use', updatedAt: new Date(time).toISOString(), taskTitle: 'Fix it' };
  const local = make('local.json', async () => null);
  t.after(() => local.stop());
  await local.observe([event]);
  assert.equal(calls[0].kind, 'local');
  assert.deepEqual(calls[0].body.cost, { usd: 3.46, unpriced: 2 });
  assert.deepEqual(local.costRows().map((r) => [r.card_id, r.session_id, r.pr?.number]), [['local-card', 'sess-1', 7]]);
  const team = make('team.json', async () => R.canonical_url);
  t.after(() => team.stop());
  await team.observe([{ ...event, sessionId: 'sess-2' }]);
  assert.equal(calls.at(-1).kind, 'team');
  assert.equal(calls.at(-1).body.cost, undefined);
});
