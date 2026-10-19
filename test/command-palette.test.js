const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/command-palette.js');

const entries = [
  { id: 'a'.repeat(40), owner: { name: 'Ana Lopez', self: false }, provider: { id: 'codex', label: 'Codex' }, board: { label: 'Checkout' }, task: { title: 'Fix login redirect', source: 'reported' }, state: 'Working' },
  { id: 'b'.repeat(40), owner: { name: 'Ben Kim', self: false }, provider: { id: 'claude', label: 'Claude Code' }, board: { label: 'Checkout' }, task: { title: 'Payment retries', source: 'board' }, state: 'Idle' },
  { id: 'c'.repeat(40), owner: { name: 'You', self: true }, provider: { id: 'codex', label: 'Codex' }, board: { label: 'Docs' }, task: { title: 'Task not reported', source: 'unknown' }, state: 'Working' },
];

test('palette: index holds sessions, teammates, projects and cards from what the page was given', () => {
  const idx = C.indexOf({ entries, cards: [{ handle: 'h1', title: 'Release checklist' }] });
  assert.deepEqual(idx.filter(i => i.kind === 'person').map(i => i.title), ['Ana Lopez', 'Ben Kim']);
  assert.deepEqual(idx.filter(i => i.kind === 'project').map(i => i.title).sort(), ['Checkout', 'Docs']);
  assert.equal(idx.filter(i => i.kind === 'session').length, 3);
  assert.equal(idx.find(i => i.id === 'c'.repeat(40)).title, 'Codex session');
  assert.equal(idx.filter(i => i.kind === 'card').length, 1);
});

test('palette: a distinctive query reaches the exact session first; fuzzy and prefix ranking', () => {
  const idx = C.indexOf({ entries });
  assert.equal(C.search(idx, 'login')[0].id, 'a'.repeat(40));
  assert.equal(C.search(idx, 'pay')[0].title, 'Payment retries');
  assert.equal(C.search(idx, 'ben')[0].kind, 'person');
  assert.equal(C.search(idx, 'pymt rtr')[0].title, 'Payment retries');
  assert.equal(C.search(idx, 'zzzz').length, 0);
  assert.equal(C.search(idx, '').length, Math.min(C.LIMIT, idx.length));
});

test('palette: an entry the directory did not list is never indexed (privacy lives in main)', () => {
  const idx = C.indexOf({ entries: entries.slice(0, 1) });
  assert.equal(C.search(idx, 'Payment').length, 0);
});

test('palette: its colours come only from shared tokens and the dialog is labelled and reduced-motion aware', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'palette.css'), 'utf8');
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'palette.css uses only var(--…) colours');
  assert.match(css, /prefers-reduced-motion/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'palette.js'), 'utf8');
  assert.match(js, /role', 'dialog'/);
  assert.match(js, /aria-label/);
});
