const test = require('node:test');
const assert = require('node:assert/strict');
const PowerShell = require('../src/powershell.js');

// Folder names that closed the old '…' literal: ASCII and every quote mark
// PowerShell accepts (U+2018–U+201B), plus the usual shell metacharacters.
const HOSTILE = [
  "x';calc;'",
  'x’;calc;’',
  'x‘;calc;‘',
  'x‚;calc;‚',
  'x‛;calc;‛',
  'x";calc;"',
  'x“;calc;”',
  '$(calc)',
  '`calc`',
  'a; Remove-Item -Recurse C:\\',
];

for (const [name, script] of Object.entries(PowerShell.SCRIPTS)) {
  test(`powershell ${name}: values ride in env vars and never appear in the script text`, () => {
    for (const value of HOSTILE) {
      const values = name === 'appActivate' ? [value, 'Windows Terminal'] : [value];
      const c = PowerShell.command(script, values);
      const text = c.args[c.args.length - 1];
      assert.ok(!text.includes(value), `${name}: ${value} leaked into ${text}`);
      assert.ok(!/[‘’‚‛“”]/.test(text), `${name}: curly quote in script text`);
      assert.ok(text.includes(`$env:${PowerShell.ENV_PREFIX}0`), `${name}: reads its value from the environment`);
      assert.equal(c.env[`${PowerShell.ENV_PREFIX}0`], value);
      if (name === 'appActivate') assert.equal(c.env[`${PowerShell.ENV_PREFIX}1`], 'Windows Terminal');
    }
  });
}

test('powershell runs without a profile, non-interactive and hidden, with -Command last before the script', () => {
  const c = PowerShell.command(PowerShell.SCRIPTS.speak, ['hi']);
  assert.equal(c.file, 'powershell');
  assert.deepEqual(c.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command']);
});

test('powershell env: keeps the parent environment and stringifies values', () => {
  const env = PowerShell.envFor([null, 3], { PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin', [`${PowerShell.ENV_PREFIX}0`]: '', [`${PowerShell.ENV_PREFIX}1`]: '3' });
});
