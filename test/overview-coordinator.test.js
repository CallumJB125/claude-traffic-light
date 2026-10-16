'use strict';
// Real coordinator + existing guarded session controls, injected provider,
// actual Overview markup and renderer. No provider CLI or paid turn is started.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { createTeamCoordinator } = require('../src/team-coordinator');
const { createTeamSessionControls } = require('../src/team-session-controls');
const ROOT = path.join(__dirname, '..'), TEAM = 'a'.repeat(32), ID = 'b'.repeat(40);
const HOSTILE = '<img src=x onerror="globalThis.pwned=1">';
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
function fixture({ busy = false, available = true } = {}) {
  const calls = [], state = { generation: 1, activeTurn: busy ? crypto.randomUUID() : null, status: busy ? 'working' : 'ready', capabilities: { newTurn: true }, deliveries: [] };
  const hub = { inspect: async () => ({ ok: true, state: structuredClone(state) }),
    act: async (_v, _t, _ref, command, _request, fresh) => { assert.equal(fresh(), true); calls.push(command); const delivery = { id: crypto.randomUUID(), text: command.text, state: 'acknowledged', response: '' }; state.deliveries.push(delivery); return { ok: true, status: 'acknowledged', delivery }; } };
  const controls = createTeamSessionControls({ resolve: async () => ({ hub, viewer: { id: 'human' }, team: 'private-team', ref: 'private-ref', scope: 'interact' }) });
  const entry = { id: ID, kind: 'shared', scope: 'team', teams: [{ key: TEAM }], owner: { name: `Bob ${HOSTILE}` }, provider: { id: 'codex', label: 'Codex' }, device: { label: 'Bob’s device' }, task: { title: 'Review parser' }, state: 'Idle', freshness: 'recent', observedAt: Date.now(), interact: { kind: 'team', ref: ID }, capabilities: { receive: { available: true } }, messageContract: 'live' };
  const coordinator = createTeamCoordinator({ inspect: controls.inspect, action: controls.action, inventory: async () => ({ schema: 1, view: 'team', status: 'complete', observed_at: Date.now(), team: { key: TEAM, name: 'Dev' }, entries: [entry] }) });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'overview.html'), 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = dom.window.document, $ = id => doc.getElementById(id);
  const option = doc.createElement('option'); option.value = TEAM; $('team-pick').append(option);
  $('team-section').hidden = false;
  dom.window.overviewApi = available ? { coordinator: Object.fromEntries(['inventory', 'propose', 'confirm', 'results', 'cancel'].map(k => [k, r => Promise.resolve(coordinator[k](structuredClone(r)))])) } : {};
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'overview-coordinator.js'), 'utf8'));
  $('coordinator-panel').open = true;
  async function draft() {
    $('coordinator-refresh').click(); await tick();
    $('coordinator-title').value = 'Compare parser review';
    doc.querySelector('[aria-label="Assignment name"]').value = 'Parser reviewer';
    doc.querySelector('[aria-label="Assignment session"]').value = ID;
    doc.querySelector('[aria-label="Assignment message"]').value = `Please inspect this exact change ${HOSTILE}`;
  }
  return { dom, doc, $, calls, state, coordinator, draft, close: () => dom.window.close() };
}
test('reachable assignments panel requires exact review and individual unchecked grant before real guarded dispatch', async () => {
  const x = fixture();
  try {
    assert.equal(x.$('coordinator-panel').hidden, false); await x.draft();
    x.$('coordinator-review').click(); await tick();
    assert.equal(x.$('coordinator-preview').hidden, false); assert.equal(x.calls.length, 0);
    assert.match(x.$('coordinator-results').textContent, /Bob/); assert.match(x.$('coordinator-results').textContent, /Please inspect this exact change/);
    assert.equal(x.doc.querySelector('img'), null); assert.equal(x.$('coordinator-confirm').disabled, true);
    const grant = x.$('coordinator-results').querySelector('input[type="checkbox"]'); assert.equal(grant.checked, false);
    grant.checked = true; grant.dispatchEvent(new x.dom.window.Event('change'));
    assert.equal(x.$('coordinator-confirm').disabled, false);
    x.$('coordinator-confirm').click(); x.$('coordinator-confirm').click(); await tick();
    assert.equal(x.calls.length, 1); assert.equal(x.calls[0].operation, 'send'); assert.equal(x.calls[0].text, `Please inspect this exact change ${HOSTILE}`);
    assert.equal(x.$('coordinator-replies').hidden, false); assert.match(x.$('coordinator-status').textContent, /1 assignment/);
    x.state.deliveries[0].response = `Parser result ${HOSTILE}`; x.state.deliveries[0].state = 'completed';
    x.state.deliveries.push({ id: crypto.randomUUID(), text: 'Unrelated', state: 'completed', response: 'Unrelated private response' });
    x.$('coordinator-replies').click(); await tick();
    assert.match(x.$('coordinator-results').textContent, /Parser result/); assert.doesNotMatch(x.$('coordinator-results').textContent, /Unrelated private response/); assert.equal(x.doc.querySelector('img'), null);
  } finally { x.close(); }
});
test('busy target produces a blocked review without silently steering, queueing or creating a paid turn', async () => {
  const x = fixture({ busy: true });
  try { await x.draft(); x.$('coordinator-review').click(); await tick(); assert.match(x.$('coordinator-results').textContent, /Blocked/); assert.equal(x.$('coordinator-confirm').disabled, true); assert.equal(x.calls.length, 0); }
  finally { x.close(); }
});
for (const mutation of ['edit', 'blur', 'team']) test(`${mutation} retires the exact approval while preserving no stale send control`, async () => {
  const x = fixture();
  try {
    await x.draft(); x.$('coordinator-review').click(); await tick();
    if (mutation === 'edit') { const box = x.doc.querySelector('[aria-label="Assignment message"]'); box.value += ' updated'; box.dispatchEvent(new x.dom.window.Event('input')); }
    if (mutation === 'blur') x.dom.window.dispatchEvent(new x.dom.window.Event('blur'));
    if (mutation === 'team') x.$('team-pick').dispatchEvent(new x.dom.window.Event('change'));
    await tick(); assert.equal(x.$('coordinator-preview').hidden, true); assert.equal(x.$('coordinator-confirm').disabled, true); assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});
test('missing coordinator bridge leaves unsupported panel hidden', () => {
  const x = fixture({ available: false }); try { assert.equal(x.$('coordinator-panel').hidden, true); assert.equal(x.calls.length, 0); } finally { x.close(); }
});
