// The role matrix (ACCOUNTS-DESIGN.md §3, CONTRACT D60) in one place. Roles:
// owner > admin > member > viewer. `viewer` stays the read-only role of the
// whole team (no guest/board_guests yet): it reads every board of its team,
// including the journal, but changes nothing.
//
// can(member, action, ctx) answers "may this membership do that"; the role
// ceilings (who may hand out or change which role) are separate helpers. A
// removed member (removed_at set) can do nothing.

export const ROLES = Object.freeze(['owner', 'admin', 'member', 'viewer']);
export const RANK = Object.freeze({ owner: 4, admin: 3, member: 2, viewer: 1 });
export const INVITABLE_ROLES = Object.freeze(['admin', 'member', 'viewer']);   // never owner

const ALL = ['owner', 'admin', 'member', 'viewer'];
const WRITERS = ['owner', 'admin', 'member'];
const ADMINS = ['owner', 'admin'];
const OWNER = ['owner'];

// action → roles allowed. Keep in step with the §3 table (permissions.test.js
// checks every row for every role).
export const MATRIX = Object.freeze({
  'team.read': ALL,              // team, its boards, the member list (names)
  'setups.read': ALL,
  'setups.publish': WRITERS,
  'setups.baseline': ADMINS,
  'board.read': ALL,             // board, cards, card detail, handover, feed, journal
  'members.emails': ADMINS,      // member emails in the member list
  'card.write': WRITERS,         // create / edit / move cards, labels, assignees
  'comment': WRITERS,
  'dispatch': WRITERS,           // Tackle with AI (own or another member's runner)
  'run.control': WRITERS,        // stop / cancel / retry / take over / hand over / answer / approve
  'device.enrol': WRITERS,       // be a dispatch target / enrol a runner
  'label.write': WRITERS,        // board label registry: create, recolour, describe (D91)
  'label.manage': ADMINS,        // … rename and delete: both rewrite cards across the board
  'board.create': ADMINS,
  'board.rename': ADMINS,
  'board.archive': ADMINS,
  'repo.manage': ADMINS,
  'team.settings': ADMINS,       // rename
  'invite.create': ADMINS,
  'invite.list': ADMINS,
  'invite.revoke': ADMINS,
  'member.role': ADMINS,         // plus the ceilings below
  'member.remove': ADMINS,       // plus: anyone may remove themselves (leave)
  'audit.read': ADMINS,
  'team.delete': OWNER,
});

export function can(member, action, ctx = {}) {
  if (!member || member.removed_at) return false;
  const roles = MATRIX[action];
  if (!roles) throw new Error(`unknown permission ${action}`);
  if (action === 'member.remove' && ctx.target && ctx.target.id === member.id) return true;
  if (!roles.includes(member.role)) return false;
  if (action === 'member.remove' && ctx.target?.role === 'owner' && member.role !== 'owner') return false;
  return true;
}

export const isAdmin = (m) => can(m, 'repo.manage');
export const canWrite = (m) => can(m, 'card.write');

/** May `actor` invite someone as `role`? Never owner, never above the actor's own role. */
export function canInviteAs(actor, role) {
  return can(actor, 'invite.create') && INVITABLE_ROLES.includes(role) && RANK[role] <= RANK[actor.role];
}

/**
 * May `actor` change `target`'s role to `role`? Admins change only non-owners
 * and never grant owner; owners change anyone, including making owners.
 * (The last owner staying an owner is checked separately, with the team's
 * other owners in view.)
 */
export function canSetRole(actor, target, role) {
  if (!ROLES.includes(role) || !can(actor, 'member.role')) return false;
  if (actor.role === 'owner') return true;
  return target.role !== 'owner' && role !== 'owner' && RANK[role] <= RANK[actor.role];
}
