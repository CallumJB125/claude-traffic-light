'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { remoteVerdict, allowListReason } = require('../src/deny/allowlist');
const { compileRules, evaluateDenyList } = require('../src/deny/denylist');
const { canonicalize } = require('../src/deny/canonical');
const rules = compileRules(); const cwd = String.raw`C:\Users\fixture\project`, home = String.raw`C:\Users\fixture`;
const read = (file, opts = {}) => remoteVerdict(rules, { toolName: 'Read', toolInput: { file_path: file }, cwd }, { home, ...opts });
test('Windows credential spellings are denied before filesystem calls and signed input stays byte-identical', () => {
  for (const file of [String.raw`C:\Users\fixture\.ssh\id_ed25519`, String.raw`C:\Users\fixture\.config\gh\hosts.yml`, String.raw`C:\Users\fixture\project\.env`, String.raw`C:\Users\fixture\.claude.json`]) {
    const input = Object.freeze({ file_path: file }); const before = canonicalize(input); let calls = 0;
    // .env is a secrets-file refusal in the allow-list; the compiled
    // credential rule covers the other three without changing its authority.
    if (!file.endsWith('.env')) assert.equal(evaluateDenyList(rules, { toolName: 'Read', toolInput: input, cwd }).blocked, true);
    assert.equal(read(file, { realpath: () => { calls++; throw Error('should not inspect'); } }).blocked, true);
    assert.equal(calls, 0); assert.equal(canonicalize(input), before);
  }
});
test('Windows qualified and relative junction paths reach actual supplied resolution and deny the private target', () => {
  for (const file of [String.raw`C:\Users\fixture\project\linked-key`, 'linked-key']) {
    const seen = [];
    const verdict = read(file, { realpath: p => { seen.push(p); return String.raw`C:\Users\fixture\.ssh\id_ed25519`; } });
    assert.equal(verdict.blocked, true); assert.match(verdict.reason, /symlink/);
    assert.deepEqual(seen, ['C:/Users/fixture/project/linked-key']);
  }
});
test('missing Windows file resolves only its actual parent and keeps credential boundary', () => {
  const seen = []; const result = read('new-key', { realpath: p => { seen.push(p); if (p.endsWith('/new-key')) throw Object.assign(Error('missing synthetic leaf'), { code: 'ENOENT' }); return String.raw`C:\Users\fixture\.ssh`; } });
  assert.equal(result.blocked, true); assert.deepEqual(seen, ['C:/Users/fixture/project/new-key', 'C:/Users/fixture/project']);
});
test('Windows unavailable failed or relative resolver result never authorizes Read', () => {
  for (const opts of [{}, { realpath: () => { throw Error('private failure'); } }, { realpath: () => 'unbound/relative' }]) assert.equal(read('safe.txt', opts).blocked, true);
});
test('Windows ambiguous namespaces aliases streams devices traversal and invisible characters refuse before filesystem access', () => {
  const paths = [String.raw`\\server\share\safe`, String.raw`\\?\C:\safe`, String.raw`\\.\pipe\safe`, 'C:relative', '\\rooted',
    'safe.txt:stream', 'folder./safe', 'folder /safe', '../safe', 'a/../safe', 'NUL.txt', 'COM1', 'COM¹.txt', 'COM²', 'LPT³', 'PROGRA~1/safe', 'safe\u0000.txt', '~/safe'];
  for (const file of paths) { let called = 0; assert.equal(read(file, { realpath: () => { called++; return cwd; } }).blocked, true, file); assert.equal(called, 0, file); }
});
test('Windows directory-wide Grep refuses home drive and credential parents including resolved home alias', () => {
  for (const [where, resolved] of [[home, home], ['C:\\', 'C:\\'], [String.raw`C:\Users\fixture\.config`, String.raw`C:\Users\fixture\.config`], ['linked-home', String.raw`\\?\C:\Users\fixture`]]) {
    const reason = allowListReason({ toolName: 'Grep', toolInput: { pattern: 'safe', path: where }, cwd }, { home, realpath: () => resolved });
    assert.match(reason, /drive|home|credentials/, where);
  }
});
test('previously eligible Windows safe Read remains read-only and Windows writes always need a person', () => {
  assert.equal(read('safe.txt', { realpath: p => p }).blocked, false);
  for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(allowListReason({ toolName, toolInput: { file_path: 'safe.txt' }, cwd }, { home, realpath: p => p }));
});
test('POSIX literal-backslash native lookup remains exact rather than changing the real directory', () => {
  const seen = [];
  const reason = allowListReason({ toolName: 'Read', toolInput: { file_path: 'literal\\file' }, cwd: '/project/literal\\directory' },
    { home: '/home/fixture', realpath: p => { seen.push(p); return '/home/fixture/.ssh/key'; } });
  assert.match(reason, /symlink/); assert.deepEqual(seen, ['/home/fixture', '/project/literal\\directory/literal\\file']);
});
test('actual current-host owned symlink to credentials is refused without reading private content', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-approval-path-'));
  try {
    const project = path.join(temp, 'project'), keys = path.join(temp, '.ssh'); fs.mkdirSync(project); fs.mkdirSync(keys); fs.writeFileSync(path.join(keys, 'key'), 'synthetic sentinel');
    const link = path.join(project, 'link'); fs.symlinkSync(keys, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = remoteVerdict(rules, { toolName: 'Read', toolInput: { file_path: path.join('link', 'key') }, cwd: project }, { home: temp, realpath: fs.realpathSync.native });
    assert.equal(result.blocked, true); assert.match(result.reason, /symlink/); assert.equal(fs.readFileSync(path.join(keys, 'key'), 'utf8'), 'synthetic sentinel');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Windows Glob patterns cannot bypass filesystem checking or authorize recursive junction traversal', () => {
  for (const [dir, pattern] of [[cwd, 'linked/**'], ['/project', String.raw`C:\Users\fixture\project\linked\**`]]) {
    let calls = 0;
    assert.ok(allowListReason({ toolName: 'Glob', toolInput: { pattern }, cwd: dir }, { home, realpath: p => { calls++; return p; } }));
    assert.equal(calls, 0);
    assert.ok(allowListReason({ toolName: 'Glob', toolInput: { pattern }, cwd: dir }, { home }));
  }
});

test('Windows spelling never switches a POSIX session to a different filesystem root', () => {
  const seen = [];
  assert.ok(allowListReason({ toolName: 'Read', toolInput: { file_path: String.raw`C:\project\safe.txt` }, cwd: '/project' }, { home: '/home/fixture', realpath: p => { seen.push(p); return p; } }));
  assert.deepEqual(seen, ['/home/fixture']);
});

test('Windows access failure cannot use parent fallback to approve an unresolved entry', () => {
  const seen = [];
  const verdict = read('linked-key', { realpath: p => { seen.push(p); if (p.endsWith('/linked-key')) throw Object.assign(Error('denied'), { code: 'EACCES' }); return cwd; } });
  assert.equal(verdict.blocked, true); assert.deepEqual(seen, ['C:/Users/fixture/project/linked-key']);
});
test('missing Windows drive-root leaf resolves the root rather than its per-drive current directory', () => {
  const seen = [];
  const verdict = read('C:/new.txt', { realpath: p => { seen.push(p); if (p.endsWith('/new.txt')) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return p; } });
  assert.equal(verdict.blocked, false); assert.deepEqual(seen, ['C:/new.txt', 'C:/']);
});

test('implicit Windows Grep directory gets the same resolved credential check as explicit paths', () => {
  for (const resolved of ['C:/Users/fixture/.ssh', 'C:/Users/fixture/.config/gh', '//?/C:/Users/fixture/.ssh']) {
    assert.ok(allowListReason({ toolName: 'Grep', toolInput: { pattern: 'synthetic' }, cwd }, { home, realpath: () => resolved }));
  }
});
test('implicit Windows Grep refuses relative UNC and opaque volume resolver results', () => {
  for (const resolved of ['relative/unbound', '//server/share/project', '//?/Volume{opaque}/project']) {
    assert.ok(allowListReason({ toolName: 'Grep', toolInput: { pattern: 'synthetic' }, cwd }, { home, realpath: () => resolved }));
  }
});

test('POSIX shell drive-looking component stays relative and cannot bypass its actual credential link', () => {
  const seen = [];
  const reason = allowListReason({ toolName: 'Bash', toolInput: { command: 'cat C:/link' }, cwd: '/project' }, {
    home: '/home/fixture', realpath: p => {
      seen.push(p);
      if (p === '/project/C:/link') return '/home/fixture/.ssh/key';
      if (p === '/home/fixture') return p;
      throw Object.assign(Error('absent synthetic path'), { code: 'ENOENT' });
    },
  });
  assert.match(reason, /credentials/); assert.deepEqual(seen, ['/home/fixture', '/project/C:/link']);
});
