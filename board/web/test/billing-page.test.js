// /billing (web/js/billing.js): plan, seats and Manage billing, rendered
// from a GET /api/billing answer without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, findAll } from '../js/h.js';
import { billingView } from '../js/billing.js';

const prices = { 'plus:month': true, 'plus:year': true, 'team:month': true, 'team:year': false };
const free = { plan: 'free' };
const actions = (v) => findAll(v, (n) => n.props?.['data-action']).map((n) => n.props['data-action']);

test('free plan offers Plus monthly and yearly, and Team seats to an owner (at least the current members)', () => {
  const v = billingView({ summary: { configured: true, prices, effective_plan: 'free', plus: free, teams: [{ ...free, team: { id: 't1', name: 'Alpha', role: 'owner' }, seats_used: 4 }] } });
  const t = textOf(v);
  assert.match(t, /Your plan: Free/);
  assert.match(t, /Get Plus · \$5 \/ month/);
  assert.match(t, /Get Plus · \$48 \/ year/);
  assert.match(t, /Get Team · \$15 \/ seat \/ month/);
  assert.match(t, /never sees or stores your card details/);
  assert.equal(findAll(v, (n) => n.tag === 'input' && n.props.name === 'seats')[0].props.min, 4);
});

test('a cancelled Plus says it lasts to the period end; a failed payment says so; Manage billing appears', () => {
  const end = Date.UTC(2026, 10, 1) / 1000;
  const cancelled = billingView({ summary: { configured: true, prices, effective_plan: 'plus', teams: [], plus: { plan: 'plus', subscribed_plan: 'plus', status: 'active', interval: 'month', cancel_at_period_end: true, access_until: end, period_end: end, manageable: true } } });
  assert.match(textOf(cancelled), /Cancelled: you keep Plus until/);
  assert.deepEqual(actions(cancelled), ['portal']);
  const dunning = billingView({ summary: { configured: true, prices, effective_plan: 'free', teams: [], plus: { plan: 'free', subscribed_plan: 'plus', status: 'past_due', access_until: end, manageable: true } } });
  assert.match(textOf(dunning), /Ended .*Your data is kept/);
});

test('team seats used of paid, members cannot change the plan, and an unconfigured hub offers nothing to buy', () => {
  const team = { plan: 'team', subscribed_plan: 'team', status: 'active', seats: 6, seats_used: 5, interval: 'month', period_end: 1, access_until: 2e9, manageable: true };
  const owner = billingView({ summary: { configured: true, prices, effective_plan: 'team', plus: free, teams: [{ ...team, team: { id: 't', name: 'A', role: 'owner' } }] } });
  assert.match(textOf(owner), /5 of 6 paid seats used/);
  assert.ok(actions(owner).includes('team-portal'));
  const admin = billingView({ summary: { configured: true, prices, effective_plan: 'team', plus: free, teams: [{ ...team, team: { id: 't', name: 'A', role: 'admin' } }] } });
  assert.match(textOf(admin), /Only the team owner can change its plan/);
  assert.ok(!actions(admin).includes('team-portal'));
  const off = billingView({ summary: { configured: false, prices, effective_plan: 'free', plus: free, teams: [] } });
  assert.match(textOf(off), /not available on this hub/);
  assert.deepEqual(actions(off), []);
  assert.match(textOf(billingView({ signedOut: true })), /Sign in to see your plan/);
});
