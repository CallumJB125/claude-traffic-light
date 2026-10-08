const { test } = require('node:test');
const assert = require('node:assert/strict');
const OneKey = require('../src/one-key.js');

const cwd = '/work/app';
const req = (tool, toolInput) => ({ tool, toolInput, cwd });
const ok = (tool, input) => assert.equal(OneKey.readOnlyReason(req(tool, input)), null, `${tool} ${JSON.stringify(input)}`);
const no = (tool, input) => assert.notEqual(OneKey.readOnlyReason(req(tool, input)), null, `${tool} ${JSON.stringify(input)}`);

test('off by default and unless strictly true', () => {
  const r = req('Read', { file_path: '/work/app/a.js' });
  assert.match(OneKey.reason(r, {}), /off in Preferences/);
  assert.match(OneKey.reason(r, { enabled: 'yes' }), /off/);
  assert.equal(OneKey.reason(r, { enabled: true }), null);
});

test('Read, Grep, Glob and LS inside the project', () => {
  ok('Read', { file_path: '/work/app/src/a.js' });
  ok('Read', { file_path: 'src/a.js' });
  ok('Grep', { pattern: 'foo' });
  ok('Grep', { pattern: 'foo', path: 'src' });
  ok('Glob', { pattern: '**/*.js' });
  ok('LS', { path: '/work/app' });
});

test('reads outside the project, or of credentials, need a click', () => {
  no('Read', { file_path: '/etc/passwd' });
  no('Read', { file_path: '../other/a.js' });
  no('Read', { file_path: '/work/app/../secret.txt' });
  no('Read', { file_path: '/work/app/.env' });
  no('Read', { file_path: '/work/app/.env.production' });
  no('Read', { file_path: '/work/app/.ssh/id_rsa' });
  no('Read', { file_path: '/work/app/certs/server.pem' });
  no('Grep', { pattern: 'x', path: '/Users/me' });
  no('Glob', { pattern: '../**' });
  no('Glob', { pattern: '/etc/*' });
  no('Read', { file_path: '' });
});

test('writes, edits and unknown tools never qualify', () => {
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Task', 'mcp__x__read', 'read', '']) no(t, { file_path: '/work/app/a.js' });
});

test('Bash: only plain ls, pwd, git status and git log', () => {
  ok('Bash', { command: 'ls' });
  ok('Bash', { command: 'ls -la src' });
  ok('Bash', { command: 'pwd' });
  ok('Bash', { command: 'git status' });
  ok('Bash', { command: 'git log --oneline' });
  for (const command of [
    'ls /etc', 'ls ..', 'ls ~', 'ls -la; rm -rf x', 'ls && rm x', 'ls | sh', 'ls > out', 'ls $(whoami)', 'ls `id`', 'ls *',
    'git log --output=x', 'git push', 'git status && git push', 'git commit -m x', 'cat a.js', 'rm a', 'ls .env', 'ls\nrm x', '', 'lsx', 'git',
    'ls "a b"', "ls 'a'",
  ]) no('Bash', { command });
});

test('a request without a real project folder is never one-key', () => {
  assert.notEqual(OneKey.readOnlyReason({ tool: 'Read', toolInput: { file_path: 'a.js' }, cwd: 'rel' }), null);
  assert.notEqual(OneKey.readOnlyReason({ tool: 'Read', toolInput: {} }), null);
  assert.notEqual(OneKey.readOnlyReason(null), null);
});

test('record writes one JSON line per approval and never throws', () => {
  const lines = [];
  const fsImpl = { appendFileSync: (f, l) => lines.push([f, l]) };
  assert.equal(OneKey.record('/log', { tool: 'Read', session: 's1' }, { fsImpl, now: Date.UTC(2026, 9, 6) }), true);
  const row = JSON.parse(lines[0][1]);
  assert.deepEqual(row, { at: '2026-10-06T00:00:00.000Z', kind: 'one-key-approve', tool: 'Read', session: 's1' });
  assert.equal(OneKey.record('/log', {}, { fsImpl: { appendFileSync() { throw new Error('disk'); } } }), false);
});

test('attention queue: oldest wait first, next/previous wrap', () => {
  const V = require('../src/input-view.js');
  const at = (min) => new Date(Date.UTC(2026, 9, 6, 12, 0) - min * 60000).toISOString();
  const inputs = [
    { id: 'new', created_at: at(1), answerable: true, actions: ['answer'] },
    { id: 'old', created_at: at(20) },
    { id: 'mid', created_at: at(7), answerable: true, actions: ['answer'] },
  ];
  assert.deepEqual(V.queue(inputs).map((i) => i.id), ['old', 'mid', 'new']);
  assert.deepEqual(V.visible(inputs, 9, Date.now(), true).shown.map((i) => i.id), ['old', 'mid', 'new']);
  assert.equal(V.step(inputs, 'old', 1), 'mid');
  assert.equal(V.step(inputs, 'new', 1), 'old');
  assert.equal(V.step(inputs, 'old', -1), 'new');
  assert.equal(V.step(inputs, null, 1), 'old');
  assert.equal(V.step(inputs, null, -1), 'new');
  assert.equal(V.step([], 'x', 1), null);
});

test('Enter is never a one-key approval unless main marked it enterAllow', () => {
  const V = require('../src/input-view.js');
  const base = { kind: 'permission', answerable: true, actions: ['answer'], options: [{ id: 'allow' }], danger: null, expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.equal(V.primary({ ...base, enterAllow: false }), null);
  assert.equal(V.primary({ ...base }), null);
  assert.deepEqual(V.primary({ ...base, enterAllow: true }), { type: 'option', id: 'allow' });
  assert.equal(V.primary({ ...base, enterAllow: true, danger: 'rm' }), null);
});
