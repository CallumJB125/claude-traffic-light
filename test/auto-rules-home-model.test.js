'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.join(__dirname, '../src/auto-rules.js'), source = fs.readFileSync(file, 'utf8'), actualRequire = createRequire(file);
function load(host = 'win32', cwd = 'D:\\fixture') {
  const native = host === 'win32' ? path.win32 : path.posix;
  const win32 = { ...path.win32, resolve: (...parts) => path.win32.resolve(cwd, ...parts) };
  const bound = { ...native, posix: path.posix, win32, ...(host === 'win32' ? { resolve: win32.resolve } : {}) };
  const module = { exports: {} };
  vm.runInNewContext(source, { require: id => id === 'path' ? bound : actualRequire(id), module, process, Buffer, console });
  return module.exports;
}
const files = p => ({ id: 'fixture-rule', tools: ['Read'], path: p });
const req = (p, cwd) => ({ kind: 'permission', tool: 'Read', toolInput: { file_path: p }, cwd });
for (const host of ['win32', 'posix']) test(`qualified Windows home onC refuses whole-home rule under ${host} host model`, () => {
  const A = load(host), home = 'C:\\Users\\fixture';
  for (const rule of ['~/**', '~/*', '/Users/**', '/**']) assert.match(A.refusal(files(rule), { home }), /whole home/, rule);
  assert.equal(A.matchRule([files('~/**')], req('C:\\Users\\fixture\\notes.txt', 'C:\\Users\\fixture\\project'), { home, realpath: p => p }), null);
  assert.equal(A.sanitize([files('~/**')], { home }).rules.length, 0);
});
for (const home of ['C:\\Users\\fixture', 'c:/Users/fixture', 'C:\\Users\\a.name', 'c:/USERS/A.NAME']) test(`drive/case/period whole-home guard stays closed for ${home}`, () => {
  const A = load();
  assert.match(A.refusal(files('~/**'), { home }), /whole home/);
  assert.match(A.refusal(files('/Users/**'), { home }), /whole home/);
  assert.equal(A.refusal(files('~/Development/app/**'), { home }), null);
});
test('POSIX home rules remain POSIX even when the host path module is Windows', () => {
  const A = load(), home = '/Users/a.name';
  for (const rule of ['~/**', '~/*', '/Users/**', '/**']) assert.match(A.refusal(files(rule), { home }), /whole home/);
  assert.equal(A.refusal(files('~/Development/app/**'), { home }), null);
  assert.equal(A.refusal(files('/Users/a.name-other/**'), { home }), null);
});
test('POSIX literal backslash stays a literal segment rather than a Windows separator', () => {
  const A = load(), home = '/Users/a\\name';
  assert.match(A.refusal(files('~/**'), { home }), /whole home/);
  assert.equal(A.refusal(files('/Users/a/name/**'), { home }), null);
  assert.equal(A.refusal(files('~/project/**'), { home }), null);
});
test('repair grants no new qualified Windows rule syntax or credential/code-later access', () => {
  const A = load(), home = 'C:\\Users\\fixture';
  for (const p of ['C:\\Users\\fixture\\project\\**', 'C:/Users/fixture/project/**', '\\\\server\\share\\**', 'C:relative']) assert.match(A.refusal(files(p), { home }), /start with/);
  for (const p of ['~/.ssh/*', '~/.claude/**', '~/project/.env']) assert.equal(A.matchRule([files('~/**')], req(p.replace('~', home), 'C:\\Users\\fixture\\project'), { home, realpath: p => p }), null);
  assert.match(A.refusal({ ...files('~/project/.git/hooks/*'), tools: ['Write'] }, { home }), /runs later/);
});
test('POSIX existing narrow-reference effects and deny-first semantics remain intact', () => {
  const A = load('posix'), home = '/Users/a.name';
  const rule = files('/working/app/**'), request = req('/working/app/src/a.js', '/working/app');
  assert.equal(A.matchRule([rule], request, { home, realpath: p => p }).action, 'allow');
  assert.equal(A.matchRule([{ ...rule, action: 'deny' }, rule], request, { home, realpath: p => p }).action, 'deny');
  assert.equal(A.matchRule([rule], req('/working/app/.ssh/key', '/working/app'), { home, realpath: p => p }), null);
});
test('Windows validation refuses credential and code-later spellings without changing effect matcher', () => {
  const A = load(), home = 'C:\\Users\\a.name';
  for (const p of ['~/.ssh/*', '~/.config/gh/*', '~/.claude/**']) assert.match(A.refusal(files(p), { home }), /credentials/);
  for (const p of ['~/project/.git/hooks/*', '~/project/.vscode/tasks.json', '~/project/package.json']) assert.match(A.refusal({ ...files(p), tools: ['Write'] }, { home }), /runs later/);
});
test('unqualified or ambiguous home never supplies whole-home validation authority', () => {
  const A = load();
  for (const home of ['C:relative', '\\\\server\\share', '//server/share', 'relative/home', null, ['C:\\Users\\fixture']]) assert.match(A.refusal(files('~/**'), { home }), /fully qualified/);
});
test('POSIX period/literal-backslash credential spelling retains exact lexical interpretation', () => {
  const A = load('posix'), home = '/Users/a.name';
  assert.match(A.refusal(files('~/.ssh/*'), { home }), /credentials/);
  assert.equal(A.refusal(files('~/literal\\.ssh/*'), { home }), null);
  assert.equal(A.refusal({ ...files('~/literal\\.git/hooks/*'), tools: ['Write'] }, { home }), null);
});
test('same-drive conservative Windows refusal is retained instead of enabling formerly unmatched effects', () => {
  const A = load('win32', 'D:\\fixture'), home = 'D:\\Users\\fixture';
  const rule = files('~/Development/app/**');
  assert.match(A.refusal(rule, { home }), /whole home/);
  assert.equal(A.matchRule([rule], req('D:\\Users\\fixture\\Development\\app\\notes.txt', 'D:\\Users\\fixture\\Development\\app'), { home, realpath: p => p }), null);
});
