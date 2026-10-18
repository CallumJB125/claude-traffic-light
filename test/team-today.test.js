'use strict';
// Home's "Team today" card (src/team-today.js, home-team-today-view.js): composed
// from fixtures for a signed-out Mac, an empty team, a busy team and an unreachable hub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const TeamToday = require('../src/team-today.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const ROUTE = { hub: 'https://hub.example.test', user_id: 'u-me', team_id: 'team-a', team_name: 'Acme', board_id: 'board-a', board_name: 'Widget', repo_id: 'repo-a', canonical_url: 'github.com/acme/widget', share_summaries: true };
const MINE = { install_id: 'inst-me', record_id: 'inst-me:claude:s-me', session_id: 's-me', repo_id: 'repo-a', status: 'working', branch: 'feat/login', files: { edited: ['src/auth/login.js', 'package-lock.json'], read: [] } };
const rec = (id, author, extra = {}) => ({ record_id: `inst-${author}:claude:${id}`, session_id: id, adapter: 'claude', author: { name: author }, title: `${author}'s task`, status: 'working', files: { edited: [], read: [] }, branch: null, updated_at: iso(NOW - 2 * MIN), rev: 1, ...extra });
const card = (id, column, extra = {}) => ({ id, key: id.toUpperCase(), title: `Card ${id}`, column, pr: null, ...extra });

// A fake hub that answers the activity log's current records like the real one does.
function fakeFetch(current, calls = []) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (current === 'down') throw new Error('ECONNREFUSED');
    const id = new URL(url).searchParams.get('repo_id');
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ records: current[id] ?? [] }) };
  };
}

function make({ links = [{ repo: ROUTE.canonical_url, route: ROUTE, token: () => 'tok' }], current = {}, boards = {}, mine = [MINE], file = null, clock } = {}) {
  let t = clock ?? NOW;
  const calls = [];
  const today = TeamToday.createTeamToday({
    links: async () => links, board: async (r) => (boards === 'down' ? null : boards[r.board_id] ? { ok: true, board: { name: 'Widget' }, cards: boards[r.board_id] } : { ok: true, board: { name: 'Widget' }, cards: [] }),
    mine: () => mine, fetch: fakeFetch(current, calls), file, now: () => t,
  });
  return { today, calls, at: (x) => { t = x; } };
}

test('signed out: nothing is read and the card is not shown', async () => {
  const { today, calls } = make({ links: [] });
  assert.equal((await today.refresh()).state, 'signed_out');
  assert.equal(today.snapshot(), null);
  assert.equal(calls.length, 0);
});

test('an empty team: nobody working, nothing changed, no overlaps; last updated is set', async () => {
  const { today, calls } = make();
  const s = await today.refresh();
  assert.equal(s.state, 'ok');
  assert.deepEqual([s.people.items, s.changes.items, s.overlaps.items], [[], [], []]);
  assert.equal(s.updated_at, NOW);
  assert.deepEqual(s.teams, ['Acme']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/activity\/v1\/current\?repo_id=repo-a$/);
  assert.equal(calls[0].auth, 'Bearer tok');
});

test('a busy team: who is working, overlaps with your files by the board\'s rules, and what changed since you last looked', async () => {
  const current = { 'repo-a': [
    rec('s-me', 'Callum', { record_id: 'inst-me:claude:s-me', status: 'working', files: { edited: ['src/auth/login.js'], read: [] } }),
    rec('b1', 'Bob', { title: 'Session refresh', branch: 'feat/session', files: { edited: ['src/auth/login.js', 'src/auth/token.js'], read: [] } }),
    rec('c1', 'Carol', { status: 'waiting', title: 'Upgrade deps', files: { edited: ['yarn.lock'], read: [] }, updated_at: iso(NOW - 1 * MIN) }),
    rec('d1', 'Dan', { title: 'Docs', files: { edited: ['docs/a.md'], read: ['src/auth/login.js'] }, updated_at: iso(NOW - 5 * MIN) }),
    rec('e1', 'Eve', { status: 'ended', title: 'Fix CI', updated_at: iso(NOW - 10 * MIN) }),
    rec('f1', 'Fay', { status: 'review', title: 'New billing page', updated_at: iso(NOW - 20 * MIN) }),
    rec('g1', 'Gus', { status: 'idle', handoff_requested: true, title: 'Flaky test', updated_at: iso(NOW - 30 * MIN) }),
    rec('h1', 'Hal', { status: 'ended', title: 'Old news', updated_at: iso(NOW - 3 * 24 * 60 * MIN) }),
  ] };
  const boards = { 'board-a': [card('w-1', 'todo'), card('w-2', 'in_progress', { pr: { number: 41, url: 'https://github.com/acme/widget/pull/41', state: 'merged', merged_by: 'bob', merged_age_ms: 15 * MIN } })] };
  const r = make({ current, boards });
  const s = await r.today.refresh();
  assert.equal(s.state, 'ok');
  assert.deepEqual(s.people.items.map((p) => [p.author, p.title, p.status]), [['Carol', 'Upgrade deps', 'Waiting'], ['Bob', 'Session refresh', 'Working'], ['Dan', 'Docs', 'Working']], 'your own session is left out; newest first');
  assert.deepEqual(s.people.items[1].branch, 'feat/session');
  assert.deepEqual(s.overlaps.items.map((o) => [o.author, o.level, o.text]), [
    ['Bob', 'high', 'Bob is also editing src/auth/login.js'],
    ['Carol', 'medium', 'Carol is also changing a lockfile: package-lock.json, yarn.lock'],
    ['Dan', 'low', 'Dan is reading src/auth/login.js, which you are editing'],
  ]);
  assert.deepEqual(s.changes.items.map((c) => [c.kind, c.text]), [
    ['finished', 'Eve finished "Fix CI"'],
    ['merged', 'PR #41 merged by bob · W-2 Card w-2'],
    ['review', 'Fay\'s "New billing page" is ready for review'],
    ['handoff', 'Gus handed "Flaky test" to the team'],
  ], 'the first look covers the last day');
  assert.equal(s.changes.items[1].url, 'https://github.com/acme/widget/pull/41');

  // Mark as seen; then a card moves and someone finishes: only that is new.
  r.today.markSeen();
  assert.deepEqual(r.today.snapshot().changes.items, []);
  r.at(NOW + 5 * MIN);
  boards['board-a'] = [card('w-1', 'in_review'), boards['board-a'][1]];
  current['repo-a'] = current['repo-a'].map((x) => (x.author.name === 'Bob' ? { ...x, status: 'ended', updated_at: iso(NOW + 4 * MIN) } : x));
  const later = await r.today.refresh();
  assert.deepEqual(later.changes.items.map((c) => c.text), ['Bob finished "Session refresh"', 'W-1 Card w-1 moved to In review']);
  assert.ok(!later.overlaps.items.some((o) => o.author === 'Bob'), 'finished work no longer overlaps');
});

test('the hub is unreachable: a plain error state that keeps the last good answer and its time', async () => {
  const links = [{ repo: ROUTE.canonical_url, route: ROUTE, token: () => 'tok' }];
  const first = TeamToday.createTeamToday({ links: async () => links, board: async () => null, fetch: fakeFetch('down'), now: () => NOW });
  const s = await first.refresh();
  assert.deepEqual([s.state, s.updated_at, s.checked_at], ['error', null, NOW]);
  assert.equal(first.snapshot().state, 'error', 'shown, so the card can say so');

  let up = true, t = NOW;
  const flaky = TeamToday.createTeamToday({ links: async () => links, board: async () => (up ? { ok: true, cards: [] } : null), fetch: async (...a) => (up ? fakeFetch({ 'repo-a': [rec('b1', 'Bob')] })(...a) : fakeFetch('down')(...a)), now: () => t });
  await flaky.refresh();
  up = false; t += 2 * MIN;
  const e = await flaky.refresh();
  assert.deepEqual([e.state, e.updated_at, e.checked_at], ['error', NOW, NOW + 2 * MIN]);
  assert.deepEqual(e.people.items.map((p) => p.author), ['Bob'], 'last good data stays');
});

test('a team you do not share summaries with is not read back; its board still is', async () => {
  const quiet = { ...ROUTE, team_name: 'Quiet', team_id: 'team-q', board_id: 'board-q', repo_id: 'repo-q', share_summaries: false };
  const r = make({ links: [{ repo: quiet.canonical_url, route: quiet, token: () => 'tok' }] });
  const s = await r.today.refresh();
  assert.equal(s.state, 'ok');
  assert.deepEqual(s.sharing_off, ['Quiet']);
  assert.equal(r.calls.length, 0, 'no activity request');
});

test('seen state persists privately across restarts; the background refresh is cached', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-today-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'team-today.json');
  const boards = { 'board-a': [card('w-1', 'todo')] };
  const a = make({ boards, file });
  await a.today.refresh();
  a.today.markSeen();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { looked_at: NOW, columns: { 'w-1': 'todo' } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  boards['board-a'] = [card('w-1', 'done')];
  const b = make({ boards, file, clock: NOW + MIN });
  assert.deepEqual((await b.today.refresh()).changes.items.map((c) => c.text), ['W-1 Card w-1 moved to Done']);
  const n = b.calls.length;
  b.today.snapshot();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.calls.length, n, 'a fresh cache answers without asking the hub');
  b.at(NOW + MIN + TeamToday.REFRESH_MS + 1);
  b.today.snapshot();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.calls.length, n + 1, 'a stale one refreshes in the background');
});

test('the dev fixture fakes a signed-in team without a hub', async () => {
  const fx = { routes: [ROUTE], current: { 'repo-a': [rec('b1', 'Bob')] }, boards: { 'board-a': { board: { name: 'Widget' }, cards: [] } }, mine: [MINE] };
  const s = await TeamToday.createTeamToday({ ...TeamToday.fixtureSources(fx), now: () => NOW }).refresh();
  assert.deepEqual(s.people.items.map((p) => p.author), ['Bob']);
});

const tick = () => new Promise((r) => setImmediate(r));
function page(reply) {
  const html = fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  const sent = [];
  dom.window.homeApi = { teamToday: async () => reply(), teamTodaySeen: async () => { sent.push('seen'); return true; }, teamTodayRefresh: async () => { sent.push('refresh'); return reply(); } };
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'home-team-today-view.js'), 'utf8'));
  return { dom, sent, sec: dom.window.document.getElementById('teamtoday') };
}

test('Home: signed out hides the card; a busy team shows who, overlaps, changes and when it was updated', async () => {
  let reply = null;
  const p = page(() => reply);
  await tick(); await tick();
  assert.equal(p.sec.hidden, true);
  p.dom.window.close();

  const r = make({ current: { 'repo-a': [rec('b1', 'Bob', { files: { edited: ['src/auth/login.js'], read: [] } }), rec('e1', 'Eve', { status: 'ended', title: 'Fix CI' })] } });
  reply = await r.today.refresh();
  const q = page(() => reply);
  await tick(); await tick();
  assert.equal(q.sec.hidden, false);
  const t = q.sec.textContent;
  assert.match(t, /Team today/);
  assert.match(t, /Updated \d/);
  assert.match(t, /Working now.*Bob · Bob's task/s);
  assert.match(t, /Overlaps with your work.*Bob is also editing src\/auth\/login\.js/s);
  assert.match(t, /Since you were away.*Eve finished "Fix CI"/s);
  [...q.sec.querySelectorAll('button')].find((b) => b.textContent === 'Mark as seen').click();
  await tick(); await tick();
  assert.deepEqual(q.sent, ['seen']);
  q.dom.window.close();
});

test('Home: an unreachable hub says so plainly; an empty team says nobody is working', async () => {
  const p = page(() => ({ state: 'error', updated_at: null, checked_at: NOW }));
  await tick(); await tick();
  assert.match(p.sec.textContent, /Couldn’t reach the team hub/);
  p.dom.window.close();
  const empty = await make().today.refresh();
  const q = page(() => empty);
  await tick(); await tick();
  assert.match(q.sec.textContent, /No teammate is working/);
  assert.match(q.sec.textContent, /Nothing new since you last looked/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'home-team-today-view.js'), 'utf8'), /innerHTML/);
  q.dom.window.close();
});

test('shipped this week and since you were away: done cards, merged PRs and moments teammates marked', async () => {
  const DAY = 24 * 60 * MIN;
  const moments = [
    { id: 'm1', kind: 'ship', label: 'Billing v2 live', by: 'Fay', at: iso(NOW - 2 * DAY) },
    { id: 'm2', kind: 'decision', label: 'Keep SQLite', by: 'Bob', at: iso(NOW - 10 * MIN) },
    { id: 'm3', kind: 'ship', label: 'Old launch', by: 'Hal', at: iso(NOW - 9 * DAY) },
    { id: 'm4', kind: 'weird', label: '', at: iso(NOW) },
  ];
  const cards = [card('w-1', 'done', { state_age_ms: 3 * DAY }), card('w-2', 'done', { state_age_ms: 20 * DAY }), card('w-3', 'in_progress', { pr: { number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'merged', merged_by: 'carol', merged_age_ms: 1 * DAY } })];
  const view = TeamToday.compose({ boards: [{ team: 'Acme', board: 'Widget', cards, moments }], seen: { looked_at: NOW - 60 * MIN, columns: {} }, now: NOW });
  assert.deepEqual(view.shipped.items.map((x) => [x.kind, x.text]), [['merged', 'PR #7 · W-3 Card w-3'], ['ship', 'Billing v2 live'], ['done', 'W-1 Card w-1']], 'newest first; older than a week and the junk moment are left out');
  assert.deepEqual(view.changes.items.filter((c) => c.kind === 'moment').map((c) => c.text), ['Decision: Keep SQLite · Bob'], 'only moments marked since you last looked are changes');
  const r = make({ boards: {} });
  const s = await r.today.refresh();
  assert.deepEqual(s.shipped, { items: [], more: 0 }, 'the live card always carries a shipped list');
});
