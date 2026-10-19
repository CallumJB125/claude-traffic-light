'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('renderer projection keeps bounded collaboration metadata without authority or accidental task-id truncation', async () => {
  const P = await import('../board/tasks-api/protocol.js');
  const { taskFace } = await import('../board/tasks-api/face.js');
  const guard = require('../src/tasks-guard').createGuard({ P, taskFace });
  const receipt = { requestId: 'r1', kind: 'buddy_message', taskId: 'child', messageId: 'message-1', state: 'delivered', at: 123, permission: 'write', token: 'private' };
  const detail = guard.sanitizeDetail({ id: 'task-a', parentId: 'parent', collaboration: Array(55).fill(receipt) });
  assert.equal(detail.parentId, 'parent'); assert.equal(detail.collaboration.length, 50);
  assert.deepEqual(detail.collaboration[0], { requestId: 'r1', kind: 'buddy_message', taskId: 'child', messageId: 'message-1', state: 'delivered', at: 123 });
  assert.equal(guard.sanitizeTask({ id: 'task-a', parentId: 'x'.repeat(129) }).parentId, null);
  const bad = guard.sanitizeDetail({ id: 'task-a', collaboration: [{ ...receipt, state: 'acknowledged' }, { ...receipt, kind: 'grant_access' }, { ...receipt, at: Infinity }, { ...receipt, taskId: 'x'.repeat(129) }] });
  assert.equal(bad.collaboration.length, 1); assert.equal(bad.collaboration[0].taskId, null);
});

test('overview shows permitted task family, delivery receipts and exact message navigation without claiming a response', async t => {
  const row = (id, title, parentId) => ({ id, title, parentId, state: 'running', label: 'Working', tone: 'blue', green: true, actions: ['message'], confirm: [], ai: { id: 'codex' }, cost: { usd: 0, budgetUsd: null }, where: 'project', workInPlace: false, createdAtMs: Date.now(), stateSinceMs: Date.now(), text: 'Review authentication', messages: [], openApprovals: [], openAsk: null });
  const parent = row('task-a', 'Coordinator', null), child = row('task-b', '<img src=x onerror=bad()> Review', 'task-a');
  parent.messages = [{ id: 'm1', direction: 'out', from: { kind: 'task', id: parent.id }, to: { kind: 'task', id: child.id }, body: 'Please review the callback.', deliveredAt: 1 }];
  parent.collaboration = ['pending', 'queued', 'delivered', 'uncertain'].map((state, i) => ({ requestId: `request-${i}`, kind: i ? 'buddy_message' : 'buddy_spin_off', taskId: child.id, messageId: i === 2 ? 'm1' : null, state, at: i + 1 }));
  const state = { opened: [], rows: [parent, child], changed: null, event: null };
  const dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
  t.after(() => dom.window.close()); const w = dom.window, d = w.document;
  w.CSS ??= {}; w.CSS.escape ??= value => value; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.tasksApi = { state: async () => ({ conn: { status: 'connected' }, tasks: state.rows }),
    open: async id => { state.opened.push(id); return { ok: true, detail: structuredClone(state.rows.find(r => r.id === id)), replay: [] }; },
    close: async () => {}, onChanged: fn => state.changed = fn, onEvent: fn => state.event = fn };
  w.eval(read('src/tasks-view.js')); w.eval(read('tasks.js')); await tick();
  d.querySelector('[data-id="task-a"]').click(); await tick();
  let pane = d.getElementById('pane-overview');
  assert.match(pane.textContent, /Helping task:.*Review/);
  assert.match(pane.textContent, /Pending · no delivery confirmed/);
  assert.match(pane.textContent, /Queued · waiting for delivery/);
  assert.match(pane.textContent, /Delivered · no agent response confirmed/);
  assert.match(pane.textContent, /Delivery uncertain · check the conversation before retrying/);
  assert.equal(pane.querySelector('img'), null);
  [...pane.querySelectorAll('button')].find(b => b.textContent === 'View message').click();
  assert.equal(d.getElementById('pane-messages').hidden, false);
  assert.equal(d.activeElement.dataset.messageId, 'm1');
  d.getElementById('tab-overview').click();
  d.getElementById('pane-overview').querySelector('[aria-label^="Open task:"]').click(); await tick();
  pane = d.getElementById('pane-overview'); assert.match(pane.textContent, /Requested by: Coordinator/);
  pane.querySelector('[aria-label="Open task: Coordinator"]').click(); await tick();
  assert.deepEqual(state.opened, ['task-a', 'task-b', 'task-a']);
  state.rows = [parent]; state.changed({ conn: { status: 'connected' }, tasks: state.rows });
  pane = d.getElementById('pane-overview');
  assert.match(pane.textContent, /Not available in the current task list/);
  assert.equal(pane.querySelector('[aria-label^="Open task:"]'), null, 'a stale receipt cannot make an unavailable task actionable');
  const next = structuredClone(parent); next.collaboration = [{ ...parent.collaboration[0], state: 'delivered' }];
  state.event({ id: parent.id, event: { type: 'detail', detail: next } });
  assert.doesNotMatch(d.getElementById('pane-overview').textContent, /Pending ·/);
});
