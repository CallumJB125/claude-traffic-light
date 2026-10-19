'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const tick = async () => { for (let n = 0; n < 8; n++) await new Promise(r => setImmediate(r)); };
function fixture(options = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'checkpoints.html'), 'utf8'), { runScripts: 'outside-only' });
  const calls = [], doc = dom.window.document;
  let change;
  const turn = { turn: 1, at: Date.now(), hasBefore: true, hasAfter: true, files: [{ path: 'main.txt', status: 'M', add: 1, del: 1 }], undoAvailable: true, ...options.turn };
  dom.window.checkpointsApi = {
    state: async () => ({ enabled: true, limits: { turns: 3, days: 7 }, sessions: [{ id: 'a', cwd: '/project', updatedAt: Date.now() }, { id: 'b', cwd: '/other', updatedAt: Date.now() }], models: [], review: { enabled: false, maxBudgetUsd: 0.1 }, reviewAllowed: false }),
    turns: async () => ({ turns: [turn], safety: [] }),
    changed: cb => { change = cb; },
    previewUndo: async (...args) => { calls.push(['preview', ...args]); return options.preview ? options.preview() : { ok: true, token: 'review', turn: 1, eligible: 1, skipped: 1, files: [{ path: '<img src=x onerror="pwned=1">', action: 'restore', reason: null }, { path: 'later.txt', reason: 'later-change' }] }; },
    undo: async (...args) => { calls.push(['undo', ...args]); change(); return options.result || { ok: true, written: 1, removed: 0, skipped: 1, safety: '123' }; },
    cancelUndo: async (...args) => { calls.push(['cancel', ...args]); return true; },
    restore: async (...args) => { calls.push(['whole-restore', ...args]); return { ok: false, reason: 'cancelled' }; },
  };
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'checkpoints.js'), 'utf8'));
  const button = text => [...doc.querySelectorAll('button')].find(b => b.textContent === text);
  return { dom, doc, calls, button, close: () => dom.window.close() };
}
test('review shows preserved later edits and literal paths, then requires an explicit one-time Undo', async () => {
  const x = fixture(); try {
    await tick(); x.button('Review Undo this turn').click(); await tick();
    assert.equal(x.calls.filter(c => c[0] === 'undo').length, 0);
    assert.match(x.doc.querySelector('.undo-review').textContent, /changed after this turn/);
    assert.equal(x.doc.querySelector('img'), null);
    x.button('Undo reviewed files').click(); x.button('Undo reviewed files').click(); await tick();
    assert.equal(x.calls.filter(c => c[0] === 'undo').length, 1); assert.match(x.doc.getElementById('status').textContent, /1 restored.*1 kept/);
    assert.ok(x.button('Restore whole project before turn 1'));
  } finally { x.close(); }
});
test('Cancel revokes the review without undoing anything', async () => {
  const x = fixture(); try { await tick(); x.button('Review Undo this turn').click(); await tick(); x.button('Cancel').click(); await tick(); assert.equal(x.doc.querySelector('.undo-review'), null); assert.deepEqual(x.calls.at(-1), ['cancel', 'a', 'review']); assert.equal(x.calls.some(c => c[0] === 'undo'), false); } finally { x.close(); }
});
test('switching sessions during preview cannot attach its review to another session', async () => {
  let resolve; const x = fixture({ preview: () => new Promise(r => { resolve = r; }) });
  try { await tick(); x.button('Review Undo this turn').click(); await tick(); const select = x.doc.getElementById('session'); select.value = 'b'; select.dispatchEvent(new x.dom.window.Event('change')); await tick(); resolve({ ok: true, token: 'old', files: [], eligible: 1, skipped: 0 }); await tick(); assert.equal(x.doc.querySelector('.undo-review'), null); assert.equal(x.calls.some(c => c[0] === 'undo'), false); } finally { x.close(); }
});
test('overlapping/old turns explain refusal and cannot offer safe Undo', async () => {
  const x = fixture({ turn: { undoAvailable: false, undoReason: 'overlap' } }); try { await tick(); assert.equal(x.button('Review Undo this turn'), undefined); assert.match(x.doc.getElementById('turns').textContent, /Another observed session/); } finally { x.close(); }
});
test('stale apply displays a useful refusal without claiming restoration', async () => {
  const x = fixture({ result: { ok: false, reason: 'stale' } }); try { await tick(); x.button('Review Undo this turn').click(); await tick(); x.button('Undo reviewed files').click(); await tick(); assert.match(x.doc.getElementById('status').textContent, /review changed or expired/); assert.doesNotMatch(x.doc.getElementById('status').textContent, /Turn undone/); } finally { x.close(); }
});
