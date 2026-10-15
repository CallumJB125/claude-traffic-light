'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkspaceStore, teamWsId } = require('../buddy-window/workspaces');
const { testTempDir } = require('./helpers/tmp');

const FIRST = 'https://first-hub.example';
const SECOND = 'https://second-hub.example';
const firstTeams = [{ id: 'first-team', name: 'First team', role: 'member' }];
const secondTeams = [{ id: 'second-team', name: 'Second team', role: 'owner' }];

function fixture(t) {
  const file = path.join(testTempDir('plexiform-workspace-hydration-', t), 'workspaces.json');
  const initial = createWorkspaceStore(file);
  for (const [hub, teams] of [[FIRST, firstTeams], [SECOND, secondTeams]]) {
    initial.addHub(hub);
    initial.setTeams(hub, { teams });
  }
  assert.equal(initial.activateTeam(SECOND, 'second-team'), true);
  const available = new Set([FIRST]);
  let visibilityChecks = 0;
  const store = createWorkspaceStore(file, { signedIn: hub => { visibilityChecks += 1; return available.has(hub); } });
  return { file, store, available, visibilityChecks: () => visibilityChecks,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

for (const changed of [false, true]) {
  test(`refreshing one hub ${changed ? 'with new teams' : 'without changes'} preserves a different hub awaiting credential hydration`, t => {
    const f = fixture(t), remembered = teamWsId(SECOND, 'second-team');
    assert.equal(f.store.active().id, 'local', 'a pending account remains hidden');
    assert.equal(f.store.get(remembered), null);
    const before = f.visibilityChecks();
    const teams = changed ? [...firstTeams, { id: 'new-team', name: 'New team' }] : firstTeams;
    assert.equal(f.store.setTeams(FIRST, { teams }), changed);
    assert.equal(f.visibilityChecks(), before, 'metadata validation does not consult credential visibility');
    assert.equal(f.store.activeId(), remembered);
    assert.equal(f.read().active, remembered);
    assert.equal(f.store.active().id, 'local');
    assert.deepEqual(f.store.list().filter(w => w.kind === 'team').map(w => w.hub), changed ? [FIRST, FIRST] : [FIRST]);
    f.available.add(SECOND);
    assert.equal(f.store.active().id, remembered, 'the saved team returns when its account is ready');
    assert.equal(createWorkspaceStore(f.file).activeId(), remembered);
  });
}

test('forgetting another hub preserves the remembered hidden workspace until its own account hydrates', t => {
  const f = fixture(t), remembered = teamWsId(SECOND, 'second-team');
  const before = f.visibilityChecks();
  f.store.forgetTeams(FIRST);
  assert.equal(f.visibilityChecks(), before);
  assert.equal(f.store.activeId(), remembered);
  assert.equal(f.read().active, remembered);
  assert.equal(f.store.active().id, 'local');
  assert.deepEqual(f.store.list(), [{ id: 'local', name: 'My board', kind: 'local' }]);
  f.available.add(SECOND);
  assert.equal(f.store.active().id, remembered);
  assert.deepEqual(f.store.list().filter(w => w.kind === 'team').map(w => w.hub), [SECOND]);
});

test('refreshing a hidden active hub from account data preserves its existing team', t => {
  const f = fixture(t), remembered = teamWsId(SECOND, 'second-team');
  assert.equal(f.store.setTeams(SECOND, { teams: [{ ...secondTeams[0], name: 'Renamed team' }] }), true);
  assert.equal(f.store.activeId(), remembered);
  assert.equal(f.read().active, remembered);
  assert.equal(f.store.active().id, 'local');
  f.available.add(SECOND);
  assert.equal(f.store.active().name, 'Renamed team');
});

test('fresh account data that removes the hidden active team permanently selects the local board', t => {
  const f = fixture(t);
  assert.equal(f.store.setTeams(SECOND, { teams: [{ id: 'replacement-team', name: 'Replacement' }] }), true);
  assert.equal(f.store.activeId(), 'local');
  assert.equal(f.read().active, 'local');
  f.available.add(SECOND);
  assert.equal(f.store.active().id, 'local');
  assert.equal(createWorkspaceStore(f.file).activeId(), 'local');
});

test('confirmed sign-out forgets the active hidden team and persists local selection', t => {
  const f = fixture(t);
  f.store.forgetTeams(SECOND);
  assert.equal(f.store.activeId(), 'local');
  assert.equal(f.read().active, 'local');
  assert.deepEqual(f.read().teams[SECOND], []);
  f.available.add(SECOND);
  assert.equal(f.store.active().id, 'local');
  assert.equal(f.store.list().some(w => w.hub === SECOND), false);
});

test('refreshes use the current configured team set instead of the startup snapshot', t => {
  const f = fixture(t);
  f.available.add(SECOND);
  f.store.setTeams(SECOND, { teams: [...secondTeams, { id: 'newly-joined', name: 'New team' }] });
  assert.equal(f.store.activateTeam(SECOND, 'newly-joined'), true);
  const remembered = teamWsId(SECOND, 'newly-joined');
  f.available.delete(SECOND);
  f.store.setTeams(FIRST, { teams: [{ ...firstTeams[0], name: 'Updated first team' }] });
  assert.equal(f.store.activeId(), remembered);
  assert.equal(f.read().active, remembered);
  f.store.forgetTeams(FIRST);
  assert.equal(f.store.activeId(), remembered);
  f.store.setTeams(SECOND, { teams: secondTeams });
  assert.equal(f.store.activeId(), 'local', 'removing the newly joined team is authoritative');
  assert.equal(f.read().active, 'local');
});
