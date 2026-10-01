'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Diagnostics = require('../scripts/windows-install-diagnostics');

const root = 'C:\\Users\\runneradmin\\fixture\\installed app';
const row = (image, pid = 42) => ({ pid, parentPid: 12, created: '2026-10-01T00:00:00.000Z', image });
const payload = (...rows) => ({ truncated: false, processes: rows });

test('scoped process metadata resolves long/short aliases and excludes lexical siblings and outside copy', () => {
  const short = 'C:\\Users\\RUNNER~1\\fixture\\installed app\\Plexiform.exe';
  const rows = payload(row(short), row(`${root} sibling\\Plexiform.exe`, 43), row('C:\\Users\\runneradmin\\fixture\\uninstaller-copy\\Uninstall Plexiform.exe', 44));
  const seen = [];
  const result = Diagnostics.scopeProcesses(rows, root, image => { seen.push(image); return image === path.win32.dirname(short) ? root : image; });
  assert.deepEqual(result, { ok: true, images: [{ pid: 42, parentPid: 12, created: rows.processes[0].created, image: 'plexiform.exe' }], truncated: false, unresolved: 0 });
  assert.ok(!JSON.stringify(result).includes('sibling'));
  assert.ok(!JSON.stringify(result).includes('uninstaller-copy'));
  assert.equal(seen.every(image => !image.endsWith('.exe')), true, 'canonicalization opens parent directories instead of running images');
});

test('canonical Windows UNC and extended drive namespaces preserve installation component scope', () => {
  const unc = Diagnostics.scopeProcesses(payload(row('\\\\?\\UNC\\fixture-server\\fixture-share\\installed app\\Plexiform.exe')), '\\\\fixture-server\\fixture-share\\installed app\\', value => value);
  assert.equal(unc.images.length, 1);
  const drive = Diagnostics.scopeProcesses(payload(row('\\\\?\\C:\\fixture\\installed app\\Plexiform.exe')), 'C:\\fixture\\installed app', value => value);
  assert.equal(drive.images.length, 1);
  for (const value of ['C:relative', 'relative', '\\\\?\\GLOBALROOT\\Device\\Volume\\file', 'C:\\x\nsecret', 'C:\\x"secret']) assert.throws(() => Diagnostics.windowsPath(value), /invalid/);
});

test('truncated or unresolved image inventory is explicit and never publishes unscoped paths', () => {
  const truncated = Diagnostics.scopeProcesses({ ...payload(), truncated: true }, root, value => value);
  assert.equal(truncated.ok, false); assert.equal(truncated.truncated, true);
  const unresolved = Diagnostics.scopeProcesses(payload(row('C:\\unrelated\\Plexiform.exe')), root, () => { throw new Error('private path details'); });
  assert.deepEqual(unresolved, { ok: false, images: [], truncated: false, unresolved: 1 });
  assert.ok(!JSON.stringify(unresolved).includes('secret'));
});

test('process inventory refuses extra command lines, invalid identities, malformed arrays and bounds', () => {
  const valid = row(`${root}\\Plexiform.exe`);
  for (const item of [null, [], { ...payload(), extra: 'secret' }, { ...payload(), truncated: 'false' }, { ...payload(), processes: Array(65).fill(valid) }, payload({ ...valid, commandLine: 'secret' }), payload({ ...valid, pid: -1 }), payload({ ...valid, parentPid: 0x100000000 }), payload({ ...valid, created: 'invalid' })]) {
    assert.throws(() => Diagnostics.scopeProcesses(item, root, value => value), /invalid/);
  }
});

test('fixed read-only PowerShell query has a wall deadline/output cap and no install path interpolation', async () => {
  const calls = [];
  const result = await Diagnostics.collect('unused fixture argument', { platform: 'win32', canonicalInstallDir: root, env: { SystemRoot: 'C:\\Windows' }, canonicalize: value => value,
    run: async (exe, args, options) => { calls.push({ exe, args, options }); return JSON.stringify(payload(row(`${root}\\Plexiform.exe`))); } });
  assert.equal(result.ok, true);
  const { exe, args, options } = calls[0];
  assert.equal(exe.toLowerCase(), 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe');
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(args[4], /Get-CimInstance Win32_Process/);
  assert.ok(!/CommandLine|Stop-Process|taskkill|Invoke-Expression/.test(args[4]));
  assert.ok(!args[4].includes(root));
  assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 32768); assert.equal(options.shell, false);
});

test('query failures, extra secret output and output truncation expose only fixed error metadata', async () => {
  const base = { platform: 'win32', canonicalInstallDir: root, env: { SystemRoot: 'C:\\Windows' } };
  for (const run of [
    async () => { throw Object.assign(new Error('secret command line'), { code: 'ETIMEDOUT', stderr: 'secret stderr' }); },
    async () => 'x'.repeat(Diagnostics.MAX_OUTPUT + 1),
    async () => '{bad secret JSON',
    async () => JSON.stringify({ ...payload(), commandLine: 'secret' }),
  ]) {
    const result = await Diagnostics.collect(root, { ...base, run });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('unsupported platform or foreign Windows directory refuses before process query', async () => {
  let calls = 0;
  const run = async () => { calls++; throw new Error('query forbidden'); };
  for (const [platform, SystemRoot] of [['darwin', 'C:\\Windows'], ['win32', undefined], ['win32', 'C:\\foreign'], ['win32', '\\\\server\\share\\Windows']]) {
    const result = await Diagnostics.collect(root, { platform, canonicalInstallDir: root, env: { SystemRoot }, run });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test('Windows system directory lookup accepts casing but refuses duplicate ambiguous environment keys', async () => {
  let calls = 0;
  const run = async () => { calls++; return JSON.stringify(payload()); };
  const upper = await Diagnostics.collect(root, { platform: 'win32', canonicalInstallDir: root, env: { SYSTEMROOT: 'C:\\WINDOWS' }, run });
  assert.equal(upper.ok, true); assert.equal(calls, 1);
  const ambiguous = await Diagnostics.collect(root, { platform: 'win32', canonicalInstallDir: root, env: { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Windows' }, run });
  assert.equal(ambiguous.ok, false); assert.equal(calls, 1);
});

test('actual diagnostic wrapper deadline refuses a stalled injected execFile callback', async () => {
  const module = { exports: {} }, calls = [];
  const source = fs.readFileSync(path.join(__dirname, '../scripts/windows-install-diagnostics.js'), 'utf8');
  const fakeRequire = name => name === 'node:child_process' ? { execFile: (exe, args, options) => { calls.push({ exe, args, options }); } } : require(name);
  vm.runInNewContext(source, { require: fakeRequire, module, process: { platform: 'win32' }, Buffer, setTimeout: (callback, ms) => { assert.equal(ms, 5000); queueMicrotask(callback); }, clearTimeout });
  const result = await module.exports.collect(root, { canonicalInstallDir: root, env: { SystemRoot: 'C:\\Windows' } });
  assert.equal(calls.length, 1); assert.equal(result.ok, false); assert.equal(result.code, 'EDEADLINE');
});
