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
