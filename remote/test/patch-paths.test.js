// Tools with no path field (Codex's apply_patch, any tool given a patch string)
// name their files in patch headers; those paths get the same checks a file
// tool's path field gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, evaluateDenyList, remoteVerdict, allowListReason } from '../src/index.js';

const rules = compileRules();
const CWD = '/Users/x/app';
const deny = (patch, cwd = CWD) => evaluateDenyList(rules, { toolName: 'apply_patch', toolInput: { input: patch }, cwd });
const allow = (patch, cwd = CWD) => allowListReason({ toolName: 'apply_patch', toolInput: { input: patch }, cwd }, { home: '/Users/x' });
const remote = (patch, cwd = CWD) => remoteVerdict(rules, { toolName: 'apply_patch', toolInput: { input: patch }, cwd }, { home: '/Users/x' });

const FORMS = {
  'add': (p) => `*** Begin Patch\n*** Add File: ${p}\n+x\n*** End Patch`,
  'update': (p) => `*** Begin Patch\n*** Update File: ${p}\n@@\n-a\n+b\n*** End Patch`,
  'delete': (p) => `*** Begin Patch\n*** Delete File: ${p}\n*** End Patch`,
  'move to': (p) => `*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ${p}\n*** End Patch`,
  '--- a/': (p) => `--- a/${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-a`,
  '+++ b/': (p) => `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+a`,
  '+++ with timestamp': (p) => `--- /dev/null\t2026-01-01 00:00:00\n+++ ${p}\t2026-01-01 00:00:00\n@@ -0,0 +1 @@\n+a`,
  'diff --git': (p) => `diff --git a/${p} b/${p}\nindex 0..1 100644`,
  'diff --git quoted': (p) => `diff --git "a/${p}" "b/${p}"\n--- "a/${p}"\n+++ "b/${p}"`,
  'rename to': (p) => `diff --git a/src/a b/src/b\nsimilarity index 100%\nrename from src/a\nrename to ${p}`,
  'copy to': (p) => `diff --git a/src/a b/src/b\ncopy from src/a\ncopy to ${p}`,
};
const RUNS_CODE = ['.git/hooks/pre-commit', '.github/workflows/x.yml', '.husky/pre-commit', 'CLAUDE.md', 'Makefile'];
const CREDENTIALS = ['~/.ssh/id_rsa'];
const SECRETS = ['.env'];

const variants = (s) => ({ lf: s, crlf: s.replace(/\n/g, '\r\n'), indented: s.split('\n').map((l) => `  ${l}`).join('\n'), tab: s.split('\n').map((l) => `\t${l}`).join('\r\n') });

test('patch headers naming files that run code later or credentials are deny-list findings', () => {
  for (const p of [...RUNS_CODE, ...CREDENTIALS]) {
    for (const [form, make] of Object.entries(FORMS)) {
      for (const [v, patch] of Object.entries(variants(make(p)))) {
        assert.equal(deny(patch).blocked, true, `${form} ${v} ${p}`);
      }
    }
  }
});

test('patch headers naming protected paths get a specific allow-list reason', () => {
  for (const p of [...RUNS_CODE, ...CREDENTIALS, ...SECRETS]) {
    for (const [form, make] of Object.entries(FORMS)) {
      for (const [v, patch] of Object.entries(variants(make(p)))) {
        assert.equal(allow(patch), 'protected path (named in a patch)', `${form} ${v} ${p}`);
        assert.equal(remote(patch).blocked, true, `${form} ${v} ${p}`);
      }
    }
  }
});

test('patch paths: absolute, cwd-relative, dot-segment and escaped forms', () => {
  for (const patch of [
    '*** Update File: /Users/x/app/.git/hooks/pre-commit',
    '+++ /Users/x/.zshrc',
    '+++ /usr/local/bin/x',
    '*** Add File: src/../.git/hooks/post-checkout',
    '*** Add File: .git//hooks/./pre-push',
    'diff --git "a/\\056git/hooks/pre-commit" "b/\\056git/hooks/pre-commit"',
    '--- "a/\\056husky/pre-commit"',
    'diff --git a/src/x .github/workflows/y.yml b/src/x .github/workflows/y.yml',
    '+++ b/.husky/pre-commit 2026-01-01 00:00:00',
    '*** Move to:.husky/pre-commit',
  ]) {
    assert.equal(deny(patch).blocked, true, patch);
    assert.equal(allow(patch), 'protected path (named in a patch)', patch);
  }
  // Only the session directory makes these protected.
  assert.equal(deny('*** Add File: bin/x', '/Users/x').blocked, true, 'cwd-joined ~/bin');
  assert.equal(deny('*** Add File: fish/config.fish', '/Users/x/.config').blocked, true, 'cwd-joined ~/.config');
  assert.equal(allow('*** Add File: hooks/pre-commit', '/Users/x/app/.git'), 'protected path (named in a patch)', 'cwd-joined .git/hooks');
});

test('patch paths: any string field of any tool without a path field', () => {
  for (const toolInput of [{ patch: '*** Update File: .husky/pre-commit' }, { command: ['apply_patch', '*** Update File: .husky/pre-commit'] }, '*** Update File: .husky/pre-commit']) {
    assert.equal(evaluateDenyList(rules, { toolName: 'apply_patch', toolInput }).blocked, true, JSON.stringify(toolInput));
    assert.equal(allowListReason({ toolName: 'apply_patch', toolInput, cwd: CWD }), 'protected path (named in a patch)', JSON.stringify(toolInput));
  }
});

test('benign patches are not deny-list findings', () => {
  for (const [form, make] of Object.entries(FORMS)) {
    for (const [v, patch] of Object.entries(variants(make('src/a.ts')))) {
      assert.equal(deny(patch).blocked, false, `${form} ${v}`);
      assert.equal(allow(patch), 'apply_patch is desk-only', `${form} ${v}`);
    }
  }
  assert.equal(deny('--- /dev/null\n+++ /dev/null').blocked, false);
  assert.equal(deny('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-see Makefile docs\n+see the CLAUDE.md notes').blocked, false);
});
