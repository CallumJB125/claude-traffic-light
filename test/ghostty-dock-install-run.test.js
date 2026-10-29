'use strict';
// The real one-use install script, run by zsh in a temp folder with only its
// installer line swapped for a stub, so nothing is downloaded or installed.
// Security review L2 (any typed line installed) and L3 (a failed download
// still said "Done.").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { testTempDir } = require('./helpers/tmp');
const I = require('../src/ghostty-dock-install.js');

// The script is a zsh script run by the macOS Terminal; where /bin/zsh is absent these three cannot run it.
const NO_ZSH = !fs.existsSync('/bin/zsh') && 'needs /bin/zsh (the script is zsh)';

const RAN = 'STUB-INSTALLER-RAN';
function runScript(input, stub = `print -r -- ${RAN}`) {
  const root = testTempDir('px-dock-run-');
  try {
    const s = I.writeScript({ tempDir: root });
    const body = fs.readFileSync(s.file, 'utf8');
    assert.ok(body.includes(`\n${I.INSTALL_COMMAND}\n`), 'the installer line is there to stub');
    fs.writeFileSync(s.file, body.replace(`\n${I.INSTALL_COMMAND}\n`, `\n${stub}\n`));
    const r = spawnSync('/bin/zsh', ['-f', s.file], { input, encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', HOME: root } });
    return { code: r.status, out: r.stdout, gone: !fs.existsSync(s.dir) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('L2: anything but an empty line or y/Y cancels, says so, and runs nothing', { skip: NO_ZSH }, () => {
  for (const input of ['no\n', 'n\n', 'N\n', 'nope\n', 'yes please\n', ' \n', 'yy\n', 'x\n']) {
    const r = runScript(input);
    assert.doesNotMatch(r.out, new RegExp(RAN), JSON.stringify(input));
    assert.match(r.out, /Cancelled: nothing was installed\./, JSON.stringify(input));
    assert.notEqual(r.code, 0);
    assert.ok(r.gone, 'cleans up');
  }
  const eof = runScript('');
  assert.doesNotMatch(eof.out, new RegExp(RAN));
  assert.notEqual(eof.code, 0);
});

test('L2: Return alone, y or Y installs', { skip: NO_ZSH }, () => {
  for (const input of ['\n', 'y\n', 'Y\n']) {
    const r = runScript(input);
    assert.match(r.out, new RegExp(RAN), JSON.stringify(input));
    assert.match(r.out, /Done\./);
    assert.equal(r.code, 0);
  }
  assert.match(runScript('\n').out, /Press Return or type y to install; anything else cancels\./);
});

test('L3: a failed download in the pipe is reported as a failure, not "Done."', { skip: NO_ZSH }, () => {
  const r = runScript('\n', '/usr/bin/false | /bin/bash');
  assert.doesNotMatch(r.out, /Done\./);
  assert.match(r.out, /The installer stopped with code 1\./);
  assert.equal(r.code, 1);
});
