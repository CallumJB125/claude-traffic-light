'use strict';
// Windows path grammar runs the actual guard with host-independent path APIs.
// The separate host fixture exercises real symlinks; no Windows kernel claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Guard = require('../hooks/pending-input');
const { hashToolInput } = require('../hooks/answer-file');

function grammar(platform = 'win32', aliases = {}) {
  const source = require.resolve('../hooks/pending-input');
  const localRequire = createRequire(source);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture';
  const cwd = platform === 'win32' ? 'D:\\checkout' : '/checkout';
  let resolutions = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, exports: module.exports, process: { platform },
    require(name) {
      if (name === 'path') return paths;
      if (name === 'os') return { homedir: () => home };
      if (name === 'fs') return { realpathSync: { native(file) {
        resolutions++;
        return aliases[file] ?? paths.resolve(cwd, file);
      } } };
      // VM objects have another prototype. Preserve the real canonical hash
      // after the same JSON wire roundtrip as a recorded hook suggestion.
      if (name === './answer-file.js') return { hashToolInput: value => hashToolInput(JSON.parse(JSON.stringify(value))) };
      return localRequire(name);
    },
  }, { filename: source });
  return { guard: module.exports, home, resolutions: () => resolutions };
}

test('Windows permission suggestions refuse every drive/share root even when HOME is on another drive', () => {
  const { guard, home } = grammar();
  for (const dir of ['/', '\\', 'D:\\', 'D:/', 'd:\\\\', 'C:\\', '\\\\server\\share', '//server/share/']) {
    assert.equal(guard.broadDirectory(dir, home), true, dir);
  }
});

test('Windows ambiguous relative/rooted and device namespace inputs refuse before filesystem resolution', () => {
  for (const dir of ['D:repo', 'repo', '/workspace/app', '\\workspace\\app', '\\\\server', '\\\\?\\D:\\repo', '\\\\.\\D:\\repo', '\\\\?\\UNC\\server\\share\\repo']) {
    const f = grammar();
    assert.equal(f.guard.broadDirectory(dir, f.home), true, dir);
    assert.equal(f.resolutions(), 0, `no resolution for ${dir}`);
  }
});

test('Windows a fully qualified path whose current canonical target is a foreign drive root refuses', () => {
  const alias = 'C:\\links\\other-volume';
  const f = grammar('win32', { [alias]: 'D:\\' });
  assert.equal(f.guard.broadDirectory(alias, f.home), true);
  assert.ok(f.resolutions() > 0, 'canonical target was observed');
});

test('Windows fully qualified narrow paths on home/other drive and UNC share remain usable', () => {
  const f = grammar();
  for (const dir of ['C:\\Users\\fixture\\work\\app', 'c:/Users/FIXTURE/work/app', 'D:\\workspace\\app', '\\\\server\\share\\app', 'C:\\Users\\fixture-two\\app']) {
    assert.equal(f.guard.broadDirectory(dir, f.home), false, dir);
  }
});

test('Windows canonical home/ancestor and credential aliases retain their refusal', () => {
  const aliases = { 'D:\\links\\home': 'C:\\Users\\fixture', 'D:\\links\\keys': 'C:\\Users\\fixture\\.ssh' };
  const f = grammar('win32', aliases);
  for (const dir of ['C:\\Users', 'c:/users/FIXTURE', 'C:\\Users\\fixture\\.claude\\settings', 'C:\\Users\\fixture\\.ssh', ...Object.keys(aliases)]) {
    assert.equal(f.guard.broadDirectory(dir, f.home), true, dir);
  }
});

test('Windows a root suggestion cannot be shown or replayed through a correctly hashed answer', () => {
  const f = grammar();
  const suggestion = { type: 'addDirectories', directories: ['D:/'] };
  assert.equal(f.guard.cleanSuggestions([suggestion]).length, 0);
  const request = { kind: 'permission', channel: 'PermissionRequest', permissionSuggestions: [suggestion] };
  assert.equal(f.guard.answerOutput(request, { decision: 'allow', extra: { permissionIndex: 0, suggestionHash: hashToolInput(suggestion) } }), null);
  const narrow = { type: 'addDirectories', directories: ['D:\\workspace\\app'] };
  request.permissionSuggestions = [narrow];
  const result = f.guard.answerOutput(request, { decision: 'allow', extra: { permissionIndex: 0, suggestionHash: hashToolInput(narrow) } });
  assert.equal(result.hookSpecificOutput.decision.updatedPermissions[0].directories[0], narrow.directories[0]);
  assert.equal(result.hookSpecificOutput.decision.updatedPermissions[0].destination, 'session');
});

test('actual fresh host home/ancestor and symlink targets refuse while narrow directories retain bytes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-permission-directory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), allowed = path.join(home, 'work', 'app'), keys = path.join(home, '.ssh');
  fs.mkdirSync(allowed, { recursive: true }); fs.mkdirSync(keys);
  const bytes = Buffer.from('Synthetic preserved instructions\r\n');
  const file = path.join(allowed, 'README.md'); fs.writeFileSync(file, bytes);
  const homeAlias = path.join(root, 'home-alias'), keyAlias = path.join(root, 'key-alias'), safeAlias = path.join(root, 'safe-alias');
  for (const [target, link] of [[home, homeAlias], [keys, keyAlias], [allowed, safeAlias]]) fs.symlinkSync(target, link, 'junction');
  for (const dir of [home, root, homeAlias, keyAlias]) assert.equal(Guard.broadDirectory(dir, home), true, dir);
  for (const dir of [allowed, safeAlias]) assert.equal(Guard.broadDirectory(dir, home), false, dir);
  assert.ok(fs.readFileSync(file).equals(bytes));
  assert.equal(fs.lstatSync(safeAlias).isSymbolicLink(), true, 'the actual alias was not replaced');
});

test('POSIX absolute narrow paths, roots, home ancestors and credential policy retain their behavior', () => {
  const f = grammar('linux');
  for (const dir of ['/', '/home', '/home/fixture', '/home/fixture/.ssh', '/home/fixture/.claude/settings']) assert.equal(f.guard.broadDirectory(dir, f.home), true, dir);
  for (const dir of ['/workspace/app', '/home/fixture/work/app', '/home/fixture-two/app']) assert.equal(f.guard.broadDirectory(dir, f.home), false, dir);
});
