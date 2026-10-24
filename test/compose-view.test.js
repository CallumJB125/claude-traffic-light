'use strict';
// Home's task box, the pure part (src/compose-view.js): the route line, when Run is allowed, what Run sends.
// Callum (2026-10-24): nothing starts until Run. Here that means canRun/runDraft are the only way to a draft.
const test = require('node:test');
const assert = require('node:assert/strict');
const CV = require('../src/compose-view.js');

const F = { handle: 'h-1', label: '~/acme' };
function ready(over = {}) {
  const s = { ...CV.initial(), connected: true, text: 'fix the flaky login test', folder: F, ais: [{ id: 'claude', label: 'Claude', usable: true }, { id: 'codex', label: 'Codex', usable: true }], ...over };
  if (!('route' in over)) s.route = { key: CV.inputKey(s), seq: 1, result: { decision: 'run', ai: 'codex', reason: 'Codex: you set Codex for this repo', alternatives: [{ ai: 'claude', reason: 'Claude: also fine', usable: true }] } };
  if (!('preflight' in over)) s.preflight = { folder: F.handle, peers: [], key: 'k0' };
  return s;
}
const tie = (s) => ({ key: CV.inputKey(s), seq: 1, result: { decision: 'ask', ai: null, reason: 'Claude or Codex: no rule decides, so pick one', alternatives: [{ ai: 'claude', reason: 'Claude: 40% of its window', usable: true }, { ai: 'codex', reason: 'Codex: 40% of its window', usable: true }] } });

test('empty: no route line and Run is disabled', () => {
  const s = { ...CV.initial(), connected: true };
  assert.equal(CV.routeView(s).kind, 'none');
  assert.equal(CV.canRun(s), false);
  assert.equal(CV.runDraft(s, { requestId: 'r-12345678' }), null);
  assert.equal(CV.routeView(CV.initial()).kind, 'offline', 'a helper that is not running says so');
});

test('routed: the line names the AI and its reason; Run sends expectAi = the AI shown', () => {
  const s = ready();
  const v = CV.routeView(s);
  assert.equal(v.kind, 'routed');
  assert.equal(v.text, '→ Codex: you set Codex for this repo');
  assert.equal(CV.canRun(s), true);
  const d = CV.runDraft(s, { requestId: 'r-12345678' });
  assert.deepEqual(d, { text: s.text, folder: 'h-1', ai: 'auto', permissionLevel: 'auto-edits', requestId: 'r-12345678', peersKey: 'k0', expectAi: 'codex' });
  // An explicit Who pick needs no expectAi: the engine refuses with VALIDATION if one is sent with it.
  const pinned = ready({ ai: 'claude' });
  assert.equal(CV.runDraft(pinned, { requestId: 'r-12345678' }).expectAi, undefined);
});

test('finding 8: a route answers only the inputs it was asked for; newer requests and edits make it stale', () => {
  const s = ready();
  s.text += ' quickly';
  assert.equal(CV.routeView(s).kind, 'checking', 'an edit inside the debounce shows Checking…');
  assert.equal(CV.canRun(s), false, 'so ⌘↩ inside the debounce does nothing');
  const t = ready();
  t.pending = { key: CV.inputKey(t), seq: 2 };
  assert.equal(CV.routeView(t).kind, 'checking', 'a request in flight newer than the shown route');
  assert.equal(CV.canRun(t), false);
  for (const change of [{ folder: { handle: 'h-2', label: 'x' } }, { ai: 'claude' }, { perm: 'plan' }]) {
    assert.equal(CV.canRun({ ...ready(), ...change }), false, JSON.stringify(change));
  }
});

test('ask-me: a tie offers both, and Run waits for a pick; the pick is the expectAi', () => {
  const s = ready();
  s.route = tie(s);
  const v = CV.routeView(s);
  assert.equal(v.kind, 'ask');
  assert.deepEqual(v.choices.map((c) => c.ai), ['claude', 'codex']);
  assert.equal(CV.canRun(s), false);
  s.pick = 'codex';
  assert.equal(CV.canRun(s), true);
  assert.equal(CV.runDraft(s, { requestId: 'r-12345678' }).expectAi, 'codex');
  s.pick = 'gemini';
  assert.equal(CV.canRun(s), false, 'a pick that was not offered is no pick');
});

test('refused, peers and busy all keep Run disabled', () => {
  const r = ready();
  r.route = { key: CV.inputKey(r), seq: 1, result: { decision: 'refuse', code: 'CAPABILITY_MISSING', reason: "Codex can't ask you for approvals in the background", alternatives: [] } };
  assert.equal(CV.routeView(r).kind, 'refused');
  assert.equal(CV.canRun(r), false);
  const p = ready({ preflight: { folder: 'h-1', peers: [{ id: 't1' }, { id: 't2' }], key: 'k2' } });
  assert.equal(CV.canRun(p), false);
  assert.equal(CV.peersView(p).text, '2 other tasks are working in this project.');
  p.ackPeers = true;
  assert.equal(CV.canRun(p), true);
  assert.equal(CV.canRun(ready({ preflight: null })), false, 'no preflight for this folder yet');
  assert.equal(CV.canRun(ready({ preflight: { folder: 'other', peers: [], key: 'k' } })), false, 'a preflight for another folder');
  assert.equal(CV.canRun(ready({ busy: true })), false);
  assert.equal(CV.canRun(ready({ hidden: true })), false);
  assert.equal(CV.canRun(ready({ task: { id: 't', row: { state: 'running' } } })), false, 'one live task at a time from the box');
  assert.equal(CV.canRun(ready({ text: '   ' })), false);
  assert.equal(CV.canRun(ready({ text: 'x'.repeat(CV.TEXT_MAX + 1) })), false);
});

test('R1: live is an allowlist; parked, handed_over, unknown and missing states are not live', () => {
  for (const st of ['queued', 'claimed', 'running', 'quiet', 'blocked', 'handing_over']) assert.equal(CV.isLive(st), true, st);
  for (const st of ['parked', 'handed_over', 'suspended', 'orphaned', 'unresponsive', 'in_review', 'done', 'failed', 'reconnecting', 'some_new_state', undefined, null]) assert.equal(CV.isLive(st), false, String(st));
});

test('only Run and ⌘↩ (Ctrl+Enter) submit; plain Enter is a newline', () => {
  assert.equal(CV.isSubmitKey({ key: 'Enter' }), false);
  assert.equal(CV.isSubmitKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(CV.isSubmitKey({ key: 'Enter', metaKey: true }), true);
  assert.equal(CV.isSubmitKey({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(CV.isSubmitKey({ key: 'a', metaKey: true }), false);
});

test('Codex has no "Ask me first"; Who lists unusable AIs disabled', () => {
  assert.deepEqual(CV.permOptions('codex').map((o) => o.value), ['plan', 'auto-edits']);
  assert.deepEqual(CV.permOptions('auto').map((o) => o.value), ['plan', 'ask', 'auto-edits']);
  const who = CV.whoOptions([{ id: 'claude', usable: true }, { id: 'codex', usable: false }]);
  assert.deepEqual(who.map((w) => [w.value, w.disabled]), [['auto', false], ['claude', false], ['codex', true]]);
});

test('the running card: needs approval points to Tasks; Stop only while live and offered', () => {
  const now = 1_000_000;
  const run = CV.cardView({ id: 't', title: 'fix it\nmore', row: { state: 'running', label: 'Running', ai: { id: 'codex' }, actions: ['stop'], stateSinceMs: now - 90_000 }, lines: ['a', 'b', 'c', 'd'] }, now);
  assert.equal(run.title, 'fix it');
  assert.equal(run.status, 'Codex · Running · 1 min');
  assert.deepEqual(run.lines, ['b', 'c', 'd']);
  assert.equal(run.canStop, true);
  const blocked = CV.cardView({ id: 't', title: 'x', row: { state: 'blocked', label: 'Needs you', reason: 'Bash: npm test', ai: { id: 'claude' }, actions: ['stop'] }, lines: [] }, now);
  assert.equal(blocked.needsApproval, true);
  assert.equal(blocked.approval, 'Needs your approval: Bash: npm test');
  assert.equal(blocked.tone, 'waiting');
  const parked = CV.cardView({ id: 't', title: 'x', row: { state: 'parked', label: 'Parked', ai: { id: 'claude' }, actions: ['stop'] } }, now);
  assert.equal(parked.canStop, false);
  assert.equal(CV.eventLine({ type: 'tool', phase: 'start', name: 'Bash', summary: 'npm  test' }), '▸ Bash npm test');
  assert.equal(CV.eventLine({ type: 'transcript', role: 'user', text: 'x' }), null);
});
