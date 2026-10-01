// What the bubble shows for each waiting input, and which option a key means
// (src/input-view.js). Enter must never be the riskiest choice.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/input-view.js');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const later = (s) => new Date(NOW + s * 1000).toISOString();
const perm = (over = {}) => ({ v: 1, id: 'r1', kind: 'permission', source: 'hook', tool: 'Bash', cwd: '/w/app', title: 'Allow Bash?', text: 'npm test', headline: 'npm test', created_at: ago(1), expires_at: later(30), answerable: true, actions: ['answer', 'open'], danger: null, enterAllow: true,
  options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session-0', label: 'Allow Bash(npm:*) for this session' }, { id: 'deny', label: 'Deny' }], ...over });

test('a row: project, one-line headline per kind', () => {
  assert.equal(V.project(perm()), 'app');
  assert.equal(V.project({}), 'session');
  assert.equal(V.headline(perm()), 'Bash: npm test');
  assert.equal(V.headline({ kind: 'plan', text: '# Plan\n\n1. do it' }), 'Plan: # Plan 1. do it');
  assert.equal(V.headline({ kind: 'question', questions: [{ question: 'Which\nframework?' }] }), 'Which framework?');
  assert.equal(V.headline({ kind: 'blocked', tool: 'Bash' }), 'Needs your decision');
  assert.equal(V.headline({ kind: 'dialog', title: 'Trust this folder?' }), 'Trust this folder?');
  assert.ok(V.headline(perm({ headline: 'x'.repeat(300) })).length <= 80, 'capped');
});

test('age and escalation after five minutes', () => {
  assert.equal(V.ageText(perm({ created_at: ago(0.2) }), NOW), 'just now');
  assert.equal(V.ageText(perm({ created_at: ago(4) }), NOW), 'waiting 4 min');
  assert.equal(V.ageText(perm({ created_at: ago(75) }), NOW), 'waiting 1 h 15 min');
  assert.equal(V.ageText({ created_at: null }, NOW), '');
  assert.equal(V.escalated(perm({ created_at: ago(4) }), NOW), false);
  assert.equal(V.escalated(perm({ created_at: ago(5) }), NOW), true);
});

test('expired: the hook stopped waiting, so it can only be opened', () => {
  const x = perm({ expires_at: ago(0.1) });
  assert.equal(V.expired(x, NOW), true);
  assert.equal(V.canAnswer(x, NOW), false);
  assert.deepEqual(V.primary(x, NOW), { type: 'open' });
  assert.equal(V.denyOption(x, NOW), null);
  assert.match(V.rowLabel(x, NOW), /answer in terminal/);
});

test('Enter: allow once for a plain permission, never a session grant, never a flagged command', () => {
  assert.deepEqual(V.primary(perm(), NOW), { type: 'option', id: 'allow' });
  assert.equal(V.primary(perm({ danger: 'recursive delete' }), NOW), null);
  assert.equal(V.primary(perm({ danger: 'it could not be checked' }), NOW), null);
  assert.equal(V.primary(perm({ danger: undefined }), NOW), null, 'unchecked is not safe');
  assert.equal(V.primary(perm({ enterAllow: false }), NOW), null, 'not on the allow-list: a click');
  assert.equal(V.primary(perm({ enterAllow: undefined }), NOW), null);
  assert.equal(V.primary(perm({ options: [{ id: 'allow-session-0', label: 'x' }, { id: 'deny', label: 'Deny' }] }), NOW), null);
  assert.equal(V.primary(perm({ kind: 'plan', options: [{ id: 'allow' }, { id: 'allow-accept-edits' }, { id: 'deny' }] }), NOW), null, 'a plan is approved by a click after reading, never by Enter');
  assert.equal(V.denyOption(perm({ kind: 'plan', options: [{ id: 'allow' }, { id: 'deny' }] }), NOW), 'deny', '⌘. still means keep planning');
  assert.equal(V.primary(perm({ kind: 'question', options: [{ id: 'q0o0' }, { id: 'deny' }] }), NOW), null, 'no guessing an answer');
  assert.equal(V.primary(perm({ kind: 'elicitation', options: [{ id: 'accept' }] }), NOW), null);
  assert.deepEqual(V.primary({ kind: 'dialog', actions: ['open'], answerable: false }, NOW), { type: 'open' });
  assert.deepEqual(V.primary({ kind: 'blocked', actions: ['open'], answerable: false }, NOW), { type: 'open' });
});

test('⌘.: deny, or decline for a form; nothing for what cannot be answered', () => {
  assert.equal(V.denyOption(perm(), NOW), 'deny');
  assert.equal(V.denyOption(perm({ kind: 'elicitation', options: [{ id: 'accept' }, { id: 'decline' }, { id: 'cancel' }] }), NOW), 'decline');
  assert.equal(V.denyOption({ kind: 'dialog', answerable: false, actions: ['open'], options: [] }, NOW), null);
});

test('option tones: deny is "no", session grants are "wide", a flagged allow is "risky"', () => {
  assert.equal(V.optionTone(perm(), { id: 'deny' }), 'no');
  assert.equal(V.optionTone(perm(), { id: 'allow-session-2' }), 'wide');
  assert.equal(V.optionTone(perm(), { id: 'allow' }), 'yes');
  assert.equal(V.optionTone(perm({ danger: 'x' }), { id: 'allow' }), 'risky');
});

test('questions: one pick sends its own option id; free text and multi-select send answers', () => {
  const q = { kind: 'question', options: [{ id: 'q0o0' }, { id: 'q0o1' }, { id: 'deny' }], questions: [{ id: 'q0', question: 'Which framework?', multiSelect: false, options: [{ id: 'q0o0', label: 'React' }, { id: 'q0o1', label: 'Vue' }] }] };
  assert.deepEqual(V.questionAnswer(q, { q0: ['q0o1'] }), { optionId: 'q0o1' });
  assert.deepEqual(V.questionAnswer(q, {}, { q0: ' Svelte ' }), { optionId: 'answers', answers: { 'Which framework?': 'Svelte' } });
  assert.match(V.questionAnswer(q, {}).error, /Answer/);
  const multi = { kind: 'question', options: [{ id: 'deny' }], questions: [
    { id: 'q0', question: 'Which?', multiSelect: true, options: [{ id: 'q0o0', label: 'A' }, { id: 'q0o1', label: 'B' }] },
    { id: 'q1', question: 'When?', multiSelect: false, options: [{ id: 'q1o0', label: 'Now' }] }] };
  assert.deepEqual(V.questionAnswer(multi, { q0: ['q0o0', 'q0o1'], q1: ['q1o0'] }), { optionId: 'answers', answers: { 'Which?': 'A, B', 'When?': 'Now' } });
  assert.deepEqual(V.questionAnswer(multi, { q0: ['nope'], q1: ['q1o0'] }).error !== undefined, true, 'an unknown option id is no answer');
});

test('elicitation form: fields from the schema, typed content out', () => {
  const fields = V.formFields({ type: 'object', required: ['name'], properties: { name: { type: 'string', title: 'Name' }, n: { type: 'integer' }, ok: { type: 'boolean' }, env: { type: 'string', enum: ['dev', 'prod'] }, odd: { type: 'object' }, constructor: { type: 'boolean' }, hasOwnProperty: { type: 'string' } } });
  assert.deepEqual(fields.map((f) => [f.name, f.type, f.required]), [['name', 'string', true], ['n', 'integer', false], ['ok', 'boolean', false], ['env', 'enum', false], ['odd', 'string', false]]);
  assert.match(V.formContent(fields, {}).error, /Name is required/);
  assert.match(V.formContent(fields, { name: 'a', n: '1.5' }).error, /whole number/);
  assert.match(V.formContent(fields, { name: 'a', env: 'staging' }).error, /Pick/);
  assert.deepEqual(V.formContent(fields, { name: ' a ', n: '3', ok: true, env: 'dev' }).content, { name: 'a', n: 3, ok: true, env: 'dev' });
  assert.deepEqual(V.formFields(null), []);
  assert.deepEqual(V.formContent(fields, Object.assign(Object.create({ name: 'inherited' }), {})).error, 'Name is required', 'inherited values are not values');
});

test('the widget shows two: answerable ones first, then the oldest; the rest as "+N more"', () => {
  const list = [perm({ id: 'c', created_at: ago(1) }), perm({ id: 'a', created_at: ago(9) }), perm({ id: 'b', created_at: ago(5) })];
  const { shown, more } = V.visible(list, 2, NOW);
  assert.deepEqual(shown.map((i) => i.id), ['a', 'b']);
  assert.equal(more, 1);
  assert.equal(V.visible(list, Infinity, NOW).more, 0);
  const note = { id: 'n', kind: 'notification', answerable: false, actions: ['open'], created_at: ago(30) };
  assert.deepEqual(V.visible([note, perm({ id: 'p', created_at: ago(1) })], 1, NOW).shown.map((i) => i.id), ['p']);
});
