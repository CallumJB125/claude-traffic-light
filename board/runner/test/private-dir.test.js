// App mode (D37a) data_dir checks: symlink, foreign uid, a chmod that fails
// or leaves group/other bits, all refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from '../util.js';
import { tmpDir, rm } from './helpers.js';

test('ensurePrivateDir: creates 0700, tightens a wide dir, refuses symlink / other uid / failed chmod', () => {
  const root = tmpDir();
  const getuid = process.getuid;
  const chmodSync = fs.chmodSync;
  try {
    const fresh = ensurePrivateDir(path.join(root, 'a', 'b'));
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
    const wide = path.join(root, 'wide');
    fs.mkdirSync(wide);
    fs.chmodSync(wide, 0o755);
    ensurePrivateDir(wide);
    assert.equal(fs.statSync(wide).mode & 0o777, 0o700);

    fs.symlinkSync(fresh, path.join(root, 'link'));
    assert.throws(() => ensurePrivateDir(path.join(root, 'link')), /symlink/);

    process.getuid = () => getuid.call(process) + 1;
    assert.throws(() => ensurePrivateDir(fresh), /not owned/);
    process.getuid = getuid;

    fs.chmodSync(wide, 0o755);
    fs.chmodSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    assert.throws(() => ensurePrivateDir(wide), /EPERM/, 'a failed chmod is fatal');
    fs.chmodSync = () => {};
    assert.throws(() => ensurePrivateDir(wide), /not private/, 'still wide after the chmod');
  } finally {
    process.getuid = getuid;
    fs.chmodSync = chmodSync;
    rm(root);
  }
});
