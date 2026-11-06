'use strict';
// BACKBONE G8 (§3.5): which board work goes to. routeBoard's seven rules as a table, every answer with a why from
// src/bus-contract.js; bus_card_add with the hub offline (My board, pending_route, then re-routed when the catalog
// arrives), with two links and no default (My board with the "pick board" chip), and inheriting a hand-off's board.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkCapture, routeBoard, routeKey } = require('../src/work-capture');
const { BOARD_WHY, BOARD_KIND } = require('../src/bus-contract.js');
const { testTempDir } = require('./helpers/tmp');

const R = { hub: 'https://hub.example.test', user_id: 'user-a', team_id: 'team-a', board_id: 'board-a', repo_id: 'repo-a', canonical_url: 'github.com/org/app', role: 'member', board_name: 'App board' };
const B = { ...R, team_id: 'team-b', board_id: 'board-b', repo_id: 'repo-b', canonical_url: 'github.com/org/other', board_name: 'Other board' };
const R2 = { ...R, board_id: 'board-a2', repo_id: 'repo-a2', board_name: 'App board 2' };
const WHYS = new Set(Object.values(BOARD_WHY));
const KINDS = new Set(Object.values(BOARD_KIND));

test('routeBoard: the seven rules in order, each answer with a contract why', () => {
  const rows = [
    // [label, input, kind, why, extra]
    ['1 personal mark wins over everything', { personal: true, inherited: routeKey(B), repo: R.canonical_url, routes: [R, B] }, 'none', 'personal_mark'],
    ['2 inherited board', { inherited: routeKey(B), repo: R.canonical_url, routes: [R, B] }, 'team', 'inherited'],
    ['2 inherited, but read-only there: falls through to the repo rule', { inherited: routeKey(B), repo: R.canonical_url, routes: [R, { ...B, role: 'viewer' }] }, 'team', 'linked_repo'],
    ['3 linked to one team board', { repo: R.canonical_url, routes: [R] }, 'team', 'linked_repo'],
    ['4 linked to several, the person\'s default', { repo: R.canonical_url, routes: [R, R2], choice: { hub: R2.hub, user_id: R2.user_id, team_id: R2.team_id, board_id: R2.board_id, repo_id: R2.repo_id } }, 'team', 'repo_default'],
    ['4 linked to several, no default: My board with a chip', { repo: R.canonical_url, routes: [R, R2] }, 'choose', 'choose'],
    ['4 "Keep on My board" chosen', { repo: R.canonical_url, routes: [R], choice: { kind: 'local' } }, 'personal', 'repo_default'],
    ['5 not linked, same GitHub org as a linked repo: suggest', { repo: 'github.com/org/new', routes: [R] }, 'personal', 'no_link_suggested'],
    ['5 not linked, nothing to suggest', { repo: 'github.com/else/new', routes: [R] }, 'personal', 'no_link'],
    ['6 no repo', { repo: null, routes: [R], catalogComplete: false }, 'personal', 'no_repo'],
    ['7 hub offline', { repo: R.canonical_url, routes: [], catalogComplete: false }, 'personal', 'deferred', { pending_route: true }],
    ['read-only role', { repo: R.canonical_url, routes: [{ ...R, role: 'viewer' }] }, 'personal', 'read_only'],
  ];
  for (const [label, input, kind, why, extra = {}] of rows) {
    const r = routeBoard(input);
    assert.equal(r.kind, kind, label);
    assert.equal(r.why, why, label);
    assert.ok(WHYS.has(r.why) && KINDS.has(r.kind), label);
    for (const [k, v] of Object.entries(extra)) assert.equal(r[k], v, label);
  }
  assert.equal(routeBoard({ inherited: routeKey(B), repo: R.canonical_url, routes: [R, B] }).destination.board_id, 'board-b');
});

const session = (extra = {}) => ({ source: 'codex', sessionId: 'thread-1', host: 'mac', cwd: '/working/app', signal: 'tool-use', updatedAt: new Date(100000).toISOString(), ...extra });
let n = 0;
function rig(t, catalog) {
  const dir = testTempDir('board-route-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let time = 100000;
  const wc = createWorkCapture({ startEnabled: true, file: path.join(dir, 'capture.json'), host: 'mac', getRoutes: async () => catalog.value, resolveRepo: async () => R.canonical_url,
    sendLocal: async (body) => { calls.push({ kind: 'local', body }); return { ok: true, card: { id: `local-${calls.length}` } }; },
    sendTeam: async (destination, body) => { calls.push({ kind: 'team', destination, body }); return { ok: true, card: { id: `team-${calls.length}` } }; },
    now: () => time });
  t.after(() => wc.stop());
  const add = (extra = {}) => wc.addAgentCard(session(), { title: 'Fix the parser', request_id: `req-route-${String(++n).padStart(6, '0')}`, handle: 'codex-app-1a2b', folder: 'app', ...extra });
  return { wc, calls, add, advance: (ms) => { time += ms; } };
}

test('rule 7: hub offline → the card waits on My board (pending_route), then moves to the team board when the catalog arrives', async (t) => {
  const catalog = { value: { routes: [], complete: false } };
  const r = rig(t, catalog);
  const res = await r.add();
  assert.equal(res.card_id, 'local-1');
  assert.deepEqual(res.board, { kind: 'personal', why: 'deferred', pending_route: true });
  assert.equal(r.calls[0].kind, 'local');
  // The hub answers: the next catalog fetch (here an observe pass after the 15 s cache) re-routes it.
  catalog.value = { routes: [R], complete: true };
  r.advance(16_000);
  await r.wc.observe([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const team = r.calls.find((c) => c.kind === 'team');
  assert.ok(team, 'sent to the team board');
  assert.equal(team.destination.board_id, 'board-a');
  assert.match(team.body.title, /Fix the parser · added by Codex/);
  const closed = r.calls.filter((c) => c.kind === 'local').at(-1);
  assert.equal(closed.body.status, 'ended');
  assert.equal(closed.body.task_id, team.body.task_id, 'the same card identity on both boards');
  // Re-routed once: a later catalog does not send it again, and a retry of the same request answers the team board.
  const sends = r.calls.length;
  r.advance(16_000);
  await r.wc.observe([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.calls.length, sends);
});

test('rule 4 with no default: My board with the "pick board" chip, not a refusal', async (t) => {
  const r = rig(t, { value: { routes: [R, R2], complete: true } });
  const res = await r.add();
  assert.ok(res.card_id);
  assert.deepEqual(res.board, { kind: 'choose', why: 'choose' });
  assert.equal(r.calls[0].kind, 'local');
});

test('rule 2: a card carrying the asker\'s board (origin_board) goes there, not to the repo\'s own link', async (t) => {
  const r = rig(t, { value: { routes: [R, B], complete: true } });
  const res = await r.add({ origin_board: routeKey(B) });
  assert.deepEqual(res.board, { kind: 'team', name: 'Other board', why: 'inherited' });
  assert.equal(r.calls[0].destination.board_id, 'board-b');
  // A forged or unknown key is just ignored: the repo's own link.
  const res2 = await r.add({ origin_board: 'f'.repeat(64) });
  assert.deepEqual(res2.board, { kind: 'team', name: 'App board', why: 'linked_repo' });
});
