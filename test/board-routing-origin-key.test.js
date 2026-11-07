'use strict';
// Decision 7, main's half: a hand-off run's originBoard is believed only for a team the person really belongs to,
// with a role that can write. Any other key (a team they left, a read-only board, a made-up key) routes as if the run
// had no asker's board at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeBoard, routeKey } = require('../src/work-capture.js');

const A = { hub: 'https://hub.example.test', user_id: 'u', team_id: 'team-a', board_id: 'board-a', repo_id: 'r-a', canonical_url: 'github.com/org/app', role: 'member' };
const RO = { ...A, team_id: 'team-r', board_id: 'board-r', repo_id: 'r-r', canonical_url: 'github.com/org/ro', role: 'viewer' };

test('an originBoard the person has no writable route for never puts the run on a team board', () => {
  for (const inherited of ['f'.repeat(64), routeKey(RO)]) {
    const r = routeBoard({ inherited, repo: 'github.com/org/elsewhere', routes: [A, RO] });
    assert.notEqual(r.kind, 'team', inherited);
    assert.notEqual(r.why, 'inherited');
  }
  assert.equal(routeBoard({ inherited: routeKey(A), repo: A.canonical_url, routes: [A, RO] }).why, 'inherited');
});
