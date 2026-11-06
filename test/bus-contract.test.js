'use strict';
// src/bus-contract.js: the frozen vocabulary other lanes import. Shapes and invariants only.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/bus-contract.js');

test('every enum is frozen and maps names to themselves where it is a code set', () => {
  for (const k of ['TIERS', 'TIER_CAN', 'REPO_REASON', 'REPO_REASON_TEXT', 'REPO_ALLOWED', 'BUS_REASON', 'BREAKER_STATE', 'BREAKER_REASON', 'BOARD_KIND', 'BOARD_WHY', 'SYSTEM_NOTE']) {
    assert.ok(Object.isFrozen(C[k]), k);
  }
  for (const set of [C.REPO_REASON, C.REPO_ALLOWED, C.BUS_REASON, C.BREAKER_REASON]) for (const [k, v] of Object.entries(set)) assert.equal(k, v);
});

test('every repo reason has one sentence with no path', () => {
  for (const r of Object.values(C.REPO_REASON)) {
    const s = C.REPO_REASON_TEXT[r];
    assert.ok(typeof s === 'string' && s.length > 10 && s.length < 200, r);
    assert.doesNotMatch(s, /\/Users\/|\/home\//);
  }
});

test('tiers: every tier has a capability list; unverified and headless never hand off or receive notes', () => {
  for (const t of Object.values(C.TIERS)) assert.ok(Array.isArray(C.TIER_CAN[t]), t);
  for (const t of [C.TIERS.UNVERIFIED_CLIENT, C.TIERS.HEADLESS]) {
    assert.ok(!C.TIER_CAN[t].includes('handoff'));
    assert.ok(!C.TIER_CAN[t].includes('notes'));
  }
});

test('providers: receivers are a subset of providers, the fallback order is drawn from providers', () => {
  for (const p of C.RECEIVE_PROVIDERS) assert.ok(C.PROVIDERS.includes(p));
  for (const p of C.DEFAULT_FALLBACK) assert.ok(C.PROVIDERS.includes(p));
  assert.ok(!C.PROVIDERS.includes(C.ANY_PROVIDER));
  assert.deepEqual(C.DEFAULT_FALLBACK, ['claude', 'codex', 'gemini']);
});

test('provider health shape and cooldowns', () => {
  const h = C.providerHealth('codex');
  assert.deepEqual(Object.keys(h).sort(), ['failures', 'provider', 'reason', 'retry_at', 'since', 'state']);
  assert.equal(h.state, 'closed');
  for (const r of Object.values(C.BREAKER_REASON)) assert.ok(C.BREAKER_COOLDOWN_MS[r] > 0, r);
  assert.equal(C.providerHealth('codex', { state: 'open', reason: 'QUOTA', retry_at: 5 }).retry_at, 5);
});

test('trace ids and spans', () => {
  assert.ok(C.isTraceId('tr_0123456789abcdef'));
  assert.ok(!C.isTraceId('tr_0123456789ABCDEF'));
  assert.ok(!C.isTraceId('tr_0123'));
  assert.ok(C.isSpanId('sp_deadbeef'));
  assert.ok(!C.isSpanId('sp_deadbeef0'));
  assert.ok(C.TRACE_FIELDS.includes('trace_id') && !C.TRACE_FIELDS.some((f) => /body|text|path|title|brief/.test(f)));
});

test('board why covers the seven rules and every kind is named', () => {
  for (const w of ['personal_mark', 'inherited', 'linked_repo', 'choose', 'no_link_suggested', 'no_repo', 'deferred']) assert.ok(Object.values(C.BOARD_WHY).includes(w), w);
  assert.deepEqual(Object.values(C.BOARD_KIND).sort(), ['choose', 'none', 'personal', 'team']);
  assert.equal(C.NOTICE_MIN_INTERVAL_MS, 120_000);
});
