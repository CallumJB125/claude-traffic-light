const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'crash-reports.js');
const CrashReports = require(SRC);

const HOME = '/Users/jdoe';
const scrubWith = () => ({ home: HOME, user: 'jdoe', hostname: 'jdoes-macbook.local', names: ['acme/secret-launch'] });
const APP = { version: '1.2.3', os: 'darwin', osVersion: 'macOS 15.1', arch: 'arm64' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crash-reports-'));
const make = (opts = {}) => CrashReports.create({ dir: path.join(tmp(), 'crash-reports'), app: APP, scrubWith, ...opts });

function realisticError() {
  const e = new Error(`ENOENT: no such file or directory, open '${HOME}/work/secret-launch/plan.md' token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 for jane@acme.io`);
  e.stack = [
    `Error: ${e.message}`,
    `    at Object.openSync (node:fs:573:3)`,
    `    at readPlan (${HOME}/work/secret-launch/src/plan-loader.js:12:5)`,
    `    at main (/Applications/Plexiform.app/Contents/Resources/app.asar/main.js:4410:9)`,
    `    at C:\\Users\\jdoe\\AppData\\Roaming\\acme\\thing.js:3:1`,
    `    at async Promise.all (index 0)`,
  ].join('\n');
  return e;
}

test('a realistic crash is scrubbed: no home path, username, token, email, project name or message body beyond the first line', () => {
  const c = make();
  const e = realisticError();
  e.message += '\nSECOND LINE: the full prompt text the user typed';
  const r = c.record('uncaughtException', e);
  const text = fs.readFileSync(c.ringFile, 'utf8') + c.payload() + c.bundle();
  for (const bad of ['/Users/jdoe', 'jdoe', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'jane@acme.io', 'secret-launch', 'plan-loader', 'acme', 'full prompt', 'SECOND LINE']) {
    assert.ok(!text.includes(bad), `leaked ${bad}`);
  }
  assert.equal(r.kind, 'uncaughtException');
  assert.equal(r.error.name, 'Error');
  assert.match(r.error.message, /^ENOENT: no such file or directory/);
  assert.ok(r.error.stack.some((l) => /main\.js:4410:9/.test(l)), 'own file names stay readable');
  assert.ok(r.error.stack.every((l) => l.startsWith('at ')));
  assert.deepEqual(Object.keys(r).sort(), ['app', 'at', 'error', 'id', 'kind']);
  assert.deepEqual(r.app, APP);
});

test('unhandled rejections of non-errors and JSON parse errors keep no input', () => {
  const c = make();
  assert.match(c.record('unhandledRejection', { prompt: 'secret prompt' }).error.message, /^thrown object$/);
  let parseErr;
  try { JSON.parse('{"prompt": "my private prompt"'); } catch (err) { parseErr = err; }
  const r = c.record('unhandledRejection', parseErr);
  assert.doesNotMatch(JSON.stringify(r), /private prompt/);
  assert.match(c.record('unhandledRejection', 'x'.repeat(5000)).error.message, /^x{300}…$/);
});

test('a renderer crash keeps only an allow-listed reason and the exit code', () => {
  const c = make();
  const r = c.record('renderer-gone', { reason: 'crashed', exitCode: 11, url: `file://${HOME}/x.html`, title: 'jdoe secrets' });
  assert.deepEqual(r.renderer, { reason: 'crashed', exitCode: 11 });
  assert.equal(c.record('renderer-gone', { reason: '<script>' }).renderer.reason, 'unknown');
  assert.doesNotMatch(c.payload(), /jdoe|x\.html/);
  assert.equal(c.record('nonsense', new Error('x')), null);
});

test('the ring keeps the newest reports within its count and byte caps, at mode 0600', () => {
  const c = make({ send: () => {} });
  const ids = [];
  for (let i = 0; i < CrashReports.MAX_REPORTS + 5; i++) ids.push(c.record('uncaughtException', new Error(`boom ${i}`)).id);
  const kept = c.list();
  assert.equal(kept.length, CrashReports.MAX_REPORTS);
  assert.deepEqual(kept.map((r) => r.id), ids.slice(-CrashReports.MAX_REPORTS));
  assert.ok(fs.statSync(c.ringFile).size <= CrashReports.MAX_RING_BYTES);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(c.ringFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(c.ringFile)).mode & 0o777, 0o700);
  }
  const big = make();
  const fat = new Error('fat');
  fat.stack = `Error: fat\n${Array.from({ length: 40 }, (_, i) => `    at f${i} (main.js:${i}:1) ${'y'.repeat(380)}`).join('\n')}`;
  for (let i = 0; i < CrashReports.MAX_REPORTS; i++) big.record('uncaughtException', fat);
  assert.ok(fs.statSync(big.ringFile).size <= CrashReports.MAX_RING_BYTES, 'byte cap holds');
  assert.ok(big.list().length < CrashReports.MAX_REPORTS);
});

test('one run writes at most MAX_PER_RUN reports, so a crash loop cannot hammer the disk', () => {
  const c = make();
  let n = 0;
  for (let i = 0; i < CrashReports.MAX_PER_RUN + 10; i++) if (c.record('uncaughtException', new Error('loop'))) n++;
  assert.equal(n, CrashReports.MAX_PER_RUN);
});

test('opt-in defaults OFF, and the send hook runs only once opted in', () => {
  const sent = [];
  const c = make({ send: (r) => sent.push(r) });
  assert.equal(c.isOptedIn(), false);
  c.record('uncaughtException', new Error('a'));
  assert.equal(sent.length, 0);
  assert.equal(c.setOptIn(true), true);
  c.record('uncaughtException', new Error('b'));
  assert.equal(sent.length, 1);
  assert.equal(c.setOptIn(false), false);
  fs.writeFileSync(path.join(path.dirname(c.ringFile), 'consent.json'), '{"optedIn":"yes"}');
  assert.equal(c.isOptedIn(), false);
});

test('the send function is a stub that sends nothing', () => {
  const r = CrashReports.sendCrashReport({ kind: 'uncaughtException' });
  assert.equal(r.sent, false);
  assert.match(r.reason, /only saved on this Mac/);
});

test('reading the ring keeps only allow-listed fields, so a hand-edited file cannot add more', () => {
  const c = make();
  c.record('uncaughtException', new Error('x'));
  fs.appendFileSync(c.ringFile, `${JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', kind: 'uncaughtException', at: 'x', env: { HOME }, error: { name: 'E', message: 'm', stack: ['at a'], prompt: 'p' } })}\nnot json\n${JSON.stringify({ kind: 'uncaughtException', error: {} })}\n`);
  const last = c.latest();
  assert.equal(c.list().length, 2);
  assert.equal(last.env, undefined);
  assert.equal(last.error.prompt, undefined);
  assert.equal(c.payload(), JSON.stringify(last, null, 2));
  const b = JSON.parse(c.bundle());
  assert.deepEqual(Object.keys(b).sort(), ['app', 'exportedAt', 'reports']);
  assert.equal(b.reports.length, 2);
});

test('nothing leaves the process: the file loads no network module and calls no fetch', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|undici|ws|electron|child_process)['"]/);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|crashReporter|net\.request/);
  const loaded = [];
  const orig = Module._load;
  Module._load = function (request, ...rest) { loaded.push(request); return orig.call(this, request, ...rest); };
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('fetch called'); };
  try {
    for (const k of Object.keys(require.cache)) if (/[\\/](?:src[\\/](?:crash-reports|scrub|secret-patterns)|brand)\.js$/.test(k)) delete require.cache[k];
    const fresh = require(SRC);
    const c = fresh.create({ dir: path.join(tmp(), 'cr'), app: APP, scrubWith });
    c.setOptIn(true);
    c.record('uncaughtException', realisticError());
    c.record('renderer-gone', { reason: 'oom', exitCode: 1 });
    c.bundle();
  } finally {
    Module._load = orig;
    globalThis.fetch = origFetch;
  }
  const NET = /^(?:node:)?(?:https?|http2|net|tls|dgram|dns|undici|ws|electron|child_process)$/;
  assert.deepEqual(loaded.filter((m) => NET.test(m)), []);
  assert.deepEqual([...new Set(loaded)].sort(), ['../brand.js', './scrub.js', './secret-patterns.js', 'crypto', 'fs', 'path', SRC].sort());
});
