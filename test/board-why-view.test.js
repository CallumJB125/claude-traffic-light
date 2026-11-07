'use strict';
// Why a card is on its board (src/board-why-view.js): every BOARD_WHY reason has words a person
// understands, solo users see no team words, and a board page only hears about its own cards.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/board-why-view.js');
const { BOARD_WHY } = require('../src/bus-contract.js');

const HUB = 'https://hub.example';
const team = (extra = {}) => ({ kind: 'team', hub: HUB, team_id: 't1', board_id: 'b1', team_name: 'Acme', board_name: 'Main', ...extra });
const local = { kind: 'local' };
const row = (why, extra = {}) => ({ key: `k-${why}`, card_id: `c-${why}`, why, destination: local, ...extra });

test('every routing reason that leaves a card on a board has a label; excluded and cards_off have none', () => {
  const shown = Object.values(BOARD_WHY).filter((w) => !['excluded', 'cards_off'].includes(w));
  for (const why of shown) {
    const c = V.chip(row(why, why === 'linked_repo' || why === 'repo_default' ? { destination: team() } : {}));
    assert.ok(c && typeof c.label === 'string' && c.label.length > 3, `${why} has a label`);
    assert.ok(['team', 'personal', 'warn', 'muted'].includes(c.tone), `${why} has a known tone`);
    assert.ok(c.title && c.title.length > 20, `${why} explains itself`);
  }
  assert.equal(V.chip(row('excluded')), null);
  assert.equal(V.chip(row('cards_off')), null);
  assert.equal(V.chip(row('something-new')), null, 'an unknown reason says nothing rather than guess');
});

test('the owner\'s wording: linked repo names the team, unlinked offers Link, withheld and waiting say so', () => {
  assert.equal(V.chip(row('linked_repo', { destination: team() })).label, 'Linked repo → Acme');
  assert.equal(V.chip(row('inherited', { destination: team() })).label, 'Asked by a teammate’s session');
  assert.equal(V.chip(row('inherited')).label, 'Asked by one of your sessions');
  assert.equal(V.chip(row('personal_mark')).label, 'Personal');
  assert.equal(V.chip(row('personal_mark')).fix.id, 'session');
  assert.match(V.chip(row('no_link')).label, /^Repo not linked/);
  assert.equal(V.chip(row('no_link')).fix.id, 'link');
  assert.equal(V.chip(row('no_link_suggested')).fix.label, 'Link to a team…');
  assert.equal(V.chip(row('withheld')).label, 'Withheld: runs in another team’s repo');
  assert.equal(V.chip(row('withheld')).fix, null);
  assert.equal(V.chip(row('choose')).fix.id, 'choose');
  assert.equal(V.chip(row('no_repo')).fix.id, 'exclude');
});

test('pending_route wins over the stored reason: the card is waiting for the team hub', () => {
  const c = V.chip(row('no_link', { pending_route: true }));
  assert.equal(c.label, 'Waiting to reach team board');
  assert.equal(c.pending, true);
  assert.equal(V.chip(row('deferred')).pending, true);
});

test('a pointer card says only that a hand-off runs elsewhere: no team, repo, title or fix', () => {
  const c = V.chip(row('inherited', { pointer: true, destination: team({ team_name: 'Secret team' }), repo: 'github.com/other/private', title: 'Private title' }));
  assert.equal(c.pointer, true);
  assert.equal(c.fix, null);
  const all = JSON.stringify(c);
  for (const leak of ['Secret team', 'other/private', 'Private title']) assert.ok(!all.includes(leak), leak);
});

test('solo (no team anywhere): not-linked, personal and no-repo say nothing, so the board has no team clutter', () => {
  for (const why of ['no_link', 'no_link_suggested', 'personal_mark', 'no_repo']) assert.equal(V.chip(row(why), { solo: true }), null, why);
  assert.equal(V.isSolo([{ id: 'local', kind: 'local' }]), true);
  assert.equal(V.isSolo([]), true);
  assert.equal(V.isSolo([{ id: 'local', kind: 'local' }, { id: 'x', kind: 'team', hub: HUB, teamId: 't1' }]), false);
  const r = V.forBoard([row('no_link'), row('no_repo'), row('personal_mark')], { hub: null }, { solo: true });
  assert.deepEqual(r, { cards: {}, pending: 0 });
});

test('a board page hears only about its own cards: My board, or the one team on the one hub', () => {
  const rows = [
    row('no_link'),
    row('linked_repo', { card_id: 'c-team', destination: team() }),
    row('linked_repo', { card_id: 'c-other-team', destination: team({ team_id: 't2', team_name: 'Other' }) }),
    row('linked_repo', { card_id: 'c-other-hub', destination: team({ hub: 'https://elsewhere.example' }) }),
    row('no_link', { card_id: null }),
    row('no_link', { card_id: 'c-untracked', untracked: true }),
    row('deferred', { card_id: 'c-wait', pending_route: true }),
  ];
  const mine = V.forBoard(rows, { hub: null });
  assert.deepEqual(Object.keys(mine.cards).sort(), ['c-no_link', 'c-wait']);
  assert.equal(mine.pending, 1);
  const theirs = V.forBoard(rows, { hub: HUB, team: 't1' });
  assert.deepEqual(Object.keys(theirs.cards), ['c-team']);
  assert.equal(theirs.pending, 0);
  assert.deepEqual(Object.keys(V.forBoard(rows, { hub: HUB }).cards).sort(), ['c-other-team', 'c-team']);
  assert.deepEqual(V.forBoard(null, { hub: null }), { cards: {}, pending: 0 });
});

test('the sidebar counts this Mac\'s cards per workspace and the ones waiting for a hub; pointers are not counted', () => {
  const ws = [{ id: 'local', kind: 'local' }, { id: 'w1', kind: 'team', hub: HUB, teamId: 't1' }, { id: 'w2', kind: 'team', hub: HUB, teamId: 't2' }];
  const counts = V.workspaceCounts([
    row('no_link'), row('no_link', { card_id: 'c2' }), row('deferred', { card_id: null, pending_route: true }),
    row('linked_repo', { destination: team() }), row('inherited', { pointer: true, destination: team() }), row('no_link', { untracked: true }),
  ], ws);
  assert.deepEqual(counts, { local: { cards: 2, pending: 1 }, w1: { cards: 1, pending: 0 }, w2: { cards: 0, pending: 0 } });
});

test('every fix maps to a real page (or the card\'s own session controls)', () => {
  const { PAGES } = require('../buddy-window/pages.js');
  const ids = new Set(PAGES.map((p) => p.id));
  for (const [fix, page] of Object.entries(V.FIX_PAGE)) assert.ok(ids.has(page), `${fix} → ${page}`);
  for (const f of Object.values(V.FIXES)) assert.ok(f.id === 'session' || Object.hasOwn(V.FIX_PAGE, f.id), f.id);
});

test('text from a row never carries control characters into a label', () => {
  const c = V.chip(row('linked_repo', { destination: team({ team_name: 'A\u0007cme\nTeam' }) }));
  assert.doesNotMatch(c.label, /[\u0000-\u001f]/);
});
