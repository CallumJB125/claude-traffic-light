const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/request-templates.js');

test('templates: a built request carries sender, exact target, task, context version, expiry and the bounded text', () => {
  const r = T.buildRequest('status', { sender: 'Callum', target: 'a'.repeat(40), task: 'Fix login', contextVersion: 7, now: 1000, note: 'focus on auth' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.request), ['template', 'label', 'sender', 'target', 'task', 'contextVersion', 'sentAt', 'expiresAt']);
  assert.equal(r.request.expiresAt, 1000 + T.EXPIRY_MS);
  assert.match(r.text, /short status update/);
  assert.match(r.text, /Context from Callum: focus on auth$/);
  assert.equal(T.TEMPLATES.length, 4);
});

test('templates: unknown template or missing sender/target is refused before anything is sent', () => {
  assert.equal(T.buildRequest('rm-rf', { sender: 'a', target: 'b' }).ok, false);
  assert.equal(T.buildRequest('status', { sender: '', target: 'b' }).ok, false);
});

test('templates: receipt state follows the reported delivery and expires only while unanswered', () => {
  const r = T.buildRequest('plan', { sender: 'C', target: 't', now: 0 });
  assert.equal(T.receiptState(r.request, [], 1), 'sending');
  assert.equal(T.receiptState({ ...r.request, text: r.text }, [{ text: r.text, state: 'queued', response: '' }], 1), 'sent');
  assert.equal(T.receiptState({ ...r.request, text: r.text }, [{ text: r.text, state: 'acknowledged', response: '' }], 1), 'acknowledged');
  assert.equal(T.receiptState({ ...r.request, text: r.text }, [{ text: r.text, state: 'done', response: 'Here is the plan' }], T.EXPIRY_MS + 5), 'answered');
  assert.equal(T.receiptState({ ...r.request, text: r.text }, [], T.EXPIRY_MS + 5), 'expired');
});
