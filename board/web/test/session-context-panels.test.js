import test from 'node:test';
import assert from 'node:assert/strict';
import { packetPanel, messagePanel } from '../js/render-communication.js';
import { ownershipPanel } from '../js/render-ownership.js';
import { reportedSessionContext } from '../js/local-session-context.js';
import { byAttr, textOf } from '../js/h.js';
import { model, view } from './fixtures.js';

const report = 'Goal: Fix the selected session\n\nThe reply now reaches the right session.\n\nFiles: src/router.js, test/router.test.js (+3 more)';
const captured = extra => view({ run_state: 'todo', run: null, live: null,
  capture: { source: 'local_observation', summary: report }, ...extra });
const detail = extra => ({ cardId: 'c-1', data: { card: captured(), body: report }, packetLoaded: true,
  messagesLoaded: true, messages: { messages: [], peers: [] }, ownershipLoaded: true,
  ownership: { ownership: null, ownership_intents: [], ownership_overlaps: [] }, ...extra });
const fieldValue = (tree, name) => byAttr(tree, 'name', name)[0]?.props.value;
function withDesktop(bridge, run) {
  const before = globalThis.plexiformDesktop;
  globalThis.plexiformDesktop = bridge;
  try { return run(); } finally {
    if (before === undefined) delete globalThis.plexiformDesktop;
    else globalThis.plexiformDesktop = before;
  }
}

test('captured context is shown without silently populating or saving a task packet', () => {
  const state = detail(), tree = packetPanel(state, model([]));
  assert.match(textOf(tree), /Fix the selected session/);
  assert.match(textOf(tree), /The reply now reaches the right session/);
  assert.match(textOf(tree), /src\/router\.js/);
  assert.match(textOf(tree), /3 more files were reported/);
  assert.match(textOf(tree), /does not send a message or start AI work/);
  const use = byAttr(tree, 'data-action', 'packet-use-report');
  assert.equal(use.length, 1); assert.equal(use[0].props['data-card'], state.cardId);
  for (const name of ['brief', 'decisions', 'progress', 'nextAction', 'paths', 'reportedChecks']) assert.equal(fieldValue(tree, name), '');
  assert.equal(state.packet, undefined); assert.equal(state.packetDraft, undefined);
});

test('saved packet and active draft remain authoritative when reported context differs', () => {
  const packet = { version: 4, author: { name: 'Alice' }, data: { brief: 'Saved brief', progress: 'Human progress',
    decisions: ['Human decision'], nextAction: 'Human next action', reportedChecks: ['Human statement'], artifacts: [{ kind: 'path', path: 'saved.js' }] } };
  const saved = packetPanel(detail({ packet }), model([]));
  assert.equal(fieldValue(saved, 'brief'), 'Saved brief'); assert.equal(fieldValue(saved, 'progress'), 'Human progress');
  assert.equal(fieldValue(saved, 'paths'), 'saved.js'); assert.equal(fieldValue(saved, 'decisions'), 'Human decision');
  assert.equal(byAttr(saved, 'data-action', 'packet-use-report').length, 0);
  const draft = { brief: 'Unsaved work', progress: 'Typed progress', paths: 'draft.js', decisions: '', nextAction: '', reportedChecks: '', expected_version: 4, expected_fence: 2, evidence: [] };
  const drafted = packetPanel(detail({ packet, packetDraft: draft }), model([]));
  assert.equal(fieldValue(drafted, 'brief'), 'Unsaved work'); assert.equal(fieldValue(drafted, 'paths'), 'draft.js');
  assert.equal(byAttr(drafted, 'data-action', 'packet-use-report').length, 0);
  assert.equal(byAttr(drafted, 'data-action', 'packet-reload').length, 1);
});

test('reported context obeys captured-card provenance and manual body overrides', () => {
  assert.equal(reportedSessionContext(detail({ data: { card: view(), body: report } })), null);
  const fallback = detail({ data: { card: captured({ capture: { source: 'local_observation', managed: { body: true } } }), body: report } });
  assert.equal(reportedSessionContext(fallback).goal, 'Fix the selected session');
  assert.equal(reportedSessionContext(detail({ data: { card: captured({ capture: { source: 'local_observation', managed: { body: false } } }), body: report } })), null);
  const precedence = detail({ data: { card: captured(), body: 'Goal: Manually edited card' } });
  assert.equal(reportedSessionContext(precedence).goal, 'Fix the selected session');
  assert.equal(reportedSessionContext(detail({ data: { card: captured({ run: { id: 'current-run' }, run_state: 'running' }), body: report } })), null);
});

test('read-only, archived and failed packet views do not offer report import or save', () => {
  for (const readonly of [model([], { readOnly: true }), model([], { me: { member: { role: 'viewer' } } }), model([], { board: { archived_at: 'today' } })]) {
    const tree = packetPanel(detail(), readonly);
    assert.equal(byAttr(tree, 'data-action', 'packet-use-report').length, 0);
    assert.equal(byAttr(tree, 'data-form', 'task-packet').length, 0);
  }
  for (const state of [detail({ data: { card: captured({ archived: {} }), body: report } }), detail({ packetError: 'Sign in again' })]) {
    const tree = packetPanel(state, model([]));
    assert.equal(byAttr(tree, 'data-action', 'packet-use-report').length, 0);
    assert.doesNotMatch(textOf(tree), /Fix the selected session/);
  }
});

test('captured Messages distinguishes session controls from board-run task messages', () => withDesktop({ openSession() {} }, () => {
  const tree = messagePanel(detail(), model([]));
  assert.match(textOf(tree), /do not enter this reported session/);
  assert.match(textOf(tree), /this exact session supports direct messages/);
  assert.match(textOf(tree), /No managed board runs/);
  assert.equal(byAttr(tree, 'data-form', 'task-message').length, 0);
  const open = byAttr(tree, 'data-action', 'open-session'); assert.equal(open.length, 1);
  assert.equal(open[0].props['data-card'], 'c-1');
}));

test('ordinary browser reports direct-message limit without advertising unavailable native controls', () => withDesktop(undefined, () => {
  const tree = messagePanel(detail(), model([]));
  assert.match(textOf(tree), /Use your AI tool/);
  assert.equal(byAttr(tree, 'data-action', 'open-session').length, 0);
}));

test('actual board-run task composer and evidence-specific receipts remain usable', () => withDesktop({ openSession() {} }, () => {
  const messages = { peers: [{ run_id: 'run-peer', card_key: 'PF-2', name: 'Bob', provider: 'codex' }], messages: [
    { id: 'message-one', card_key: 'PF-1', kind: 'question', author: { name: 'Alice' }, body: '<script>untrusted task text</script>', deliveries: [
      { provider: 'codex', recipient_name: 'Bob', state: 'acknowledged' }, { state: 'received' }, { state: 'pending' }] }] };
  const tree = messagePanel(detail({ data: { card: view() }, messages }), model([]));
  assert.equal(byAttr(tree, 'data-form', 'task-message').length, 1);
  assert.equal(byAttr(tree, 'data-action', 'open-session').length, 0);
  assert.match(textOf(tree), /Acknowledged \(agent reported\)/); assert.match(textOf(tree), /Received by host/);
  assert.match(textOf(tree), /Pending/); assert.match(textOf(tree), /<script>untrusted task text<\/script>/);
  assert.equal(byAttr(tree, 'innerHTML').length, 0);
  const observedWithPeers = messagePanel(detail({ messages }), model([]));
  assert.equal(byAttr(observedWithPeers, 'data-form', 'task-message').length, 1);
  assert.equal(byAttr(observedWithPeers, 'data-action', 'open-session').length, 1);
}));

test('Coordination keeps reported file activity separate from actual ownership declarations', () => withDesktop({ openTimeline() {} }, () => {
  const own = { run_id: 'owned-run', card_key: 'PF-1', card_title: 'Declared task', author: { name: 'Alice' }, paths: ['declared.js'], state: 'editing', expires_in_ms: 10000 };
  const tree = ownershipPanel(detail({ ownership: { ownership: own, ownership_intents: [own] } }), model([]));
  assert.match(textOf(tree), /Reported file activity/); assert.match(textOf(tree), /src\/router\.js/);
  assert.match(textOf(tree), /not ownership declarations or file locks/);
  assert.match(textOf(tree), /Declared work on this task/); assert.match(textOf(tree), /declared\.js/);
  assert.equal(byAttr(tree, 'data-action', 'open-timeline')[0].props['data-card'], 'c-1');
  assert.equal(byAttr(tree, 'data-tab', 'packet').length, 1);
  assert.equal(byAttr(tree, 'data-action').some(n => /send|release|claim|lock/.test(n.props['data-action'])), false);
}));

test('reported files alone never claim current ownership or lock files', () => withDesktop(undefined, () => {
  const tree = ownershipPanel(detail(), model([]));
  assert.match(textOf(tree), /This task has no current agent declaration/);
  assert.doesNotMatch(textOf(tree), /Agent active|fresh host signal/);
  assert.equal(byAttr(tree, 'data-action', 'open-timeline').length, 0);
  for (const state of [detail({ ownershipError: 'Sign in again' }), detail({ data: { card: captured({ archived: {} }), body: report } })]) {
    assert.doesNotMatch(textOf(ownershipPanel(state, model([]))), /src\/router\.js/);
  }
}));
