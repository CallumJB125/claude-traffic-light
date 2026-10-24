'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rowsFor, MY_BOARD } = require('../src/work-routing-view.js');

const core = { key: 'k-core', team: 'Plexiform', board: 'Core' };
const web = { key: 'k-web', team: 'Plexiform', board: 'Website' };
const row = (state, extra = {}) => ({ repo: 'github.com/org/app', short: 'app', state, destination: { kind: 'local' }, matches: [], ...extra });
const teams = {
  admin: [{ key: 't-plexi', name: 'Plexiform', role: 'admin', boards: [{ key: 'b-core', name: 'Core' }, { key: 'b-web', name: 'Website' }] }],
  member: [{ key: 't-plexi', name: 'Plexiform', role: 'member', boards: [{ key: 'b-core', name: 'Core' }] }],
  viewer: [{ key: 't-plexi', name: 'Plexiform', role: 'viewer', boards: [{ key: 'b-core', name: 'Core' }] }],
};

test('rowsFor: the words for each state, and every choice offered', () => {
  const [ask] = rowsFor([row('ask', { matches: [{ ...core, read_only: false }, { ...web, read_only: false }] })], { teams: teams.member });
  assert.equal(ask.text, 'app is linked to Plexiform / Core and Plexiform / Website. Where should its new work go?');
  assert.equal(ask.goesTo, 'Not chosen yet (My board until you pick)');
  assert.deepEqual(ask.choices, [{ key: 'k-core', label: 'Core' }, { key: 'k-web', label: 'Website' }, { key: 'local', label: 'Keep on My board' }]);

  const [single] = rowsFor([row('single', { destination: { kind: 'team', ...core }, matches: [{ ...core, read_only: false }] })], { teams: teams.member });
  assert.equal(single.text, 'app → Plexiform / Core');
  assert.equal(single.note, 'Its only team board, so new work goes there.');
  assert.deepEqual(single.change, [{ key: 'k-core', label: 'Plexiform / Core', current: true }, { key: 'local', label: MY_BOARD, current: false }]);
  assert.equal(single.choices, null);

  const [setLocal] = rowsFor([row('set', { matches: [{ ...core, read_only: false }] })], { teams: teams.member });
  assert.equal(setLocal.text, `app → ${MY_BOARD}`);
  assert.equal(setLocal.change.find((c) => c.current).key, 'local');

  const [ro] = rowsFor([row('read_only', { matches: [{ ...core, read_only: true }] })], { teams: teams.viewer });
  assert.equal(ro.text, `app → ${MY_BOARD}`);
  assert.equal(ro.note, 'Your role on Plexiform / Core is read-only, so its work stays on My board.');
  assert.deepEqual(ro.change, [], 'nothing to change to');
});

test('rowsFor: an unlinked project offers Link to an admin, Ask an admin to a member, and nothing to a viewer or without a team', () => {
  const [admin] = rowsFor([row('unlinked')], { teams: teams.admin });
  assert.equal(admin.note, 'Put it on a team board?');
  assert.deepEqual(admin.link, [{ key: 'b-core', label: 'Plexiform / Core' }, { key: 'b-web', label: 'Plexiform / Website' }]);
  assert.equal(admin.ask, null);
  assert.deepEqual(admin.choices, [{ key: 'local', label: 'Keep on My board' }], 'the question can be settled');
  const [kept] = rowsFor([row('set')], { teams: teams.admin });
  assert.equal(kept.note, null); assert.equal(kept.choices, null); assert.equal(kept.link.length, 2, 'Link stays on offer, quietly');
  const [member] = rowsFor([row('unlinked')], { teams: teams.member });
  assert.equal(member.link, null);
  assert.deepEqual(member.ask, [{ key: 't-plexi', label: 'Plexiform' }]);
  assert.match(member.note, /Only a team admin can link it/);
  const [viewer] = rowsFor([row('unlinked')], { teams: teams.viewer });
  assert.equal(viewer.link, null); assert.equal(viewer.ask, null); assert.equal(viewer.note, null);
  assert.deepEqual(rowsFor([row('unlinked')], { teams: [] }), [], 'no team: nothing to decide, no row');
});

test('rowsFor: only names and keys come out, at most 20 rows; a read-only match is never a choice', () => {
  const many = Array.from({ length: 30 }, (_, i) => row('single', { repo: `github.com/org/r${i}`, short: `r${i}`, destination: { kind: 'team', ...core }, matches: [{ ...core, read_only: false }] }));
  assert.equal(rowsFor(many, { teams: teams.member }).length, 20);
  const [mixed] = rowsFor([row('ask', { matches: [{ ...core, read_only: false }, { ...web, read_only: true }] })], { teams: teams.member });
  assert.deepEqual(mixed.choices.map((c) => c.key), ['k-core', 'local']);
  assert.ok(!mixed.change.some((c) => c.key === 'k-web'));
  for (const r of rowsFor([row('ask', { matches: [{ ...core, read_only: false }] }), row('unlinked')], { teams: teams.admin })) {
    assert.ok(!/[\\]|\/Users|\/home/.test(JSON.stringify({ ...r, repo: '' })), JSON.stringify(r));
  }
  assert.deepEqual(rowsFor(null), []);
});

test('#62 review: colliding board names say the team; the row label says "goes to", not the arrow', () => {
  const other = { key: 'k-ops-core', team: 'Ops', board: 'Core' };
  const [ask] = rowsFor([row('ask', { matches: [{ ...core, read_only: false }, { ...other, read_only: false }, { ...web, read_only: false }] })], { teams: teams.member });
  assert.deepEqual(ask.choices.map((c) => c.label), ['Plexiform · Core', 'Ops · Core', 'Website', 'Keep on My board']);
  const [single] = rowsFor([row('single', { destination: { kind: 'team', ...core }, matches: [{ ...core, read_only: false }] })], { teams: teams.member });
  assert.equal(single.label, 'app goes to Plexiform / Core');
  assert.equal(ask.label, ask.text, 'a question has no arrow to explain');
  const [kept] = rowsFor([row('set')], { teams: teams.admin });
  assert.equal(kept.label, `app goes to ${MY_BOARD}`);
});
