// Launch profile hardening: trusted instructions come only from regular files
// inside the checkout; permission levels change the settings for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trustedInstructions, buildSettings } from '../launch.js';
import { tmpDir, rm } from './helpers.js';

test('trustedInstructions reads regular files only: no symlinked CLAUDE.md or rules, nothing outside the checkout', () => {
  const root = tmpDir();
  try {
    const co = path.join(root, 'co');
    fs.mkdirSync(path.join(co, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(co, 'CLAUDE.md'));
    fs.writeFileSync(path.join(co, '.claude', 'rules', 'a.md'), 'rule a');
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(co, '.claude', 'rules', 'b.md'));
    const t = trustedInstructions(co);
    assert.ok(t.includes('rule a'));
    assert.ok(!t.includes('TOP SECRET'));
    fs.rmSync(path.join(co, '.claude', 'rules'), { recursive: true });
    fs.symlinkSync(root, path.join(co, '.claude', 'rules'));
    fs.writeFileSync(path.join(root, 'x.md'), 'OUTSIDE');
    assert.ok(!trustedInstructions(co).includes('OUTSIDE'), 'a symlinked rules dir is not followed');
  } finally { rm(root); }
});

test('buildSettings: no level = the board profile, unchanged; levels narrow it', () => {
  const base = { worktree: '/w', tmpdir: '/tmp' };
  const board = buildSettings(base);
  assert.equal(board.permissions.defaultMode, 'acceptEdits');
  assert.equal(board.sandbox.autoAllowBashIfSandboxed, true);
  assert.deepEqual(buildSettings({ ...base, level: 'auto' }).permissions, board.permissions);
  const ask = buildSettings({ ...base, level: 'ask' });
  assert.equal(ask.permissions.defaultMode, 'default');
  assert.equal(ask.sandbox.autoAllowBashIfSandboxed, false);
  assert.ok(!ask.permissions.allow.includes('Edit'));
  const edits = buildSettings({ ...base, level: 'auto-edits' });
  assert.ok(edits.permissions.allow.includes('Edit'));
  assert.equal(edits.sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(buildSettings({ ...base, level: 'plan' }).permissions.defaultMode, 'plan');
  for (const s of [board, ask, edits]) assert.ok(!('allowUnixSockets' in s.sandbox.network) && !('allowUnixSockets' in s.sandbox));
  assert.deepEqual(buildSettings({ ...base, cacheWrite: [] }).sandbox.filesystem.allowWrite, ['/w', '/tmp']);
});
