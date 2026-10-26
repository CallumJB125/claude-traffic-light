// One rule for "can Plexiform deliver an answer to this?" (src/answerability.js), shared by the widget, Home, the
// Inbox and the Waiting page. The table is the contract: a surface that shows a button main would refuse is a bug.
const test = require('node:test');
const assert = require('node:assert/strict');
const { answerability, reasonText, errorText, openErrorText, optionsSentence, LAST_RESORT } = require('../src/answerability.js');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const hook = (over = {}) => ({ id: 'r1', kind: 'permission', source: 'hook', answerable: true, actions: ['answer', 'open'], expires_at: new Date(NOW + 30_000).toISOString(), ...over });
const session = (over = {}) => ({ id: 'ask-h-s', kind: 'question', source: 'session', answerable: false, actions: ['open'], expires_at: null, ...over });

test('a live hook request is answerable when answering is on', () => {
  assert.deepEqual(answerability(hook(), { askFromWidget: true, now: NOW }), { answerable: true, reason: null, action: 'answer' });
  assert.equal(answerability(hook({ answering: true }), { now: NOW }).answerable, true, 'the flag main puts on the input');
});

test('the table of what is not answerable, and why', () => {
  const rows = [
    ['hook request, setting off', hook(), { askFromWidget: false }, { answerable: false, reason: 'setting-off', action: 'open' }],
    ['hook request, expired', hook({ expires_at: new Date(NOW - 1).toISOString() }), { askFromWidget: true }, { answerable: false, reason: 'expired', action: 'open' }],
    ['hook request carrying answering:false', hook({ answering: false }), {}, { answerable: false, reason: 'setting-off', action: 'open' }],
    ['no signed decision', hook({ answerable: false }), { askFromWidget: true }, { answerable: false, reason: 'session-reported', action: 'go-to-terminal' }],
    ['Claude session question, setting off', session(), { askFromWidget: false }, { answerable: false, reason: 'setting-off', action: 'go-to-terminal' }],
    ['Claude session question, setting on (a pre-hook session)', session(), { askFromWidget: true }, { answerable: false, reason: 'session-reported', action: 'go-to-terminal' }],
    ['Claude permission prompt reported by a notification, setting off', session({ kind: 'notification', notification_type: 'permission_prompt' }), { askFromWidget: false }, { answerable: false, reason: 'setting-off', action: 'go-to-terminal' }],
    ['an idle notification: the setting is not the reason', session({ kind: 'notification', notification_type: 'idle_prompt' }), { askFromWidget: false }, { answerable: false, reason: 'session-reported', action: 'go-to-terminal' }],
    ['Codex permission: turning it on would not help', session({ kind: 'permission', provider: 'codex' }), { askFromWidget: false }, { answerable: false, reason: 'session-reported', action: 'go-to-terminal' }],
    ['a tmux dialog', { id: 'dialog-1', kind: 'dialog', source: 'tmux', answerable: false, actions: ['open'] }, { askFromWidget: true }, { answerable: false, reason: 'terminal', action: 'go-to-terminal' }],
    ['a blocked call', { id: 'b1', kind: 'blocked', source: 'session', answerable: false, actions: ['open'] }, { askFromWidget: true }, { answerable: false, reason: 'blocked', action: 'open' }],
    ['nothing', null, {}, { answerable: false, reason: 'gone', action: 'open' }],
  ];
  for (const [name, req, ctx, want] of rows) assert.deepEqual(answerability(req, { now: NOW, ...ctx }), want, name);
});

test('every reason has a sentence, and none has the raw code in it', () => {
  for (const r of ['setting-off', 'expired', 'session-reported', 'terminal', 'blocked', 'gone']) assert.ok(reasonText(r).length > 10 && /\s/.test(reasonText(r)), r);
  assert.equal(reasonText(null), '');
});

test('errors read as sentences: off, not allowed and invalid are mapped; a sentence from main passes; the rest is the last resort', () => {
  assert.match(errorText('off'), /Answering from here is off.*Settings › Widget/);
  assert.match(errorText('not allowed'), /can’t answer that/);
  assert.match(errorText('invalid'), /didn’t look right/);
  assert.equal(errorText('no longer waiting (answered, timed out, or answer it in the terminal)'), 'no longer waiting (answered, timed out, or answer it in the terminal)');
  for (const raw of ['ENOENT', undefined, '', 'x'.repeat(400)]) assert.equal(errorText(raw), LAST_RESORT);
});

test('open-input: the jump’s own `cant` is passed through, then its note, then a default', () => {
  assert.equal(openErrorText({ ok: false, cant: 'It is on another computer.' }), 'It is on another computer.');
  assert.equal(openErrorText({ ok: false, note: 'Run tmux attach.' }), 'Run tmux attach.');
  assert.equal(openErrorText({ ok: false, error: 'gone' }), 'It is no longer waiting.');
  assert.equal(openErrorText(null), 'Could not find its terminal.');
});

test('the choices of a question that can’t be answered here are one sentence', () => {
  assert.equal(optionsSentence(['React', 'Vue']), 'In the terminal: React or Vue.');
  assert.equal(optionsSentence(['A', 'B', 'C']), 'In the terminal: A, B or C.');
  assert.equal(optionsSentence(['Only']), 'In the terminal: Only.');
  assert.equal(optionsSentence([]), '');
});
