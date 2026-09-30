// The bubble's DOM (input-bubble.js) under jsdom: untrusted text stays text,
// one answer per input, keys, the cap, and what each kind offers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const later = (s) => new Date(NOW + s * 1000).toISOString();

function setup(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="b"></div></body>');
  global.document = dom.window.document;
  const calls = { answer: [], open: [], rule: [], waiting: 0 };
  let reply = opts.reply || (() => ({ ok: true }));
  const api = {
    answerInput: async (id, optionId, more) => { calls.answer.push([id, optionId, more]); return reply(id, optionId); },
    openInput: async (id) => { calls.open.push(id); return { ok: true }; },
    openAutoRule: (id) => calls.rule.push(id),
    openWaiting: () => { calls.waiting++; },
  };
  const root = dom.window.document.getElementById('b');
  const bubble = require('../input-bubble.js').create(root, { api, mode: opts.mode || 'widget', now: () => opts.now || NOW });
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const key = (k, extra = {}) => bubble.keydown(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { dom, root, bubble, calls, $, $$, key, setReply: (f) => { reply = f; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const perm = (over = {}) => ({ v: 1, id: 'r1', kind: 'permission', source: 'hook', tool: 'Bash', cwd: '/w/app', title: 'Allow Bash?', text: 'npm test', headline: 'npm test', created_at: ago(1), expires_at: later(40), answerable: true, actions: ['answer', 'open'],
  options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session-0', label: 'Allow Bash(npm:*) for this session' }, { id: 'deny', label: 'Deny' }], ...over });

test('untrusted text is only ever text: markup in a command, title or option stays inert', () => {
  const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
  const t = setup();
  t.bubble.update([perm({ text: evil, headline: evil, title: evil, cwd: `/w/${evil}`, options: [{ id: 'allow', label: evil }, { id: 'deny', label: 'Deny' }] })]);
  assert.equal(t.root.querySelectorAll('img, script').length, 0);
  assert.ok(t.$('.ib-text').textContent.includes('<img'));
  assert.ok(t.$('.ib-opt').textContent.includes('<script>'));
});

test('one input opens straight away; clicking allow sends once, however many clicks, then it is gone', async () => {
  const t = setup();
  t.bubble.update([perm()]);
  const allow = t.$('[data-option="allow"]');
  allow.click(); allow.click(); t.$('[data-option="deny"]').click();
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[1]), ['allow']);
  assert.equal(t.$$('.ib-item').length, 0, 'answered: hidden while main catches up');
  t.bubble.update([perm()]);
  assert.equal(t.$$('.ib-item').length, 0, 'still hidden until it leaves the list');
  t.bubble.update([]);
  t.bubble.update([perm({ id: 'r2' })]);
  assert.equal(t.$$('.ib-item').length, 1, 'a new ask shows');
});

test('a refused answer (answered elsewhere) says so and unlocks nothing twice', async () => {
  const t = setup({ reply: () => ({ ok: false, error: 'no longer waiting (answered, timed out, or answer it in the terminal)' }) });
  t.bubble.update([perm()]);
  t.$('[data-option="allow"]').click();
  await tick();
  assert.match(t.$('.ib-err').textContent, /no longer waiting/);
  t.bubble.update([]);
  assert.equal(t.$$('.ib-item').length, 0, 'answered in the terminal: it disappears');
});

test('expired: "answer in terminal", no answer buttons, Open it jumps to the terminal', async () => {
  const t = setup();
  t.bubble.update([perm({ expires_at: ago(0.1) })]);
  assert.match(t.$('.ib-age').textContent, /answer in terminal/);
  assert.match(t.$('.ib-expired').textContent, /answer in terminal/);
  assert.equal(t.$('[data-option="allow"]'), null);
  t.$('.ib-open').click();
  await tick();
  assert.deepEqual(t.calls.open, ['r1']);
});

test('Enter allows once; never a flagged command; ⌘. denies; Esc collapses then dismisses', async () => {
  const t = setup();
  t.bubble.update([perm({ danger: 'recursive delete', text: 'rm -rf build' })]);
  assert.match(t.$('.ib-warn').textContent, /recursive delete/);
  assert.equal(t.$('[data-option="allow"]').className.includes('tone-risky'), true);
  t.key('Enter');
  await tick();
  assert.equal(t.calls.answer.length, 0, 'Enter does not allow a deny-listed command');
  assert.match(t.$('.ib-err').textContent, /Enter won’t allow/);
  t.key('.', { metaKey: true });
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[1]), ['deny']);

  const u = setup();
  u.bubble.update([perm()]);
  u.key('Enter');
  await tick();
  assert.deepEqual(u.calls.answer.map((c) => c[1]), ['allow']);

  const v = setup();
  v.bubble.update([perm()]);
  v.key('Escape');
  assert.equal(v.$$('.ib-body').length, 0, 'collapsed');
  v.key('Escape');
  assert.match(v.$('.ib-pill').textContent, /1 waiting on you/, 'dismissed to a pill, not lost');
  v.$('.ib-pill').click();
  assert.equal(v.$$('.ib-item').length, 1);
});

test('a deny carries the typed reason', async () => {
  const t = setup();
  t.bubble.update([perm()]);
  const f = t.$('.ib-reason');
  f.value = 'use the test script';
  f.dispatchEvent(new t.dom.window.Event('input'));
  t.$('[data-option="deny"]').click();
  await tick();
  assert.deepEqual(t.calls.answer[0], ['r1', 'deny', { message: 'use the test script' }]);
});

test('the widget caps at two rows plus "+N more", which opens the Waiting page', () => {
  const t = setup();
  t.bubble.update([perm({ id: 'a', created_at: ago(9) }), perm({ id: 'b', created_at: ago(6) }), perm({ id: 'c', created_at: ago(2) }), perm({ id: 'd', created_at: ago(1) })]);
  assert.deepEqual(t.$$('.ib-item').map((n) => n.dataset.id), ['a', 'b']);
  assert.equal(t.$$('.ib-body').length, 0, 'several: rows stay compact');
  assert.equal(t.$('.ib-item.late').dataset.id, 'a', 'waiting 5 min or more: escalated');
  assert.match(t.$('.ib-more').textContent, /\+2 more/);
  t.$('.ib-more').click();
  assert.equal(t.calls.waiting, 1);
  const p = setup({ mode: 'page' });
  p.bubble.update([perm({ id: 'a' }), perm({ id: 'b' }), perm({ id: 'c' })]);
  assert.equal(p.$$('.ib-item').length, 3, 'the page shows every one');
});

test('blocked: the reason and three suggestions, none of them ever sent', async () => {
  const t = setup();
  t.bubble.update([{ v: 1, id: 'blocked-h-s-1', kind: 'blocked', source: 'session', tool: 'Bash', cwd: '/w/app', title: 'Blocked: Bash needs your decision', text: 'rm -rf /tmp/x\nReason: [Irreversible Local Destruction]', reason: '[Irreversible Local Destruction]',
    options: [{ id: 'run-yourself', label: 'Run it yourself' }, { id: 'switch-mode', label: 'Switch permission mode' }, { id: 'add-rule', label: 'Add a rule' }], created_at: ago(1), expires_at: null, answerable: false, actions: ['open'] }]);
  assert.match(t.$('.ib-head').textContent, /blocked: needs your decision/);
  assert.match(t.$('.ib-text').textContent, /Reason: \[Irreversible/);
  assert.equal(t.$('.ib-reason-text'), null, 'the reason is in the text already: not twice');
  t.$('[data-option="switch-mode"]').click();
  assert.match(t.$('.ib-note').textContent, /Shift\+Tab/);
  t.$('[data-option="add-rule"]').click();
  t.$('[data-option="run-yourself"]').click();
  await tick();
  assert.deepEqual(t.calls.rule, ['blocked-h-s-1']);
  assert.deepEqual(t.calls.open, ['blocked-h-s-1']);
  assert.equal(t.calls.answer.length, 0);
});

test('dialog: the terminal’s own choices shown read-only, and Open it', async () => {
  const t = setup();
  t.bubble.update([{ v: 1, id: 'dialog-x', kind: 'dialog', dialog: 'trust-folder', source: 'tmux', cwd: '/w/app', title: 'Trust this folder?', text: 'Quick safety check', options: [{ id: '1', label: 'Yes, I trust this folder' }, { id: '2', label: 'No, exit' }], created_at: ago(1), expires_at: null, answerable: false, actions: ['open'] }]);
  assert.deepEqual(t.$$('.ib-dialog-opts li').map((n) => n.textContent), ['Yes, I trust this folder', 'No, exit']);
  assert.equal(t.$$('.ib-body [data-option]').length, 0, 'nothing answerable');
  t.key('Enter');
  await tick();
  assert.deepEqual(t.calls.open, ['dialog-x'], 'Enter on a dialog opens it');
});

test('questions: one click answers a single choice; free text and multi-select send answers', async () => {
  const qs = [{ id: 'q0', question: 'Which framework?', header: 'Framework', multiSelect: false, options: [{ id: 'q0o0', label: 'React' }, { id: 'q0o1', label: 'Vue' }] }];
  const q = { v: 1, id: 'rq', kind: 'question', source: 'hook', tool: 'AskUserQuestion', cwd: '/w/app', title: 'Framework', text: 'Which framework?', questions: qs, freeText: true,
    options: [{ id: 'q0o0', label: 'React' }, { id: 'q0o1', label: 'Vue' }, { id: 'deny', label: 'Decline to answer' }], created_at: ago(1), expires_at: later(20), answerable: true, actions: ['answer', 'open'] };
  const t = setup();
  t.bubble.update([q]);
  t.$('[data-option="q0o1"]').click();
  await tick();
  assert.deepEqual(t.calls.answer[0].slice(0, 2), ['rq', 'q0o1']);

  const u = setup();
  u.bubble.update([q]);
  const f = u.$('.ib-q .ib-field');
  f.value = 'Svelte';
  f.dispatchEvent(new u.dom.window.Event('input'));
  f.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick();
  assert.deepEqual(u.calls.answer[0], ['rq', 'answers', { answers: { 'Which framework?': 'Svelte' } }]);

  const shown = setup();
  shown.bubble.update([{ ...q, id: 'ask-h-s', source: 'session', answerable: false, actions: ['open'], options: [], freeText: undefined, expires_at: null }]);
  assert.deepEqual(shown.$$('.ib-readonly').map((n) => n.textContent), ['React', 'Vue'], 'not answerable here: shown, with Open it');
  assert.ok(shown.$('.ib-open'));
});

test('elicitation: a form from the schema; Submit sends typed content, a missing field says so', async () => {
  const t = setup();
  t.bubble.update([{ v: 1, id: 're', kind: 'elicitation', source: 'hook', tool: 'mcp:deploy', cwd: '/w/app', title: 'deploy asks for input', text: 'Which environment?',
    schema: { type: 'object', required: ['env'], properties: { env: { type: 'string', enum: ['staging', 'prod'] }, count: { type: 'integer' } } },
    options: [{ id: 'accept', label: 'Submit', needsContent: true }, { id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Cancel' }], created_at: ago(1), expires_at: later(40), answerable: true, actions: ['answer', 'open'] }]);
  t.$('[data-option="accept"]').click();
  await tick();
  assert.equal(t.calls.answer.length, 0);
  assert.match(t.$('.ib-err').textContent, /Pick a value|required/);
  const sel = t.$('select');
  sel.value = 'staging';
  sel.dispatchEvent(new t.dom.window.Event('change'));
  const num = t.$('input[type=number]');
  num.value = '2';
  num.dispatchEvent(new t.dom.window.Event('input'));
  t.$('[data-option="accept"]').click();
  await tick();
  assert.deepEqual(t.calls.answer[0], ['re', 'accept', { content: { env: 'staging', count: 2 } }]);
});

test('an approval that earns a nudge shows it with a prefilled rule', async () => {
  const t = setup({ reply: () => ({ ok: true, nudge: { key: 'k'.repeat(32), count: 5, tools: ['Bash'], command: 'npm test', path: null } }) });
  t.bubble.update([perm()]);
  t.$('[data-option="allow"]').click();
  await tick();
  assert.match(t.$('.ib-nudge-q').textContent, /approved this 5 times — make it a rule\?/);
  assert.equal(t.$('.ib-nudge-rule').textContent, 'Bash: npm test');
});
