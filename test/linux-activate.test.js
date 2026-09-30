const test = require('node:test');
const assert = require('node:assert/strict');
const LinuxActivate = require('../src/linux-activate.js');

test('linux activate: the folder name first, then terminal names, via wmctrl -a', async () => {
  const calls = [];
  const exec = async (f, a) => { calls.push([f, ...a]); return a[1] === 'Konsole'; };
  assert.deepEqual(await LinuxActivate.activate('proj', exec), { app: 'Konsole', exact: false });
  assert.deepEqual(calls.slice(0, 3), [['wmctrl', '-a', 'proj'], ['wmctrl', '-a', 'Terminal'], ['wmctrl', '-a', 'Konsole']]);
  assert.deepEqual(await LinuxActivate.activate('proj', async (f, a) => a[1] === 'proj'), { app: 'proj', exact: true });
});

test('linux activate: no wmctrl, or no match, raises nothing', async () => {
  let n = 0;
  assert.equal(await LinuxActivate.activate('proj', async () => { n += 1; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }), null);
  assert.equal(n, 1, 'stops at the first ENOENT');
  assert.equal(await LinuxActivate.activate('', async () => false), null);
});
