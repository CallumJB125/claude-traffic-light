'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeView } = require('../src/burst-route.js');

const NOW = Date.parse('2026-10-07T10:00:00Z');
const state = (over = {}) => ({
  route: 'SECONDARY', overflow: false, reason: 'Claude hit its limit', claim: 'five_hour', until: '2026-10-07T11:30:00Z',
  rejected: [{ model: 'claude-opus-5', until: '2026-10-07T10:05:00Z', fallsBackTo: 'claude-sonnet-5' }],
  primaryFailures: 2, secondaryReady: true,
  primary: { provider: 'anthropic', model: '', strategy: '', keyPresent: true },
  secondary: { provider: 'together', model: 'glm-5', strategy: 's', keyPresent: true, keychain_service: 'burst-together', key_env_var: 'TOGETHER_KEY', base_url: 'https://api.together.xyz/v1?token=abc' },
  downgrade: { enabled: true, chain: { 'claude-opus-5': ['claude-sonnet-5'] } },
  ...over,
});

test('countdowns come from `until` and the injected clock', () => {
  const v = routeView(state(), null, { now: NOW });
  assert.equal(v.untilInMs, 90 * 60 * 1000);
  assert.equal(v.rejected[0].resetInMs, 5 * 60 * 1000);
  const later = routeView(state(), null, { now: NOW + 2 * 3600 * 1000 });
  assert.equal(later.untilInMs, 0);
  assert.equal(routeView(state({ until: '' }), null, { now: NOW }).untilInMs, null);
  assert.equal(routeView(state({ until: 'garbage' }), null, { now: NOW }).untilInMs, null);
});

test('the route view never carries keys, keychain names or base_url', () => {
  const v = routeView(state(), { fallback_chain: { a: ['b'] }, metered_failover: { window_seconds: 60, min_failures: 3 }, base_url: 'http://x', key_env_var: 'K' }, { now: NOW });
  const text = JSON.stringify(v);
  assert.ok(!/key_|keychain|base_url|keyPresent|together\.xyz|TOGETHER_KEY|token=abc/.test(text), text);
  assert.deepEqual(v.secondary, { provider: 'together', model: 'glm-5', ready: true });
  assert.deepEqual(v.primary, { provider: 'anthropic', model: '' });
});

test('shape: chain prefers the settings answer, failures and metered failover pass through', () => {
  const v = routeView(state(), { fallback_chain: { 'claude-opus-5': ['x', 'y'] }, metered_failover: { window_seconds: 60, min_failures: 3, transport_error_min_failures: 1 } }, { now: NOW });
  assert.equal(v.route, 'SECONDARY');
  assert.equal(v.claim, 'five_hour');
  assert.equal(v.primaryFailures, 2);
  assert.deepEqual(v.chain, { 'claude-opus-5': ['x', 'y'] });
  assert.deepEqual(v.meteredFailover, { windowSeconds: 60, minFailures: 3, transportErrorMinFailures: 1 });
  assert.deepEqual(routeView(state(), null, { now: NOW }).chain, { 'claude-opus-5': ['claude-sonnet-5'] });
  assert.equal(routeView(state(), null, { now: NOW }).meteredFailover, null);
  assert.equal(routeView(null, null), null);
});
