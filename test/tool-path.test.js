const test = require('node:test');
const assert = require('node:assert/strict');
const { toolEnv } = require('../src/tool-path.js');

test('tool env: macOS adds Homebrew exactly as before; Linux /usr/local/bin; Windows untouched', () => {
  assert.equal(toolEnv({}, { PATH: '/usr/bin:/bin' }, 'darwin').PATH, '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.equal(toolEnv({}, {}, 'darwin').PATH, ':/opt/homebrew/bin:/usr/local/bin');
  assert.equal(toolEnv({}, { PATH: '/usr/bin' }, 'linux').PATH, '/usr/bin:/usr/local/bin');
  assert.equal(toolEnv({}, {}, 'linux').PATH, '/usr/local/bin');
  const win = toolEnv({ NO_COLOR: '1' }, { Path: 'C:\\Windows;C:\\Git\\cmd' }, 'win32');
  assert.deepEqual(win, { Path: 'C:\\Windows;C:\\Git\\cmd', NO_COLOR: '1' }, 'no second PATH key beside Path');
});
