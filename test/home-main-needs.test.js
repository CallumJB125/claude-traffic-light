'use strict';
// Home "needs you": quick decision options only for an answerable request
// file with a plain choice; ids only, labels cut, at most four.
const test = require('node:test');
const assert = require('node:assert/strict');
const Home = require('../src/home-main.js');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const hook = (over) => ({ id: 'r1', kind: 'permission', source: 'hook', tool: 'Bash', headline: 'git push', cwd: '/w/app', created_at: iso(60_000), expires_at: iso(-50_000), answerable: true, actions: ['answer', 'open'], options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }], ...over });

test('needs: an answerable request with options carries its id and up to four { id, label } options', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `Option ${i} ${'x'.repeat(60)}` }));
  const n = Home.needs([hook(), hook({ id: 'r2', kind: 'question', text: 'Which?', options: many, created_at: iso(30_000) })], NOW);
  assert.equal(n.items[0].id, 'r1');
  assert.deepEqual(n.items[0].options, [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]);
  assert.equal(n.items[1].options.length, 4);
  assert.ok(n.items[1].options.every((o) => o.label.length <= 40 && typeof o.id === 'string'));
  for (const k of ['kind', 'headline', 'project', 'age', 'late']) assert.ok(k in n.items[0], k);
});

test('needs: no options for dialogs, session asks, expired or unanswerable requests, forms or free text', () => {
  const cases = [
    hook({ source: 'session', answerable: false, actions: [] }),
    hook({ source: 'tmux', answerable: false, actions: ['open'] }),
    hook({ expires_at: iso(1000) }),
    hook({ answerable: false }),
    hook({ kind: 'question', questions: [{ id: 'q', question: 'Which?', options: [] }] }),
    hook({ kind: 'elicitation', schema: { properties: {} } }),
    hook({ kind: 'question', freeText: true }),
    hook({ options: [{ id: 'answers', label: 'Send' }] }),
  ];
  for (const n of Home.needs(cases, NOW).items) assert.deepEqual(n.options, []);
});

test('PR 5: Home says Answer only for a request Plexiform can deliver an answer to; everything else is Open', () => {
  const actions = (cases) => Home.needs(cases, NOW).items.map((n) => n.action);
  assert.deepEqual(actions([hook()]), ['answer']);
  assert.deepEqual(actions([hook({ answering: false })]), ['open'], 'answering off');
  assert.deepEqual(actions([hook({ expires_at: iso(1000) })]), ['open'], 'the hook stopped waiting');
  assert.deepEqual(actions([hook({ source: 'session', answerable: false, actions: ['open'] })]), ['go-to-terminal']);
  assert.deepEqual(actions([hook({ source: 'tmux', kind: 'dialog', answerable: false, actions: ['open'] })]), ['go-to-terminal']);
});

test('C-F: a flagged request or a plan gets no quick option and the card says Open, not Answer', () => {
  const flagged = hook({ danger: 'recursive delete', enterAllow: false });
  const plain = hook({ id: 'r2', danger: null, enterAllow: true });
  const plan = hook({ id: 'r3', kind: 'plan', text: 'do it', options: [{ id: 'allow', label: 'Approve' }, { id: 'allow-accept-edits', label: 'Approve, auto-accept edits' }] });
  const n = Home.needs([flagged, plain, plan], NOW);
  const by = (id) => n.items.find((i) => i.id === id);
  assert.deepEqual(by('r1').options, []);
  assert.equal(by('r1').action, 'open');
  assert.equal(by('r2').options.length, 2);
  assert.equal(by('r2').action, 'answer');
  assert.deepEqual(by('r3').options, []);
});

test('C-F: main refuses a flagged allow, and a plan\'s auto-accept, from home:answer-input', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const a = src.indexOf('function homeAnswerRefusal');
  const body = src.slice(a, src.indexOf('// C-V(b)', a));
  const AutoRules = require('../src/auto-rules.js');
  const refuse = vm.runInNewContext(`${body}; homeAnswerRefusal`, { AutoRules });
  const req = (command) => ({ id: 'r', kind: 'permission', tool: 'Bash', cwd: '/w/app', toolInput: { command } });
  assert.equal(refuse(req('rm -rf build'), 'allow'), true);
  assert.equal(refuse(req('rm -rf build'), 'deny'), false, 'saying no is never refused');
  assert.equal(refuse(req('ls'), 'allow'), false);
  assert.equal(refuse({ kind: 'plan', toolInput: {} }, 'allow-accept-edits'), true);
  assert.equal(refuse({ kind: 'plan', toolInput: {} }, 'allow'), false);
  const handler = src.slice(src.indexOf("ipcMain.handle('home:answer-input'"));
  assert.ok(handler.indexOf('homeAnswerRefusal(req, optionId)') > 0 && handler.indexOf('homeAnswerRefusal(req, optionId)') < handler.indexOf('writeAnswer'), 'checked before anything is written');
});
