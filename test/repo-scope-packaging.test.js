'use strict';
// The engine (in app.asar, under Electron's utility process) and the hooks
// (Resources/hooks, run by the CLIs) must load the same hooks/repo-scope.js,
// in dev and packaged layouts alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

function globMatches(pattern, file) {
  const re = pattern.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}(?:/.*)?$`).test(file);
}
function inAsar(file) {
  let included = false;
  for (const p of [...pkg.build.files, '!board/shared/test-support/**']) {
    if (p.startsWith('!')) { if (globMatches(p.slice(1), file)) included = false; } else if (globMatches(p, file)) included = true;
  }
  return included;
}

test('the engine resolves ../../hooks/repo-scope.js: the same repo file in dev, and app.asar/hooks/repo-scope.js packaged', () => {
  const engine = read('board/tasks-engine/engine.js');
  const m = /createRequire\(import\.meta\.url\)\('([^']+)'\)/.exec(engine);
  assert.ok(m, 'engine loads the resolver through createRequire');
  assert.equal(path.posix.join('board/tasks-engine', m[1]), 'hooks/repo-scope.js');
  assert.ok(inAsar('board/tasks-engine/engine.js'), 'the engine ships in app.asar');
  assert.ok(inAsar('hooks/repo-scope.js'), 'so does hooks/repo-scope.js, beside it as ../../hooks');
  assert.ok(!pkg.build.asarUnpack.some((p) => globMatches(p, 'board/tasks-engine/engine.js')), 'the engine is not unpacked away from it');
});

test('the hooks load it from their own folder, which ships whole as Resources/hooks', () => {
  for (const f of ['hooks/awareness.js']) assert.match(read(f), /require\('\.\/repo-scope'\)/);
  assert.ok(pkg.build.extraResources.some((e) => e && e.from === 'hooks' && e.to === 'hooks'));
  assert.match(read('src/agent-awareness.js'), /require\('\.\.\/hooks\/repo-scope\.js'\)/, 'main uses the same file');
});

test('hooks/repo-scope.js is dependency-free and fs-free (callers inject git and realpath)', () => {
  const t = read('hooks/repo-scope.js');
  assert.deepEqual([...t.matchAll(/require\(([^)]*)\)/g)].map((x) => x[1]), ["'path'"]);
  assert.ok(!/[a-zA-Z]Sync\s*\(/.test(t), 'no sync calls: main runs it too');
});
