// hub/permissions.js against the §3 matrix (ACCOUNTS-DESIGN.md, CONTRACT D60),
// row by row for every role, plus the role ceilings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canInviteAs, canSetRole, MATRIX, ROLES, isAdmin, canWrite } from '../permissions.js';

const m = (role, extra = {}) => ({ id: `m-${role}`, org_id: 'o', role, removed_at: null, ...extra });
const O = m('owner');
const A = m('admin');
const M = m('member');
const V = m('viewer');

// action → [owner, admin, member, viewer]
const EXPECTED = {
  'team.read': [1, 1, 1, 1],
  'board.read': [1, 1, 1, 1],
  'members.emails': [1, 1, 0, 0],
  'card.write': [1, 1, 1, 0],
  'comment': [1, 1, 1, 0],
  'dispatch': [1, 1, 1, 0],
  'run.control': [1, 1, 1, 0],
  'device.enrol': [1, 1, 1, 0],
  'board.create': [1, 1, 0, 0],
  'repo.manage': [1, 1, 0, 0],
  'team.settings': [1, 1, 0, 0],
  'invite.create': [1, 1, 0, 0],
  'invite.list': [1, 1, 0, 0],
  'invite.revoke': [1, 1, 0, 0],
  'member.role': [1, 1, 0, 0],
  'member.remove': [1, 1, 0, 0],
  'audit.read': [1, 1, 0, 0],
  'team.delete': [1, 0, 0, 0],
};

test('every matrix row, every role', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), Object.keys(EXPECTED).sort(), 'the test covers every action');
  for (const [action, row] of Object.entries(EXPECTED)) {
    [O, A, M, V].forEach((who, i) => assert.equal(can(who, action), !!row[i], `${who.role} ${action}`));
  }
  assert.throws(() => can(O, 'nope'), /unknown permission/);
});

test('a removed member (or none) can do nothing; the hub wrappers follow the matrix', () => {
  for (const action of Object.keys(MATRIX)) assert.equal(can(m('owner', { removed_at: 'x' }), action), false, action);
  assert.equal(can(null, 'team.read'), false);
  assert.deepEqual([O, A, M, V].map(isAdmin), [true, true, false, false]);
  assert.deepEqual([O, A, M, V].map(canWrite), [true, true, true, false]);
});

test('remove: admins remove non-owners, owners anyone, everyone may leave', () => {
  for (const t of [A, M, V]) assert.equal(can(m('admin', { id: 'x' }), 'member.remove', { target: t }), true, t.role);
  assert.equal(can(A, 'member.remove', { target: O }), false, 'admin cannot remove an owner');
  assert.equal(can(O, 'member.remove', { target: m('owner', { id: 'o2' }) }), true);
  for (const who of [O, A, M, V]) assert.equal(can(who, 'member.remove', { target: who }), true, `${who.role} may leave`);
  assert.equal(can(M, 'member.remove', { target: V }), false);
  assert.equal(can(V, 'member.remove', { target: M }), false);
});

test('invite ceiling: never owner, never above your own role, only admins and owners', () => {
  assert.deepEqual(['admin', 'member', 'viewer', 'owner'].map((r) => canInviteAs(O, r)), [true, true, true, false]);
  assert.deepEqual(['admin', 'member', 'viewer', 'owner'].map((r) => canInviteAs(A, r)), [true, true, true, false]);
  for (const r of ROLES) {
    assert.equal(canInviteAs(M, r), false);
    assert.equal(canInviteAs(V, r), false);
  }
  assert.equal(canInviteAs(O, 'boss'), false);
});

test('role ceiling: only an owner makes or unmakes owners; admins move non-owners up to admin', () => {
  for (const to of ROLES) {
    for (const t of [O, A, M, V]) assert.equal(canSetRole(O, t, to), true, `owner sets ${t.role}→${to}`);
  }
  for (const t of [A, M, V]) {
    assert.deepEqual(['admin', 'member', 'viewer'].map((r) => canSetRole(A, t, r)), [true, true, true], t.role);
    assert.equal(canSetRole(A, t, 'owner'), false, `admin cannot promote ${t.role} to owner`);
  }
  for (const to of ROLES) assert.equal(canSetRole(A, O, to), false, 'admin cannot touch an owner');
  for (const who of [M, V]) for (const to of ROLES) assert.equal(canSetRole(who, V, to), false);
  assert.equal(canSetRole(O, M, 'guest'), false, 'unknown role');
});
