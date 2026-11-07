'use strict';
// Board routing audit (2026-11-07): every path by which AI work becomes a card, as one table, through the real
// work-capture loop. Each row says which board the card lands on and the machine reason it keeps (BOARD_WHY), so the
// UI and bus_peers can say "On <board> because ...". Then one regression test per bug the audit fixed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkCapture, resolveBoard, routeKey } = require('../src/work-capture');
const { recordsFor } = require('../src/wrapped-work');
const { BOARD_WHY } = require('../src/bus-contract.js');
const { testTempDir } = require('./helpers/tmp');

const HUB = 'https://hub.example.test';
const route = (team, board, repo, url, name, role = 'member') => ({ hub: HUB, user_id: 'user-a', team_id: team, board_id: board, repo_id: repo, canonical_url: url, role, board_name: name, team_name: team });
const A = route('team-a', 'board-a', 'repo-a', 'github.com/acme/app', 'Team A board');
const A2 = route('team-a', 'board-a2', 'repo-a2', 'github.com/acme/api', 'Team A api');
const B = route('team-b', 'board-b', 'repo-b', 'github.com/beta/site', 'Team B board');
const ROUTES = [A, A2, B];
const HOME = '/Users/person';
// The canonical remote of each folder; $HOME is a dotfiles checkout of a linked repo, to prove it never goes to a team.
const REPOS = { '/w/app': A.canonical_url, '/w/api': A2.canonical_url, '/w/site': B.canonical_url, '/w/notes': 'github.com/acme/notes', '/w/solo': 'github.com/me/solo', '/w/scratch': null, [HOME]: A.canonical_url, '/w/secret': A.canonical_url };
const EXCLUDED = new Set(['/w/secret']);
const T0 = 1_000_000;
const WHYS = new Set(Object.values(BOARD_WHY));

function rig(t, { catalog = { routes: ROUTES, complete: true } } = {}) {
  const dir = testTempDir('board-paths-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let time = T0;
  const setup = {
    startEnabled: true, file: path.join(dir, 'capture.json'), host: 'mac', home: HOME,
    getRoutes: async () => catalog.value ?? catalog, resolveRepo: async (cwd) => REPOS[cwd] ?? null, excluded: async (cwd) => EXCLUDED.has(cwd),
    sendLocal: async (body) => { calls.push({ board: 'local', body }); return { ok: true, card: { id: `local-${calls.length}` } }; },
    sendTeam: async (d, body) => { calls.push({ board: d.board_id, body }); return { ok: true, card: { id: `team-${calls.length}` } }; },
    now: () => time,
  };
  const wc = createWorkCapture(setup);
  t.after(() => wc.stop());
  return { wc, calls, setup, dir, advance: (ms) => { time += ms; }, at: () => new Date(time).toISOString() };
}
const session = (r, extra = {}) => ({ source: 'claude', sessionId: 'sess-1', host: 'mac', cwd: '/w/app', signal: 'tool-use', updatedAt: r.at(), ...extra });
const taskRow = (r, extra = {}) => ({ taskId: 'tsk_one', ai: 'claude', title: null, localTitle: 'Fix the login loop for dana', state: 'running', root: '/w/app', changedAt: Date.parse(r.at()), ...extra });

// [label, path, input → raw records, board ('local' | board id | null: no card), why, check?]
const ROWS = [
  ['interactive Claude Code session, repo linked to one team board', 'session', (r) => [session(r)], 'board-a', 'linked_repo'],
  ['interactive session, repo not linked, same GitHub org as a linked one', 'session', (r) => [session(r, { cwd: '/w/notes' })], 'local', 'no_link_suggested'],
  ['interactive session, repo not linked', 'session', (r) => [session(r, { cwd: '/w/solo' })], 'local', 'no_link'],
  ['interactive session, folder with no remote', 'session', (r) => [session(r, { cwd: '/w/scratch' })], 'local', 'no_repo'],
  ['interactive session marked personal, in a linked repo', 'session', (r) => [session(r, { scope: { state: 'personal' } })], 'local', 'personal_mark'],
  ['headless run (claude -p) in a linked repo: routed by its folder like any session', 'session', (r) => [session(r, { sessionId: 'headless-1' })], 'board-a', 'linked_repo'],
  ['Codex session in a linked repo', 'session', (r) => [session(r, { source: 'codex', cwd: '/w/site' })], 'board-b', 'linked_repo'],
  ['Gemini session in a linked repo', 'session', (r) => [session(r, { source: 'gemini', cwd: '/w/api' })], 'board-a2', 'linked_repo'],
  ['session in $HOME (a linked dotfiles checkout): My board only', 'session', (r) => [session(r, { cwd: HOME, taskTitle: 'Tidy downloads' })], 'local', 'no_repo'],
  ['session in a dot-folder under $HOME: no card', 'session', (r) => [session(r, { cwd: `${HOME}/.claude/projects/x`, taskTitle: 'Memory pass' })], null, null],
  ['session at the filesystem root: no card', 'session', (r) => [session(r, { cwd: '/', taskTitle: 'Root work' })], null, null],
  ['session in a folder the person excluded: no card', 'session', (r) => [session(r, { cwd: '/w/secret', taskTitle: 'Secret work' })], null, null],
  ['Plexiform Task (the person\'s own) in a linked repo: team card, no prompt title', 'wrapped', (r) => recordsFor([taskRow(r)], { host: 'mac' }), 'board-a', 'linked_repo',
    (calls) => assert.ok(!JSON.stringify(calls).includes('dana'), 'an untitled task\'s prompt stays on this Mac')],
  ['Plexiform Task in an unlinked repo: My board with its prompt line', 'wrapped', (r) => recordsFor([taskRow(r, { root: '/w/solo' })], { host: 'mac' }), 'local', 'no_link',
    (calls) => assert.equal(calls[0].body.title, 'Fix the login loop for dana')],
  ['hand-off run, no asker board: the repo rules', 'handoff', (r) => recordsFor([taskRow(r, { ai: 'codex', handoff: true })], { host: 'mac' }), 'board-a', 'linked_repo'],
  ['hand-off run, asker on another board of the repo\'s team: the asker\'s board', 'handoff', (r) => recordsFor([taskRow(r, { ai: 'codex', handoff: true, originBoard: routeKey(A2) })], { host: 'mac' }), 'board-a2', 'inherited',
    (calls) => assert.ok(!JSON.stringify(calls).includes('dana'), 'an AI\'s or prompt title never reaches a team card')],
  ['hand-off run in an unlinked repo, asker on a team board: the asker\'s board', 'handoff', (r) => recordsFor([taskRow(r, { ai: 'codex', root: '/w/solo', handoff: true, originBoard: routeKey(B) })], { host: 'mac' }), 'board-b', 'inherited'],
  ['hand-off run in a folder with no repo Plexiform could read, asker on a team board: withheld', 'handoff', (r) => recordsFor([taskRow(r, { ai: 'codex', root: '/w/scratch', handoff: true, originBoard: routeKey(B) })], { host: 'mac' }), 'local', 'withheld',
    (calls) => assert.ok(!/scratch/.test(JSON.stringify(calls.filter((c) => c.board === 'board-b'))), 'the pointer names no folder')],
  ['hand-off run, asker\'s cards go to My board, run in a linked repo: My board', 'handoff', (r) => recordsFor([taskRow(r, { ai: 'codex', handoff: true, originBoard: 'local' })], { host: 'mac' }), 'local', 'inherited'],
  ['hand-off run in team A\'s repo, asker on team B: withheld, My board + a redacted pointer on B', 'handoff', (r) => recordsFor([taskRow(r, { ai: 'codex', title: null, handoff: true, originBoard: routeKey(B) })], { host: 'mac' }), 'local', 'withheld',
    (calls) => {
      const pointer = calls.find((c) => c.board === 'board-b');
      assert.ok(pointer, 'the asker\'s board gets a pointer');
      assert.equal(pointer.body.title, 'Codex · hand-off running in another team\'s repo');
      assert.equal(pointer.body.summary, undefined);
      assert.equal(pointer.body.repo_id, 'repo-b', 'filed under the asker\'s own link');
      assert.ok(!/app|acme|dana|login/i.test(JSON.stringify(pointer)), 'no folder, repo or title of team A reaches team B');
      assert.ok(!calls.some((c) => c.board === 'board-a'), 'and not on team A as a second item either');
    }],
  ['fallback run (same asker board on the replacement hand-off): the asker\'s board', 'handoff', (r) => recordsFor([taskRow(r, { taskId: 'tsk_fb', ai: 'claude', handoff: true, originBoard: routeKey(A2) })], { host: 'mac' }), 'board-a2', 'inherited'],
];

test('routing table: every path that makes a card lands on the right board, with its reason kept', async (t) => {
  for (const [label, kind, input, board, why, check] of ROWS) {
    const r = rig(t);
    const raw = input(r);
    await r.wc.observe(kind === 'session' ? raw : [], { wrapped: kind === 'session' ? [] : raw });
    if (board === null) {
      assert.equal(r.calls.length, 0, `${label}: no card`);
      assert.equal(r.wc.snapshot().length, 0, `${label}: nothing kept`);
      continue;
    }
    assert.equal(r.calls[0]?.board, board, label);
    const main = r.wc.snapshot().find((s) => !s.pointer);
    assert.equal(main.why, why, `${label}: why`);
    assert.ok(WHYS.has(main.why), `${label}: a contract why`);
    if (check) check(r.calls);
  }
});

test('resolveBoard: context → {board, reason}, deterministic, one answer per context', () => {
  const rows = [
    [{ cardsOn: false, repo: A.canonical_url, routes: ROUTES }, 'none', 'cards_off'],
    [{ excluded: true, repo: A.canonical_url, routes: ROUTES }, 'none', 'excluded'],
    [{ personal: true, repo: A.canonical_url, routes: ROUTES }, 'personal', 'personal_mark'],
    [{ repo: A.canonical_url, routes: ROUTES }, 'team', 'linked_repo', 'Team A board'],
    [{ inherited: routeKey(A2), repo: A.canonical_url, routes: ROUTES }, 'team', 'inherited', 'Team A api'],
    [{ inherited: routeKey(B), repo: A.canonical_url, routes: ROUTES }, 'personal', 'withheld'],
    [{ inherited: 'local', repo: A.canonical_url, routes: ROUTES }, 'personal', 'inherited'],
    [{ inherited: routeKey(B), repo: null, routes: ROUTES }, 'personal', 'withheld'],
    [{ inherited: routeKey(B), repo: 'github.com/me/solo', routes: ROUTES }, 'team', 'inherited', 'Team B board'],
    [{ inherited: 'not-a-key', repo: A.canonical_url, routes: ROUTES }, 'team', 'linked_repo', 'Team A board'],
    [{ repo: 'github.com/me/solo', routes: ROUTES }, 'personal', 'no_link'],
    [{ repo: null, routes: ROUTES }, 'personal', 'no_repo'],
    [{ repo: A.canonical_url, routes: [], catalogComplete: false }, 'personal', 'deferred'],
  ];
  for (const [ctx, kind, reason, name] of rows) {
    const a = resolveBoard(ctx);
    assert.deepEqual(resolveBoard(ctx), a, 'deterministic');
    assert.equal(a.board.kind, kind, JSON.stringify(ctx));
    assert.equal(a.reason, reason, JSON.stringify(ctx));
    assert.equal(a.board.name, name, JSON.stringify(ctx));
  }
  assert.equal(resolveBoard({ inherited: routeKey(B), repo: A.canonical_url, routes: ROUTES }).pointer.board_id, 'board-b');
});

test('one card per session: working → needs you → review → idle update the same card, never a new one per turn', async (t) => {
  const r = rig(t);
  for (const signal of ['tool-use', 'permission-ask', 'tool-use', 'stop']) {
    r.advance(1000);
    await r.wc.observe([session(r, { signal, taskTitle: 'Fix route' })]);
  }
  const ids = new Set(r.calls.map((c) => JSON.stringify([c.body.provider, c.body.session_id, c.body.task_id])));
  assert.equal(ids.size, 1);
  assert.deepEqual(r.calls.map((c) => c.body.status), ['working', 'waiting', 'working', 'review']);
  assert.equal(r.wc.snapshot().length, 1);
  r.advance(31_000);
  await r.wc.observe([]);
  assert.equal(r.calls.at(-1).body.status, 'idle');
  assert.equal(new Set(r.calls.map((c) => c.body.task_id)).size, 1);
  // A Plexiform Task likewise: one card by its task id as its state moves.
  const w = rig(t);
  for (const state of ['running', 'blocked', 'in_review', 'done']) {
    w.advance(1000);
    await w.wc.observe([], { wrapped: recordsFor([taskRow(w, { state, changedAt: Date.parse(w.at()) })], { host: 'mac' }) });
  }
  assert.deepEqual(w.calls.map((c) => c.body.status), ['working', 'waiting', 'review', 'ended']);
  assert.equal(new Set(w.calls.map((c) => c.body.task_id)).size, 1);
});

// --- Regression tests, one per bug the audit fixed ---

test('regression: a hand-off from team B\'s session working in team A\'s repo never puts team A\'s work on team B\'s board', async (t) => {
  const r = rig(t);
  const recs = recordsFor([taskRow(r, { ai: 'codex', title: 'Rotate the acme keys', handoff: true, originBoard: routeKey(B) })], { host: 'mac' });
  await r.wc.observe([], { wrapped: recs });
  const toB = r.calls.filter((c) => c.board === 'board-b');
  assert.equal(toB.length, 1);
  assert.ok(!/acme|Rotate|app/.test(JSON.stringify(toB)));
  // The pointer never carries the work's record to team B's summaries or memory.
  assert.deepEqual((await r.wc.shareableRecords()).filter((x) => x.destination.board_id === 'board-b'), []);
  // The pointer follows the work's state, and goes idle with it.
  r.advance(1000);
  await r.wc.observe([], { wrapped: recordsFor([taskRow(r, { ai: 'codex', handoff: true, originBoard: routeKey(B), state: 'blocked', changedAt: Date.parse(r.at()) })], { host: 'mac' }) });
  assert.equal(r.calls.filter((c) => c.board === 'board-b').at(-1).body.status, 'waiting');
  r.advance(31_000);
  await r.wc.observe([], { wrapped: [] });
  assert.equal(r.calls.filter((c) => c.board === 'board-b').at(-1).body.status, 'idle');
});

test('regression: a hand-off from a session whose cards go to My board stays on My board, even in a linked repo', async (t) => {
  const r = rig(t);
  await r.wc.observe([], { wrapped: recordsFor([taskRow(r, { ai: 'codex', handoff: true, originBoard: 'local' })], { host: 'mac' }) });
  assert.deepEqual(r.calls.map((c) => c.board), ['local']);
  // Only a hand-off row carries an origin, and only a route key or 'local'.
  assert.equal(recordsFor([taskRow(r, { originBoard: 'local' })], { host: 'mac' })[0].originBoard, undefined);
  assert.equal(recordsFor([taskRow(r, { handoff: true, originBoard: 'LOCAL' })], { host: 'mac' })[0].originBoard, undefined);
});

test('regression: bus_peers no longer tells a personal session "no cards" while its card is made on My board', async (t) => {
  const r = rig(t);
  const s = session(r, { scope: { state: 'personal' } });
  await r.wc.observe([s]);
  assert.equal(r.calls[0].board, 'local');
  assert.deepEqual(r.wc.boardFor(s), { kind: 'personal', why: 'personal_mark' });
});

test('regression: $HOME (even a linked dotfiles checkout) is My board only; dot-folders and excluded folders make no card and bus_peers says so', async (t) => {
  const r = rig(t);
  await r.wc.observe([session(r, { cwd: HOME, taskTitle: 'Tidy downloads' })]);
  assert.deepEqual(r.calls.map((c) => c.board), ['local']);
  const dot = session(r, { sessionId: 'dot', cwd: `${HOME}/.codex/x`, taskTitle: 'x' });
  assert.deepEqual(r.wc.boardFor(dot), { kind: 'untracked', why: 'excluded' });
  const secret = session(r, { sessionId: 'sec', cwd: '/w/secret', taskTitle: 'x' });
  r.wc.boardFor(secret);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.wc.boardFor(secret), { kind: 'untracked', why: 'excluded' });
  await r.wc.observe([dot, secret]);
  assert.equal(r.calls.length, 1);
  // An exclusion check that fails is an exclusion.
  const failing = rig(t);
  failing.setup.excluded = null;
  const f2 = createWorkCapture({ ...failing.setup, file: path.join(failing.dir, 'f2.json'), excluded: async () => { throw new Error('git broke'); } });
  t.after(() => f2.stop());
  await f2.observe([session(failing)]);
  assert.equal(failing.calls.length, 0);
});

test('regression: a card\'s why, pending_route and asker board survive a restart, so a pending card still re-routes to the asker\'s board', async (t) => {
  const catalog = { value: { routes: [], complete: false } };
  const r = rig(t, { catalog });
  const res = await r.wc.addAgentCard(session(r, { cwd: '/w/solo' }), { title: 'Draft the notes', request_id: 'req-restart-0001', handle: 'claude-app-1a2b', folder: 'solo', origin_board: routeKey(B) });
  assert.deepEqual(res.board, { kind: 'personal', why: 'deferred', pending_route: true });
  await r.wc.stop();
  const stored = Object.values(JSON.parse(fs.readFileSync(r.setup.file, 'utf8')).tasks)[0];
  assert.equal(stored.why, 'deferred');
  assert.equal(stored.pending_route, true);
  assert.equal(stored.inherited, routeKey(B));
  // Plexiform restarts; the hub answers.
  catalog.value = { routes: ROUTES, complete: true };
  const again = createWorkCapture(r.setup);
  t.after(() => again.stop());
  await again.observe([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const team = r.calls.find((c) => c.board !== 'local');
  assert.equal(team?.board, 'board-b', 'the asker\'s board, not the repo rules (My board)');
  assert.equal(again.snapshot()[0].why, 'inherited');
  assert.equal(again.snapshot()[0].pending_route, undefined);
});

// --- Review follow-ups (2026-11-07) ---

test('regression: a hand-off whose repo lookup fails (git timed out) is withheld, never inherited onto the asker\'s team', async (t) => {
  const r = rig(t);
  r.setup.resolveRepo = async () => null;
  const wc = createWorkCapture({ ...r.setup, file: path.join(r.dir, 'slow.json') });
  t.after(() => wc.stop());
  await wc.observe([], { wrapped: recordsFor([taskRow(r, { ai: 'codex', title: 'Rotate the acme keys', handoff: true, originBoard: routeKey(B) })], { host: 'mac' }) });
  const toB = r.calls.filter((c) => c.board === 'board-b');
  assert.equal(toB.length, 1);
  assert.equal(toB[0].body.title, 'Codex · hand-off running in another team\'s repo');
  assert.ok(!/app|acme|Rotate/.test(JSON.stringify(toB)));
  assert.equal(wc.snapshot().find((s) => !s.pointer).why, 'withheld');
});

test('regression: excluding a folder after its card exists stops the card updating', async (t) => {
  const r = rig(t);
  const excludedSet = new Set();
  const wc = createWorkCapture({ ...r.setup, file: path.join(r.dir, 'later.json'), excluded: async (cwd) => excludedSet.has(cwd) });
  t.after(() => wc.stop());
  await wc.observe([session(r, { taskTitle: 'Fix route' })]);
  assert.deepEqual(r.calls.map((c) => c.board), ['board-a']);
  excludedSet.add('/w/app');
  wc.forgetExclusions();
  for (const signal of ['permission-ask', 'stop']) {
    r.advance(1000);
    await wc.observe([session(r, { signal, taskTitle: 'Fix route' })]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(r.calls.map((c) => c.board), ['board-a'], 'no update after the exclusion');
  assert.deepEqual(wc.boardFor(session(r)), { kind: 'untracked', why: 'excluded' });
});

test('regression: a folder check that never answers counts as excluded for that folder, and other sessions still get cards', async (t) => {
  const r = rig(t);
  const wc = createWorkCapture({ ...r.setup, file: path.join(r.dir, 'stuck.json'), excludeMs: 30,
    excluded: (cwd) => (cwd === '/w/site' ? new Promise(() => {}) : Promise.resolve(false)) });
  t.after(() => wc.stop());
  await wc.observe([session(r, { sessionId: 'stuck', cwd: '/w/site', taskTitle: 'x' }), session(r, { taskTitle: 'Fix route' })]);
  assert.deepEqual(r.calls.map((c) => c.board), ['board-a']);
});

test('regression: a hand-off pointer stays current while its run does, and never marks the real work record idle', async (t) => {
  const r = rig(t);
  const rec = (extra = {}) => recordsFor([taskRow(r, { ai: 'codex', handoff: true, originBoard: routeKey(B), ...extra })], { host: 'mac' });
  await r.wc.observe([], { wrapped: rec() });
  const pointer = r.wc.snapshot().find((s) => s.pointer);
  const main = r.wc.snapshot().find((s) => !s.pointer);
  assert.ok(pointer && main);
  const ptrCall = r.calls.find((c) => c.board === 'board-b');
  assert.match(ptrCall.body.session_id, /^ptr-[a-f0-9]{32}$/, 'its own id, never the real work\'s');
  // Still running, but no fresh change marker for over a minute: neither card goes idle.
  r.advance(90_000);
  await r.wc.observe([], { wrapped: rec({ changedAt: T0 }) });
  assert.ok(!r.calls.some((c) => c.body.status === 'idle'));
});
