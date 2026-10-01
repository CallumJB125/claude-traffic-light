// Accounts mode in the web board: the signed-out screen follows the hub's
// sign-in methods, a new account with no team gets create-or-join (not
// "not a member"), and owners and admins can invite from the Team view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byAttr, byClass } from '../js/h.js';
import { signinScreen, noTeamScreen } from '../js/render-signin.js';
import { invitePanel, teamScreen } from '../js/render-team.js';
import { topBar } from '../js/render-board.js';
import { EMAIL_OFF, INVITE_REPLAYED } from '../js/account-text.js';
import { model } from './fixtures.js';

test('signed out: email sign-in when the hub mails; the app pointer when it does not', () => {
  const on = signinScreen({ status: 'signed_out', accounts: true });
  assert.equal(byAttr(on, 'href', '/signin').length, 1);
  const off = signinScreen({ status: 'signed_out', accounts: true, emailOff: true });
  assert.equal(byAttr(off, 'href', '/signin').length, 0, 'no email button on a hub without a mailer');
  assert.match(textOf(off), new RegExp(EMAIL_OFF.slice(0, 30)));
});

test('no team yet: create a team and join with a code or link, never a dead end', () => {
  const v = noTeamScreen({});
  const t = textOf(v);
  assert.match(t, /Create or join a team/);
  assert.doesNotMatch(t, /isn't a member|Ask a board admin|GitHub login/);
  assert.equal(byAttr(v, 'data-form', 'create-team').length, 1);
  assert.equal(byAttr(v, 'data-form', 'join-team').length, 1);
  assert.equal(byAttr(v, 'data-action', 'signout').length, 1, 'a way out to another account');
  assert.equal(byAttr(v, 'data-action', 'accept-invite').length, 0);
});

test('no team yet, with an invite addressed to you: one click joins it; errors sit under their form', () => {
  const v = noTeamScreen({ invites: [{ id: 'i1', team_name: 'Acme', inviter_first_name: 'Jo', role: 'viewer' }], onboard: { error: 'This team is full.', where: 'invites' } });
  assert.match(textOf(v), /Jo invited you to Acme as a viewer\./);
  assert.equal(byAttr(v, 'data-invite', 'i1').length, 1);
  const alerts = byAttr(v, 'role', 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(textOf(alerts[0]), 'This team is full.');
});

test('invite panel: owners and admins in accounts mode only; the link and code show once with copy buttons', () => {
  const base = { accounts: true, me: { member: { id: 'm-alice', role: 'owner' }, org: { id: 't1' } } };
  assert.equal(invitePanel({ ...base, accounts: false }), null);
  assert.equal(invitePanel({ ...base, me: { member: { id: 'm', role: 'member' } } }), null);
  const empty = invitePanel(base);
  assert.equal(byAttr(empty, 'data-form', 'team-invite').length, 1);
  assert.equal(byAttr(empty, 'value', 'owner').length, 0, 'never invites an owner');
  const made = invitePanel({ ...base, invite: { made: { email: 'sam@example.com', link: 'https://h/invite#inv_x', code: 'BCDF-GHJK', mailed: false } } });
  assert.match(textOf(made), /Nothing was emailed: send sam@example.com the link or the code yourself\./);
  assert.match(textOf(made), /BCDF-GHJK/);
  assert.equal(byAttr(made, 'data-action', 'copy-invite').length, 2);
  assert.equal(byAttr(made, 'data-action', 'resend-invite').length, 0);
  // A replayed request (REPLAYED): the invite exists, its link was shown once already; offer Resend.
  const replayed = invitePanel({ ...base, invite: { error: INVITE_REPLAYED, resend: { email: 'sam@example.com' } } });
  assert.equal(INVITE_REPLAYED, 'This invite was already made. Resend it to get a new link.');
  assert.match(textOf(replayed), /This invite was already made\. Resend it to get a new link\./);
  const b = byAttr(replayed, 'data-action', 'resend-invite');
  assert.equal(b.length, 1);
  assert.equal(textOf(b[0]), 'Resend');
  assert.equal(byAttr(invitePanel({ ...base, invite: { error: 'This team is full.' } }), 'data-action', 'resend-invite').length, 0, 'only when there is something to resend');
  const t = teamScreen(model([], { view: 'team', presence: { members: [], loaded: true, stale: false }, ...base, me: { member: { id: 'm-alice', role: 'admin' }, org: { id: 't1' } } }));
  assert.equal(byClass(t, 'team-invite').length, 1, 'the Team view carries it');
});

test('top bar: an Invite button opens the Team view for owners and admins in accounts mode', () => {
  const bar = (role, accounts = true) => topBar(model([], { accounts, me: { member: { id: 'm', role, display_name: 'Jo' } } }), {});
  const invite = (v) => byAttr(v, 'data-view', 'team').length;
  assert.equal(invite(bar('owner')), 1);
  assert.equal(invite(bar('admin')), 1);
  assert.equal(invite(bar('member')), 0);
  assert.equal(invite(bar('owner', false)), 0);
});
