// filesHolding (helpers.js) walks a folder git may be deleting under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rm, filesHolding } from './helpers.js';

test('filesHolding: finds files holding the needle; a folder that vanished holds nothing; any other error still throws', () => {
  const root = tmpDir();
  try {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'hit.txt'), 'xx SECRET yy');
    fs.writeFileSync(path.join(root, 'a', 'miss.txt'), 'nothing');
    assert.deepEqual(filesHolding(root, 'SECRET'), [path.join(root, 'a', 'b', 'hit.txt')]);
    assert.deepEqual(filesHolding(path.join(root, 'gone', 'worktrees'), 'SECRET'), [], 'ENOENT: the folder was deleted mid-walk');
    assert.throws(() => filesHolding(path.join(root, 'a', 'miss.txt'), 'SECRET'), (e) => e.code === 'ENOTDIR', 'not ENOENT: still an error');
  } finally { rm(root); }
});
