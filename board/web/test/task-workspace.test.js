import test from 'node:test';
import assert from 'node:assert/strict';
import { drawer, drawerTab } from '../js/render-drawer.js';
import { byAttr, byClass, textOf } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { model, view } from './fixtures.js';

const packet = { version: 2, author: { name: 'Alice' }, data: { brief: 'Fix the selected session', progress: 'Saved checkpoint', decisions: ['Keep the exact recipient'], nextAction: 'Review the acknowledgement' } };
const detail = (extra = {}) => ({ cardId: 'c-1', tab: 'overview', packetLoaded: true, packet,
  data: { card: view(), body: 'Original task request', feed: [{ id: 'event-1', kind: 'progress', text: 'Latest reported work', at_age_ms: 12000 }], asks: [], permission_requests: [], comments: [] }, ...extra });
const render = (d, extra = {}) => drawer(model([{ view: d.data.card, face: displayFace(d.data.card), elapsed_ms: 0 }], { detail: d, ...extra }));
const value = (tree, name) => byAttr(tree, 'name', name)[0]?.props.value;

function withDesktop(bridge, run) {
  const previous = globalThis.plexiformDesktop;
  globalThis.plexiformDesktop = bridge;
  try { run(); } finally {
    if (previous === undefined) delete globalThis.plexiformDesktop;
    else globalThis.plexiformDesktop = previous;
  }
}

test('new task opens Overview; explicit sections and an existing tab retain navigation', () => {
  assert.equal(drawerTab(null), 'overview');
  assert.equal(drawerTab(null, 'messages'), 'messages');
  for (const tab of ['overview', 'activity', 'packet', 'messages', 'ownership', 'handover', 'comments', 'details']) assert.equal(drawerTab(tab, 'overview'), tab);
  for (const section of ['asks', 'overlaps', 'review']) assert.equal(drawerTab(section, 'overview'), 'activity');
  const tree = render(detail({ tab: undefined }));
  assert.equal(byAttr(tree, 'role', 'tablist').length, 1);
  assert.equal(byAttr(tree, 'role', 'tabpanel').length, 1);
  assert.equal(byAttr(tree, 'id', 'tab-overview')[0].props['aria-selected'], 'true');
});

test('Overview summarizes current work and saved decisions without duplicating editors', () => {
  const tree = render(detail()), text = textOf(tree);
  for (const phrase of ['Run ownerAlice', 'Running', 'Fix the selected session', 'Latest reported work', 'Saved checkpoint', 'Keep the exact recipient', 'Review the acknowledgement', 'No pending requests recorded']) assert.ok(text.includes(phrase), phrase);
  for (const tab of ['activity', 'packet', 'messages', 'ownership', 'handover']) assert.ok(byAttr(tree, 'data-tab', tab).some(n => n.props.role !== 'tab'));
  assert.equal(byAttr(tree, 'data-form', 'task-packet').length, 0);
  assert.equal(byAttr(tree, 'data-form', 'task-message').length, 0);
  assert.equal(byAttr(tree, 'data-action', 'open-session').length, 0);
  assert.equal(byClass(tree, 'task-workspace').length, 1);
});

test('reported sessions use existing exact-session controls and show stale reports honestly', () => {
  const d = detail({ packet: null });
  d.data.card = view({ run: null, run_state: 'todo', capture: { source: 'local_observation', provider: 'codex', tracking: 'active', status: 'working', reported_status: 'working', fresh: true, age_ms: 70000,
    summary: 'Goal: Reported request\n\nReported checkpoint' } });
  withDesktop({ openSession() {} }, () => {
    const tree = render(d), text = textOf(tree);
    assert.match(text, /Reported Codex · no recent report/);
    assert.match(text, /Session ownerNot recorded on this card/);
    assert.match(text, /Reported request/); assert.match(text, /Reported checkpoint/);
    assert.match(text, /Task messages go to managed board runs/);
    const actions = byAttr(tree, 'data-action', 'open-session');
    assert.equal(actions.length, 1); assert.equal(actions[0].props['data-card'], 'c-1');
  });
  withDesktop(undefined, () => {
    const tree = render(d);
    assert.equal(byAttr(tree, 'data-action', 'open-session').length, 0);
    assert.match(textOf(tree), /Open this session in your AI tool/);
  });
});

test('pending requests reuse existing answer and approval authority once', () => {
  const d = detail();
  d.data.asks = [{ id: 'a1', state: 'open', text: 'Which path?' }, { id: 'a2', state: 'answered', text: 'Old question' }];
  d.data.permission_requests = [{ id: 'p1', state: 'open', approvers: ['m-bob'], tool: 'Edit', input_summary: 'selected.js' }];
  const tree = render(d);
  assert.equal(byAttr(tree, 'data-form', 'answer').length, 1);
  assert.equal(byAttr(tree, 'id', 'sec-asks').length, 1);
  assert.equal(byAttr(tree, 'data-action', 'permission').length, 0);
  assert.match(textOf(tree), /You're not an approver on this run/);
  assert.doesNotMatch(textOf(tree), /Old question|No pending requests/);
});

test('empty, offline and unavailable context remains useful without inventing progress', () => {
  const d = detail({ packet: null, packetError: 'Connection refused', error: 'Refresh failed' });
  d.data.body = ''; d.data.feed = [];
  const tree = render(d, { conn: { status: 'lost' } }), text = textOf(tree);
  for (const phrase of ['Board connection unavailable', 'Task refresh failed', 'No request recorded', 'No progress update recorded', 'Task context unavailable']) assert.ok(text.includes(phrase), phrase);
  assert.equal(byAttr(tree, 'data-action', 'communication-reload').length, 1);
  const loading = render(detail({ packet: null, packetLoaded: false }));
  assert.match(textOf(loading), /Loading shared context/);
  const archived = detail({ packet: null, packetLoaded: false }); archived.data.card = view({ archived: { by_name: 'Alice' } });
  assert.match(textOf(render(archived)), /Restore this task to access shared context/);
});

test('Overview preserves draft values when returning to context and Messages', () => {
  const d = detail({ packetDraft: { brief: 'Unsaved brief', decisions: 'Unsaved decision', progress: '', nextAction: '', paths: '', reportedChecks: '', evidence: [], expected_version: 2, expected_fence: 2 },
    messageDraft: { recipient: 'run-2', kind: 'question', body: 'Unsent question' }, messagesLoaded: true,
    messages: { messages: [], peers: [{ run_id: 'run-2', card_key: 'BDL-2', name: 'Bob', provider: 'codex' }] } });
  const before = structuredClone(d);
  assert.match(textOf(render(d)), /unsaved task context draft/);
  assert.match(textOf(render(d)), /unsent message draft/);
  assert.doesNotMatch(textOf(render(d)), /Unsaved decision/);
  assert.equal(value(render({ ...d, tab: 'packet' }), 'brief'), 'Unsaved brief');
  assert.equal(value(render({ ...d, tab: 'messages' }), 'body'), 'Unsent question');
  assert.deepEqual(d, before);
});
