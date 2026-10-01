// The bubble's DOM (input-bubble.js) under jsdom: untrusted text stays text,
// one answer per input, nothing answered before it has settled on screen,
// keys only for the input you can see, the cap, and what each kind offers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const T0 = Date.parse('2026-10-01T12:00:00Z');
const ago = (min) => new Date(T0 - min * 60000).toISOString();
const later = (s) => new Date(T0 + s * 1000).toISOString();

function setup(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="b"></div></body>');
  global.document = dom.window.document;
  let clock = T0;
  const calls = { answer: [], open: [], rule: [], waiting: 0, scope: [] };
  let reply = opts.reply || (() => ({ ok: true }));
  const api = {
    answerInput: async (id, optionId, more) => { calls.answer.push([id, optionId, more]); return reply(id, optionId); },
    openInput: async (id) => { calls.open.push(id); return { ok: true }; },
    openAutoRule: (id) => calls.rule.push(id),
    openWaiting: () => { calls.waiting++; },
    setSessionScope: async (id, mode) => { calls.scope.push(['session', id, mode]); return { ok: true }; },
    setRepoScope: async (url, mode) => { calls.scope.push(['repo', url, mode]); return { ok: true }; },
  };
  const root = dom.window.document.getElementById('b');
  const bubble = require('../input-bubble.js').create(root, { api, mode: opts.mode || 'widget', now: () => clock, ...(opts.onScreen ? { onScreen: opts.onScreen } : {}) });
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const key = (k, extra = {}) => bubble.keydown(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  let last = [[], {}];
  const update = (inputs, extra = {}) => { last = [inputs, extra]; bubble.update(inputs, extra); };
  // Let what is on screen settle (past the 600 ms guard) and redraw.
  const settle = () => { clock += 700; bubble.update(...last); };
  const show = (inputs, extra) => { update(inputs, extra); settle(); };
  const advance = (ms) => { clock += ms; };
  return { dom, root, bubble, calls, $, $$, key, update, show, settle, advance, setReply: (f) => { reply = f; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const perm = (over = {}) => ({ v: 1, id: 'r1', kind: 'permission', source: 'hook', tool: 'Bash', cwd: '/w/app', title: 'Allow Bash?', text: 'ls -la', headline: 'ls -la', created_at: ago(1), expires_at: later(40), answerable: true, actions: ['answer', 'open'], danger: null, enterAllow: true,
  options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session-0', label: 'Allow Bash(ls:*) for this session' }, { id: 'deny', label: 'Deny' }], ...over });

test('untrusted text is only ever text: markup in a command, title or option stays inert', () => {
  const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
  const t = setup();
  t.show([perm({ text: evil, headline: evil, title: evil, cwd: `/w/${evil}`, options: [{ id: 'allow', label: evil }, { id: 'deny', label: 'Deny' }] })]);
  assert.equal(t.root.querySelectorAll('img, script').length, 0);
  assert.ok(t.$('.ib-text').textContent.includes('<img'));
  assert.ok(t.$('.ib-opt').textContent.includes('<script>'));
});

test('one input opens straight away; Allow sends once, however many clicks, then it is gone', async () => {
  const t = setup();
  t.show([perm()]);
  const allow = t.$('[data-option="allow"]');
  allow.click(); allow.click(); t.$('[data-option="deny"]').click();
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[1]), ['allow']);
  assert.equal(t.$$('.ib-item').length, 0, 'answered: hidden while main catches up');
  t.show([perm()]);
  assert.equal(t.$$('.ib-item').length, 0, 'still hidden until it leaves the list');
  t.show([]);
  t.show([perm({ id: 'r2' })]);
  assert.equal(t.$$('.ib-item').length, 1, 'a new ask shows');
});

test('answer buttons stay off for 600 ms after an input appears or changes under the cursor', async () => {
  const t = setup();
  t.update([perm()]);
  assert.equal(t.$('[data-option="allow"]').disabled, true, 'just appeared');
  t.$('[data-option="allow"]').click();
  await tick();
  assert.equal(t.calls.answer.length, 0);
  t.settle();
  assert.equal(t.$('[data-option="allow"]').disabled, false);
  t.update([perm({ text: 'rm notes.txt', headline: 'rm notes.txt' })]);
  assert.equal(t.$('[data-option="allow"]').disabled, true, 'its content changed: settles again');
});

test('a refused answer (answered elsewhere) says so; once gone from the list it disappears', async () => {
  const t = setup({ reply: () => ({ ok: false, error: 'no longer waiting (answered, timed out, or answer it in the terminal)' }) });
  t.show([perm()]);
  t.$('[data-option="allow"]').click();
  await tick();
  assert.match(t.$('.ib-err').textContent, /no longer waiting/);
  t.show([]);
  assert.equal(t.$$('.ib-item').length, 0);
});

test('expired: "answer in terminal", no answer buttons, Open it jumps to the terminal', async () => {
  const t = setup();
  t.show([perm({ expires_at: ago(0.1) })]);
  assert.match(t.$('.ib-age').textContent, /answer in terminal/);
  assert.match(t.$('.ib-expired').textContent, /answer in terminal/);
  assert.equal(t.$('[data-option="allow"]'), null);
  t.$('.ib-open').click();
  await tick();
  assert.deepEqual(t.calls.open, ['r1']);
});

test('Enter allows once only when main marked it allow-listed; ⌘. denies; Esc collapses then dismisses', async () => {
  const t = setup();
  t.show([perm({ danger: 'recursive delete', enterAllow: false, text: 'rm -rf build' })]);
  assert.match(t.$('.ib-warn').textContent, /recursive delete/);
  assert.ok(t.$('[data-option="allow"]').classList.contains('tone-risky'));
  t.key('Enter');
  await tick();
  assert.equal(t.calls.answer.length, 0, 'Enter does not allow a deny-listed command');
  assert.match(t.$('.ib-err').textContent, /Enter only allows/);
  t.key('.', { metaKey: true });
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[1]), ['deny']);

  const u = setup();
  u.show([perm()]);
  u.key('Enter');
  await tick();
  assert.deepEqual(u.calls.answer.map((c) => c[1]), ['allow']);

  const v = setup();
  v.show([perm()]);
  v.key('Escape');
  assert.equal(v.$$('.ib-body').length, 0, 'collapsed');
  v.key('Escape');
  assert.match(v.$('.ib-pill').textContent, /1 waiting on you/, 'dismissed to a pill, not lost');
  v.show([perm()], { scopes: { s1: { state: 'counting' } } });
  assert.ok(v.$('.ib-pill'), 'a scope-only change keeps it dismissed');
  v.$('.ib-pill').click();
  assert.equal(v.$$('.ib-item').length, 1);
});

test('Enter: nothing on an input that is not on the allow-list, or unchecked (danger undefined)', async () => {
  for (const over of [{ enterAllow: false }, { danger: undefined }, { enterAllow: undefined }, { danger: 'x', enterAllow: true }]) {
    const t = setup();
    t.show([perm(over)]);
    t.key('Enter');
    await tick();
    assert.equal(t.calls.answer.length, 0, JSON.stringify(over));
  }
});

test('S-H1: a second Enter never answers an input you have not opened', async () => {
  const t = setup();
  const a = perm({ id: 'a', created_at: ago(3) });
  const b = perm({ id: 'b', created_at: ago(2) });
  t.show([a, b]);
  t.$('.ib-item[data-id="a"] .ib-row').click();
  t.settle();
  t.key('Enter');
  await tick();
  t.show([b]);
  t.key('Enter');
  await tick();
  t.key('Enter');
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[0]), ['a'], 'B stays unanswered until it is opened on purpose');
  assert.equal(t.$('.ib-item[data-id="b"] .ib-body'), null, 'and it is not auto-opened after an answer');
});

test('S-H1: held or double Enter answers once; an input that just appeared under the cursor ignores Enter', async () => {
  const t = setup();
  t.show([perm()]);
  t.key('Enter');
  t.key('Enter', { repeat: true });
  t.key('Enter');
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[1]), ['allow']);

  // A answered elsewhere; B, the only one left, opens by itself: Enter right then does nothing.
  const u = setup();
  u.show([perm({ id: 'a', created_at: ago(3) }), perm({ id: 'b', created_at: ago(2) })]);
  u.$('.ib-item[data-id="a"] .ib-row').click();
  u.settle();
  u.update([perm({ id: 'b', created_at: ago(2) })]);
  assert.ok(u.$('.ib-item[data-id="b"] .ib-body'), 'auto-opened');
  u.key('Enter');
  u.key('.', { metaKey: true });
  await tick();
  assert.equal(u.calls.answer.length, 0, 'neither Enter nor ⌘. acts before it settles');
});

test('Enter can never allow an input with danger set, in the bubble or on the Waiting page', async () => {
  for (const mode of ['widget', 'page']) {
    for (const danger of ['recursive delete', 'it could not be checked', ' ']) {
      const t = setup({ mode });
      t.show([perm({ danger, enterAllow: true })]);
      t.key('Enter');
      t.advance(2000);
      t.key('Enter');
      await tick();
      assert.equal(t.calls.answer.length, 0, `${mode}: ${JSON.stringify(danger)}`);
    }
    const ok = setup({ mode });
    ok.show([perm()]);
    ok.key('Enter');
    await tick();
    assert.deepEqual(ok.calls.answer.map((c) => c[1]), ['allow'], `${mode}: allow-listed, nothing flagged: Enter allows once`);
  }
});

test('Deny first asks for an optional reason; Send carries it; ⌘. denies straight away', async () => {
  const t = setup();
  t.show([perm()]);
  assert.equal(t.$('.ib-reason'), null, 'no reason field until Deny');
  t.$('[data-option="deny"]').click();
  await tick();
  assert.equal(t.calls.answer.length, 0, 'Deny alone sends nothing');
  const f = t.$('.ib-reason');
  f.value = 'use the test script';
  f.dispatchEvent(new t.dom.window.Event('input'));
  t.$('.ib-deny-send').click();
  await tick();
  assert.deepEqual(t.calls.answer[0], ['r1', 'deny', { message: 'use the test script' }]);
});

test('a cut-off command says how much is missing', () => {
  const t = setup();
  t.show([perm({ detail_cut: 1234 })]);
  assert.match(t.root.textContent, /1234 more characters not shown — check the terminal/);
});

test('the widget caps at two rows plus "+N more"; what can be answered here comes first', () => {
  const t = setup();
  const note = (id, min) => ({ v: 1, id, kind: 'notification', source: 'session', cwd: '/w/x', title: 'Needs you', text: 'x', options: [], created_at: ago(min), expires_at: null, answerable: false, actions: ['open'] });
  t.show([note('n1', 9), note('n2', 8), perm({ id: 'p', created_at: ago(1) }), note('n3', 2)]);
  assert.deepEqual(t.$$('.ib-item').map((n) => n.dataset.id), ['p', 'n1'], 'the answerable permission never hides behind +N');
  assert.equal(t.$('.ib-item.late').dataset.id, 'n1', 'waiting 5 min or more: escalated');
  assert.match(t.$('.ib-more').textContent, /\+2 more/);
  t.$('.ib-more').click();
  assert.equal(t.calls.waiting, 1);
  const p = setup({ mode: 'page' });
  p.show([perm({ id: 'a' }), perm({ id: 'b' }), perm({ id: 'c' })]);
  assert.equal(p.$$('.ib-item').length, 3, 'the page shows every one');
});

test('blocked: "Needs your decision", the reason, three suggestions, none of them ever sent', async () => {
  const t = setup();
  t.show([{ v: 1, id: 'blocked-h-s-1', kind: 'blocked', source: 'session', tool: 'Bash', cwd: '/w/app', title: 'Blocked: Bash needs your decision', text: 'rm -rf /tmp/x\nReason: [Irreversible Local Destruction]', reason: '[Irreversible Local Destruction]',
    options: [{ id: 'run-yourself', label: 'Run it yourself' }, { id: 'switch-mode', label: 'Switch permission mode' }, { id: 'add-rule', label: 'Add a rule' }], created_at: ago(1), expires_at: null, answerable: false, actions: ['open'] }]);
  assert.equal(t.$('.ib-head').textContent, 'Needs your decision');
  assert.match(t.$('.ib-title').textContent, /Bash/, 'the body names the tool');
  assert.deepEqual(t.$$('.ib-body .ib-opt').map((b) => b.textContent), ['Open the terminal', 'How to allow it', 'Add a rule']);
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

test('dialog: the terminal’s own choices shown read-only, and Open it (Enter opens it once settled)', async () => {
  const t = setup();
  t.show([{ v: 1, id: 'dialog-x', kind: 'dialog', dialog: 'trust-folder', source: 'tmux', cwd: '/w/app', title: 'Trust this folder?', text: 'Quick safety check', options: [{ id: '1', label: 'Yes, I trust this folder' }, { id: '2', label: 'No, exit' }], created_at: ago(1), expires_at: null, answerable: false, actions: ['open'] }]);
  assert.deepEqual(t.$$('.ib-dialog-opts li').map((n) => n.textContent), ['Yes, I trust this folder', 'No, exit']);
  assert.equal(t.$$('.ib-body [data-option]').length, 0, 'nothing answerable');
  assert.equal(t.$('.ib-title'), null, 'a title that only repeats the headline is not shown twice');
  t.key('Enter');
  await tick();
  assert.deepEqual(t.calls.open, ['dialog-x']);
});

test('questions: one click answers a single choice; free text and multi-select send answers', async () => {
  const qs = [{ id: 'q0', question: 'Which framework?', header: 'Framework', multiSelect: false, options: [{ id: 'q0o0', label: 'React' }, { id: 'q0o1', label: 'Vue' }] }];
  const q = { v: 1, id: 'rq', kind: 'question', source: 'hook', tool: 'AskUserQuestion', cwd: '/w/app', title: 'Framework', text: 'Which framework?', questions: qs, freeText: true,
    options: [{ id: 'q0o0', label: 'React' }, { id: 'q0o1', label: 'Vue' }, { id: 'deny', label: 'Decline to answer' }], created_at: ago(1), expires_at: later(20), answerable: true, actions: ['answer', 'open'] };
  const t = setup();
  t.show([q]);
  t.$('[data-option="q0o1"]').click();
  await tick();
  assert.deepEqual(t.calls.answer[0].slice(0, 2), ['rq', 'q0o1']);

  const u = setup();
  u.show([q]);
  const f = u.$('.ib-q .ib-field');
  f.value = 'Svelte';
  f.dispatchEvent(new u.dom.window.Event('input'));
  f.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick();
  assert.deepEqual(u.calls.answer[0], ['rq', 'answers', { answers: { 'Which framework?': 'Svelte' } }]);

  const shown = setup();
  shown.show([{ ...q, id: 'ask-h-s', source: 'session', answerable: false, actions: ['open'], options: [], freeText: undefined, expires_at: null }]);
  assert.deepEqual(shown.$$('.ib-readonly').map((n) => n.textContent), ['React', 'Vue'], 'not answerable here: shown, with Open it');
  assert.ok(shown.$('.ib-open'));
});

test('elicitation: a form from the schema; Submit sends typed content, a missing field says so', async () => {
  const t = setup();
  t.show([{ v: 1, id: 're', kind: 'elicitation', source: 'hook', tool: 'mcp:deploy', cwd: '/w/app', title: 'deploy asks for input', text: 'Which environment?',
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

test('S-L2: field names that are Object.prototype’s own are dropped, never shown pre-filled', async () => {
  const t = setup();
  t.show([{ v: 1, id: 're2', kind: 'elicitation', source: 'hook', tool: 'mcp:x', cwd: '/w/app', title: 'x asks', text: 'Fill in',
    schema: { type: 'object', properties: { constructor: { type: 'boolean' }, toString: { type: 'string' }, __proto__x: { type: 'string' }, ok: { type: 'boolean' } } },
    options: [{ id: 'accept', label: 'Submit', needsContent: true }, { id: 'decline', label: 'Decline' }], created_at: ago(1), expires_at: later(40), answerable: true, actions: ['answer', 'open'] }]);
  assert.deepEqual(t.$$('.ib-flabel > span').map((n) => n.textContent), ['__proto__x', 'ok']);
  assert.equal(t.$$('input[type=checkbox]').filter((c) => c.checked).length, 0, 'nothing pre-checked');
  t.$('[data-option="accept"]').click();
  await tick();
  assert.deepEqual(t.calls.answer[0], ['re2', 'accept', { content: { ok: false } }]);
});

test('an approval that earns a nudge shows it (main sends none while auto-answer is off)', async () => {
  const t = setup({ reply: () => ({ ok: true, nudge: { key: 'k'.repeat(32), count: 5, tools: ['Bash'], command: 'npm test', path: null } }) });
  t.show([perm()]);
  t.$('[data-option="allow"]').click();
  await tick();
  assert.match(t.$('.ib-nudge-q').textContent, /approved this 5 times — make it a rule\?/);
  assert.equal(t.$('.ib-nudge-rule').textContent, 'Bash: npm test');
});

const scoped = (state) => ({ r: perm({ session: 's1' }), scopes: { s1: { state, board: { id: 'b', name: 'Platform' }, repo: { short: 'acme/api', canonicalUrl: 'https://github.com/acme/api' } } } });
test('work scope: nothing without a scope or when outside; muted watching; counting names the board', () => {
  for (const scopes of [{}, { s1: null }, { s1: { state: 'outside', board: null, repo: null } }]) {
    const t = setup();
    t.show([perm({ session: 's1' })], { scopes });
    assert.equal(t.$('.ib-scope'), null);
    assert.equal(t.$('.ib-scope-line'), null);
  }
  const w = setup();
  w.show([scoped('watching').r], { scopes: scoped('watching').scopes });
  assert.equal(w.$('.ib-row .ib-scope'), null, 'not on the row: the headline keeps its room');
  assert.equal(w.$('.ib-body .ib-scope').textContent, 'watching locally');
  assert.equal(w.$('.ib-body .ib-scope').title, 'Not counted for your team until it makes a change');
  const c = setup();
  c.show([scoped('counting').r], { scopes: scoped('counting').scopes });
  assert.equal(c.$('.ib-body .ib-scope').textContent, 'counting for Platform');
  assert.equal(c.$$('.ib-scope-line button').find((b) => b.textContent === 'Not team work').title, 'Won’t count toward Platform');
});

test('work scope: Not team work marks the session; Undo puts it back; the repo choice sits behind ⋯', async () => {
  const t = setup();
  const { r, scopes } = scoped('counting');
  t.show([r], { scopes });
  const btn = (label) => t.$$('.ib-scope-line button').find((b) => b.textContent === label);
  assert.equal(btn('Always treat this repo as personal'), undefined, 'secondary: hidden until ⋯');
  btn('Not team work').click();
  await tick();
  btn('⋯').click();
  btn('Always treat this repo as personal').click();
  await tick();
  t.show([r], { scopes: { s1: { state: 'personal', board: null, repo: null } } });
  assert.equal(t.$('.ib-body .ib-scope').textContent, 'personal');
  btn('Undo').click();
  await tick();
  assert.deepEqual(t.calls.scope, [['session', 's1', 'personal'], ['repo', 'https://github.com/acme/api', 'personal'], ['session', 's1', 'auto']]);
  assert.equal(t.calls.answer.length, 0, 'scope actions never answer the input');
});

test('N4: until main confirms the bubble has its room, nothing in it can be answered; then it settles from that moment', async () => {
  let room = false;
  const t = setup({ onScreen: () => room });
  t.show([perm()]);
  assert.equal(t.$('[data-option="allow"]').disabled, true, 'possibly clipped: not seen');
  t.key('Enter');
  await tick();
  assert.equal(t.calls.answer.length, 0);
  room = true;
  t.bubble.revealed();
  assert.equal(t.$('[data-option="allow"]').disabled, true, 'settles from the reveal, not from when it was drawn');
  t.settle();
  t.key('Enter');
  await tick();
  assert.deepEqual(t.calls.answer.map((c) => c[1]), ['allow']);
});

test('N3: a question’s Send answer is settle-gated, and picks are dropped when the question changes', async () => {
  const q = (question) => ({ v: 1, id: 'rq', kind: 'question', source: 'hook', tool: 'AskUserQuestion', cwd: '/w/app', title: 'Pick', text: question,
    questions: [{ id: 'q0', question, header: '', multiSelect: true, options: [{ id: 'q0o0', label: 'A' }, { id: 'q0o1', label: 'B' }] }],
    options: [{ id: 'deny', label: 'Decline to answer' }], created_at: ago(1), expires_at: later(20), answerable: true, actions: ['answer', 'open'] });
  const t = setup();
  t.update([q('Which ones?')]);
  const send = () => t.$$('.ib-opt').find((b) => b.textContent === 'Send answer');
  assert.equal(send().disabled, true, 'just appeared');
  t.settle();
  t.$$('.ib-opt').find((b) => b.textContent === 'A').click();
  t.update([q('Which ones should be deleted?')]);
  assert.equal(send().disabled, true, 'changed: settles again');
  t.settle();
  assert.equal(t.$$('.ib-opt[aria-pressed="true"]').length, 0, 'the earlier pick is gone');
  send().click();
  await tick();
  assert.equal(t.calls.answer.length, 0, 'nothing picked for the new question');
  assert.match(t.$('.ib-err').textContent, /Answer/);
});

test('N3: Enter in a question’s own-answer field waits for the question to settle and be on screen too', async () => {
  const q = (question) => ({ v: 1, id: 'rq', kind: 'question', source: 'hook', tool: 'AskUserQuestion', cwd: '/w/app', title: 'Ask', text: question, freeText: true,
    questions: [{ id: 'q0', question, header: '', multiSelect: false, options: [{ id: 'q0o0', label: 'Yes' }] }],
    options: [{ id: 'q0o0', label: 'Yes' }, { id: 'deny', label: 'Decline to answer' }], created_at: ago(1), expires_at: later(20), answerable: true, actions: ['answer', 'open'] });
  let room = true;
  const t = setup({ onScreen: () => room });
  const enterIn = (text) => {
    const f = t.$('.ib-q .ib-field');
    f.value = text;
    f.dispatchEvent(new t.dom.window.Event('input'));
    f.dispatchEvent(new t.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  t.show([q('Which framework?')]);
  t.update([q('Delete prod DB?')]);
  t.advance(50);
  enterIn('yes');
  await tick();
  assert.equal(t.calls.answer.length, 0, 'the question just changed under the cursor');
  t.settle();
  room = false;
  t.bubble.update([q('Delete prod DB?')]);
  enterIn('yes');
  await tick();
  assert.equal(t.calls.answer.length, 0, 'possibly clipped: not seen');
  room = true;
  t.bubble.revealed();
  t.settle();
  enterIn('no');
  await tick();
  assert.deepEqual(t.calls.answer, [['rq', 'answers', { answers: { 'Delete prod DB?': 'no' } }]]);
});

test('a deny reason typed for what the input said before is dropped when it changes', async () => {
  const t = setup();
  t.show([perm()]);
  t.$('[data-option="deny"]').click();
  const r = t.$('.ib-reason');
  assert.ok(r, 'Deny first shows the reason field');
  r.value = 'not that one';
  r.dispatchEvent(new t.dom.window.Event('input'));
  t.update([perm({ text: 'rm -rf build', headline: 'rm -rf build' })]);
  t.settle();
  const r2 = t.$('.ib-reason');
  assert.ok(!r2 || r2.value === '', 'the old reason is not offered for the new content');
});

test('Enter never approves a plan; ⌘. still sends it back to planning', async () => {
  const plan = { v: 1, id: 'rp', kind: 'plan', source: 'hook', tool: 'ExitPlanMode', cwd: '/w/app', title: 'Plan ready: approve?', text: '# Plan\n1. do it', created_at: ago(1), expires_at: later(40), answerable: true, actions: ['answer', 'open'],
    options: [{ id: 'allow', label: 'Approve' }, { id: 'allow-accept-edits', label: 'Approve, auto-accept edits' }, { id: 'deny', label: 'Keep planning' }] };
  for (const mode of ['widget', 'page']) {
    const t = setup({ mode });
    t.show([plan]);
    t.key('Enter');
    await tick();
    assert.equal(t.calls.answer.length, 0, mode);
    t.key('.', { metaKey: true });
    await tick();
    assert.deepEqual(t.calls.answer.map((c) => c[1]), ['deny'], mode);
  }
});
