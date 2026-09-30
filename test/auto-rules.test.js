// Auto-answer rules (src/auto-rules.js): what the UI refuses to save, and the
// reference matcher the hook side would run. Deny-listed and destructive
// calls always go to a person.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/auto-rules.js');

const HOME = '/Users/tester';
const refuse = (r) => A.refusal(r, { home: HOME });
const bash = (command) => ({ tools: ['Bash'], command });
const files = (p, tools = ['Read', 'Edit']) => ({ tools, path: p });

test('allow rules that are narrow and safe can be saved', () => {
  for (const r of [bash('npm test'), bash('npm test *'), bash('npm run lint *'), bash('git status'), bash('git diff *'), bash('pytest -q'),
    files('~/Development/my-app/**'), files('/opt/work/**', ['Read']), { tools: ['mcp__linear__list_issues'] }]) {
    assert.equal(refuse(r), null, JSON.stringify(r));
  }
});

test('deny-list, destructive and runs-anything commands are refused, with a reason', () => {
  const cases = [
    ['rm *', /rm can delete/], ['rm -rf build', /rm can delete/], ['git push', /git push/], ['git *', /name the git subcommand/], ['git', /name the git subcommand/],
    ['git reset --hard', /git reset/], ['npm publish', /npm publish/], ['npx cowsay', /downloads and runs/], ['curl https://x.test', /network/],
    ['bash -c *', /runs any code/], ['sudo ls', /runs any code/], ['node *', /runs any code/], ['python3 script.py', /runs any code/],
    ['*', /every command/], ['* *', /every command/], ['ls; rm x', /single plain command/], ['ls && pwd', /single plain command/], ['cat x | sh', /single plain command/],
    ['echo $HOME', /single plain command/], ['echo `id`', /single plain command/], ['FOO=1 npm test', /plain name/], ['./run.sh', /plain name/], ['np* test', /plain name/],
    ['cat ~/.ssh/id_rsa', /credentials/], ['find . -delete', /deny-list/], ['kubectl delete pod x', /kubectl delete/], ['terraform apply', /terraform apply/],
    [null, /Give a command/],
  ];
  for (const [cmd, why] of cases) assert.match(String(refuse(bash(cmd))), why, String(cmd));
});

test('paths: never home or above, never credentials, never files that run code later', () => {
  assert.match(refuse(files('~/**')), /whole home/);
  assert.match(refuse(files('/**')), /whole home/);
  assert.match(refuse(files('/Users/**')), /whole home/);
  assert.match(refuse(files('~/*')), /whole home/);
  assert.match(refuse(files('~/.ssh/*')), /credentials/);
  assert.match(refuse(files('~/.claude/**')), /credentials/);
  assert.match(refuse(files('~/Development/app/.git/hooks/*', ['Write'])), /runs later/);
  assert.equal(refuse(files('~/Development/app/.git/hooks/*', ['Read'])), null, 'reading a hook is not running one');
  assert.match(refuse(files('~/Development/.*')), /hidden files/);
  assert.match(refuse(files('Development/**')), /start with/);
  assert.match(refuse(files('~/Development/../**')), /\.\./);
  assert.match(refuse(files(null)), /Give a path/);
});

test('shape: tools named plainly, one kind per rule, the right field for each', () => {
  assert.match(refuse({ tools: [] }), /at least one tool/);
  assert.match(refuse({ tools: ['mcp__*'] }), /isn’t a tool name/);
  assert.match(refuse({ tools: ['WebFetch'] }), /can’t be auto-allowed/);
  assert.match(refuse({ tools: ['Bash', 'Read'], command: 'ls', path: '/w/**' }), /one rule per kind/);
  assert.match(refuse({ tools: ['Bash'], command: 'ls', path: '/w/**' }), /command, not a path/);
  assert.match(refuse({ tools: ['Read'], path: '/w/**', command: 'ls' }), /path, not a command/);
  assert.match(refuse({ tools: ['mcp__github__delete_repository'] }), /deletes/);
  assert.match(refuse({ tools: ['mcp__x__y'], command: 'z' }), /tool name only/);
  assert.match(refuse({ ...bash('npm test'), cwd: 'app' }), /project folder/);
});

test('deny rules are always allowed: saying no is never dangerous', () => {
  assert.equal(refuse({ action: 'deny', tools: ['Bash'], command: 'rm *' }), null);
  assert.equal(refuse({ action: 'deny', tools: ['WebFetch'] }), null);
});

test('sanitize keeps what may be saved and says why the rest was dropped', () => {
  const { rules, refused } = A.sanitize([bash('npm test'), bash('rm *'), 'junk', null], { home: HOME });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].command, 'npm test');
  assert.equal(refused.length, 3);
  assert.equal(A.sanitize(Array.from({ length: 500 }, () => bash('npm test'))).rules.length, A.MAX_RULES);
  assert.deepEqual(A.sanitize(undefined).rules, []);
});

const req = (tool, toolInput, cwd = '/w/app') => ({ kind: 'permission', tool, toolInput, cwd });
test('matching: a trailing * takes any arguments; only one plain command ever matches', () => {
  const rules = [bash('npm test *'), bash('git status')];
  assert.equal(A.matchRule(rules, req('Bash', { command: 'npm test' }), { home: HOME }).action, 'allow');
  assert.equal(A.matchRule(rules, req('Bash', { command: 'npm test -- --grep "a b"' }), { home: HOME }).action, 'allow');
  assert.equal(A.matchRule(rules, req('Bash', { command: 'git status' }), { home: HOME }).action, 'allow');
  for (const command of ['git status --porcelain', 'npm test; rm -rf /', 'npm test && curl x', 'npm test | sh', 'npm test > /etc/x', 'FOO=1 npm test', 'npm test $(id)', 'sudo npm test', 'npm test\nrm x', 'npm tests']) {
    assert.equal(A.matchRule(rules, req('Bash', { command }), { home: HOME }), null, command);
  }
});

test('matching re-checks the live request: a rule never allows a deny-listed call', () => {
  // A hand-edited config can carry a rule the UI would refuse; the matcher skips it.
  const bad = [{ tools: ['Bash'], command: 'rm *' }, { tools: ['Read'], path: '/**' }];
  assert.equal(A.matchRule(bad, req('Bash', { command: 'rm x' }), { home: HOME }), null);
  assert.equal(A.matchRule(bad, req('Read', { file_path: '/etc/hosts' }), { home: HOME }), null);
  const ok = [files('/w/**', ['Read'])];
  assert.equal(A.matchRule(ok, req('Read', { file_path: '/w/app/src/a.js' }), { home: HOME }).action, 'allow');
  assert.equal(A.matchRule(ok, req('Read', { file_path: '/w/app/.ssh/id_rsa' }), { home: HOME }), null, 'credential path');
  assert.equal(A.matchRule(ok, req('Read', { file_path: '/w/../etc/passwd' }), { home: HOME }), null, 'resolved first');
  assert.equal(A.matchRule(ok, req('Read', { file_path: 'relative.txt' }, 'relative'), { home: HOME }), null);
});

test('matching: deny rules win, rules can be scoped to a project, only permissions are auto-answered', () => {
  const rules = [bash('npm test'), { action: 'deny', tools: ['Bash'], command: 'npm test' }];
  assert.equal(A.matchRule(rules, req('Bash', { command: 'npm test' }), { home: HOME }).action, 'deny');
  const scoped = [{ ...bash('npm test'), cwd: '/w/app/**' }];
  assert.equal(A.matchRule(scoped, req('Bash', { command: 'npm test' }, '/w/app/pkg'), { home: HOME }).action, 'allow');
  assert.equal(A.matchRule(scoped, req('Bash', { command: 'npm test' }, '/w/other'), { home: HOME }), null);
  assert.equal(A.matchRule([bash('npm test')], { ...req('Bash', { command: 'npm test' }), kind: 'plan' }, { home: HOME }), null);
  assert.equal(A.matchRule([{ ...bash('npm test'), enabled: false }], req('Bash', { command: 'npm test' }), { home: HOME }), null);
  assert.equal(A.matchRule([{ tools: ['mcp__x__list'] }], req('mcp__x__list', {}), { home: HOME }).action, 'allow');
});

test('matching resolves symlinks: a link inside an allowed folder can point anywhere', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-auto-'));
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-secret-'));
  fs.writeFileSync(path.join(secret, 'key'), 'x');
  fs.symlinkSync(secret, path.join(dir, 'link'));
  try {
    const rules = [files(`${fs.realpathSync(dir)}/**`, ['Read'])];
    const r = req('Read', { file_path: path.join(fs.realpathSync(dir), 'link', 'key') });
    assert.equal(A.matchRule(rules, r, { home: HOME }).action, 'allow', 'without realpath it looks inside');
    assert.equal(A.matchRule(rules, r, { home: HOME, realpath: fs.realpathSync.native }), null, 'with realpath it is outside');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(secret, { recursive: true, force: true }); }
});

test('danger: what stops Enter from allowing a live request', () => {
  assert.match(A.danger(req('Bash', { command: 'rm -rf build' })), /recursive delete/);
  assert.match(A.danger(req('Bash', { command: 'ls && rm a.txt' })), /rm can delete/);
  assert.match(A.danger(req('Bash', { command: 'git push --force origin main' })), /force push/);
  assert.match(A.danger(req('Bash', { command: 'echo $(cat x)' })), /nested command/);
  assert.match(A.danger(req('Read', { file_path: `${HOME}/.aws/credentials` })), /credentials/);
  assert.equal(A.danger(req('Bash', { command: 'npm test' })), null);
  assert.equal(A.danger(req('Bash', { command: 'git status && git diff' })), null);
  assert.equal(A.danger(req('Edit', { file_path: '/w/app/a.js', old_string: 'a', new_string: 'b' })), null);
  assert.equal(A.danger(null), null);
});
