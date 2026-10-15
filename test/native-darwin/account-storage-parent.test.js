'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('account-storage provenance guard refuses an ordinary launcher and caller-supplied identity', { skip: process.platform !== 'darwin' }, () => {
  const guard = path.resolve(__dirname, '../../native/account-storage-build/buddy-account-storage-parent');
  for (const args of [[], [String(process.ppid)], ['--parent', String(process.pid)]]) {
    const result = spawnSync(guard, args, { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
