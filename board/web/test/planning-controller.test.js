// Execute the production controller function with fixed IO and no browser.
// This catches async account races and retained retry intent beyond render assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const production = source.slice(source.indexOf('async function savePlan('), source.indexOf('\nfunction movePlan('));
function controller(api) {
  let nextId = 0; const p = {}, applied = [], card = { id: 'c1', key: 'T-1', version: 1 }, state = { me: { member: { id: 'm1' } } };
  const context = { api, state, boardGeneration: 1, viewOf: () => card, plannerState: () => p, planner: p, boardReadOnly: () => false, requestId: () => `request-${++nextId}`, update() {}, applyCard: result => { applied.push(result); Object.assign(card, result.card); }, say() {}, toast() {}, errorText: e => e.code, boot() {} };
  vm.createContext(context); vm.runInContext(`${production}\nthis.savePlan = savePlan;`, context);
  return { ...context, p, card, applied, run: fields => context.savePlan('c1', fields) };
}
test('planning controller retries a lost reply with the original ID and version', async () => {
  const calls = []; let c;
  c = controller({ async planCard(_id, body) { calls.push({ ...body }); if (calls.length === 1) { c.card.version = 2; throw Object.assign(new Error('lost reply'), { code: 'NETWORK' }); } return { card: { ...c.card, due_date: body.due_date } }; } });
  await c.run({ due_date: '2026-10-01' }); await c.run({ due_date: '2026-10-01' });
  assert.deepEqual(calls.map(b => b.request_id), ['request-1', 'request-1']); assert.deepEqual(calls.map(b => b.version), [1, 1]); assert.equal(c.p.pending, null); assert.equal(c.applied.length, 1);
});
test('planning version conflict re-reads the actual card before a new intent', async () => {
  const calls = []; let reads = 0;
  const c = controller({ async planCard(_id, body) { calls.push({ ...body }); if (calls.length === 1) throw Object.assign(new Error('stale'), { code: 'VERSION_CONFLICT' }); return { card: { id: 'c1', version: 8 } }; }, async card(id) { assert.equal(id, 'c1'); reads++; return { card: { id, version: 7 } }; } });
  await c.run({ due_date: '2026-10-01' }); assert.equal(reads, 1); assert.equal(c.card.version, 7);
  await c.run({ due_date: '2026-10-01' }); assert.deepEqual(calls.map(b => b.version), [1, 7]); assert.notEqual(calls[0].request_id, calls[1].request_id);
});
test('planning async reply from an earlier actor never mutates the current account view', async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const c = controller({ async planCard() { entered(); await gate; return { card: { id: 'c1', title: 'OLD ACCOUNT CONTENT', version: 2 } }; } });
  const pending = c.run({ due_date: '2026-10-01' }); await reached; c.state.me.member.id = 'm2'; release(); await pending;
  assert.equal(c.applied.length, 0); assert.equal(c.card.version, 1);
});
