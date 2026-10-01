// Installers and updates: the electron-builder config, the R2 release plan,
// and the smoke test's refusal to run on a real home (the updater itself:
// test/updater-*.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const Brand = require('../brand.js');
const config = require('../electron-builder.config.js');
const pkg = require('../package.json');
const R2 = require('../scripts/release-r2.js');
const Smoke = require('../src/smoke.js');

test('installer names say the brand, and so do productName and appId', () => {
  assert.equal(config.productName, Brand.name);
  assert.equal(config.appId, Brand.appId);
  assert.match(config.artifactName, new RegExp(`^${Brand.name}-\\$\\{version\\}-\\$\\{os\\}-\\$\\{arch\\}\\.\\$\\{ext\\}$`));
  assert.equal(config.nsis.shortcutName, Brand.name);
  assert.equal(config.nsis.uninstallDisplayName, Brand.name);
  assert.equal(config.linux.desktop.entry.Name, Brand.name);
  assert.match(config.dmg.title, new RegExp(`^${Brand.name} `));
});

test('every platform builds what it can update from, and nothing that cannot', () => {
  assert.deepEqual(config.mac.target.map((t) => t.target), ['dmg', 'zip']);
  assert.deepEqual(config.mac.target[0].arch, ['arm64', 'x64']);
  assert.deepEqual(config.win.target.map((t) => t.target), ['nsis']);
  assert.deepEqual(config.linux.target.map((t) => t.target), ['AppImage', 'deb']);
  assert.equal(config.publish[0].provider, 'generic');
  assert.match(config.publish[0].url, /^https:\/\//);
  // The layered config keeps package.json's file list, so other branches' additions still ship.
  assert.deepEqual(config.files, pkg.build.files);
  assert.equal(config.mac.sign, './build/sign.js');
});

test('R2 staging puts the feed files last; only names with a version are cached', () => {
  const plan = R2.stagePlan('1.2.0', ['latest-mac.yml', 'Plexiform-1.2.0-mac-arm64.dmg', 'latest.yml', 'Plexiform-1.2.0-win-x64.exe', 'SHA256SUMS.txt', '.DS_Store'], '', true);
  assert.deepEqual(plan.map((p) => p.key), ['1.2.0/Plexiform-1.2.0-mac-arm64.dmg', '1.2.0/Plexiform-1.2.0-win-x64.exe', '1.2.0/SHA256SUMS.txt', '1.2.0/latest-mac.yml', '1.2.0/latest.yml']);
  for (const feed of ['latest-linux.yml', 'beta.yml', 'beta-mac.yml', 'release.json', 'release.json.sig', 'SHA256SUMS.txt']) assert.equal(R2.cacheControl(feed), 'no-cache, max-age=0', feed);
  assert.match(R2.cacheControl('Plexiform-1.2.0-linux-x86_64.AppImage'), /immutable/);
  assert.match(R2.cacheControl('Plexiform-1.2.0-win-x64.exe.blockmap'), /immutable/);
  assert.throws(() => R2.stagePlan('../evil', []), /not a version/);
  assert.throws(() => R2.stagePlan('1.2.0', ['release.json', 'latest.yml']), /signed at promote time/);
});

test('R2 beta staging goes under beta/ only', () => {
  const plan = R2.stagePlan('1.0.0-beta.7', ['Plexiform-1.0.0-beta.7-mac-arm64.zip', 'beta-mac.yml'], 'beta/');
  assert.deepEqual(plan.map((p) => p.key), ['beta/1.0.0-beta.7/Plexiform-1.0.0-beta.7-mac-arm64.zip', 'beta/1.0.0-beta.7/beta-mac.yml']);
  assert.ok(plan.every((p) => /^beta\/[^/]+\/[^/]+$/.test(p.key)), 'never the bucket root or beta/ root');
});

test('R2 promote plan: installers, then the feed files (latest*.yml or beta*.yml); never a staged manifest', () => {
  const names = ['release.json.sig', 'release.json', 'Plexiform-1.2.0-mac-arm64.zip', 'latest-mac.yml', 'Plexiform-1.2.0-win-x64.exe', 'latest.yml', 'nested/x'];
  const plan = R2.promotePlan('1.2.0', names, '', true);
  assert.deepEqual(plan.map((p) => p.to), ['Plexiform-1.2.0-mac-arm64.zip', 'Plexiform-1.2.0-win-x64.exe', 'latest-mac.yml', 'latest.yml']);
  assert.throws(() => R2.promotePlan('1.3.0', ['Plexiform-1.3.0-win-x64.exe'], '', true), /no feed file/);
  const beta = R2.promotePlan('1.2.0-beta.3', ['Plexiform-1.2.0-beta.3-win-x64.exe', 'beta.yml'], 'beta/', true);
  assert.deepEqual(beta.map((p) => p.to), ['beta/Plexiform-1.2.0-beta.3-win-x64.exe', 'beta/beta.yml']);
});

// A fake `aws s3` over an in-memory bucket. An empty prefix fails as the real
// CLI does: exit 1, nothing on stdout or stderr.
const awsFail = (status, stderr = '') => Object.assign(new Error(`Command failed: aws (exit ${status})`), { status, stdout: '', stderr });
function fakeAws(bucket) {
  const calls = [];
  const run = (_bin, args) => {
    const [, op, a, b] = args;
    calls.push(args.slice(1));
    const key = (u) => u.replace(/^s3:\/\/[^/]+\//, '');
    if (op === 'ls') {
      const prefix = key(a);
      const names = [...bucket.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
      if (!names.length) throw awsFail(1);
      return names.map((n) => `2026-10-01 00:00:00 1 ${n}`).join('\n');
    }
    if (op === 'cp') {
      if (a.startsWith('s3://') && b.startsWith('s3://')) bucket.set(key(b), bucket.get(key(a)));
      else if (b.startsWith('s3://')) bucket.set(key(b), fs.readFileSync(a));
      else fs.writeFileSync(b, bucket.get(key(a)));
      return '';
    }
    throw new Error(`unexpected aws ${op}`);
  };
  return { run, calls };
}
const R2_ENV = { R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b', R2_ACCOUNT_ID: 'acc', R2_RELEASES_BUCKET: 'bk' };
const R2_WIN = { ...R2_ENV, WINDOWS_RELEASE: 'true' };

// N2 (security re-review): Windows tests only report, so nothing Windows ships
// unless the repo variable WINDOWS_RELEASE is 'true'.
const WIN_NAMES = ['Plexiform-1.2.0-win-x64.exe', 'Plexiform-1.2.0-win-x64.exe.blockmap', 'latest.yml'];
const OTHER_NAMES = ['Plexiform-1.2.0-mac-arm64.zip', 'Plexiform-1.2.0-linux-x86_64.AppImage', 'latest-mac.yml', 'latest-linux.yml', 'SHA256SUMS.txt'];
test('N2: without WINDOWS_RELEASE no Windows file or latest.yml is staged, fetched or promoted; with it they are', () => {
  const names = [...OTHER_NAMES, ...WIN_NAMES];
  const base = (p) => p.map((x) => x.name).sort();
  assert.deepEqual(base(R2.stagePlan('1.2.0', names)), [...OTHER_NAMES].sort());
  assert.deepEqual(base(R2.stagePlan('1.2.0', names, '', true)), [...names].sort());
  assert.deepEqual(base(R2.promotePlan('1.2.0', names)), [...OTHER_NAMES].sort());
  assert.deepEqual(base(R2.promotePlan('1.2.0', names, '', true)), [...names].sort());
  // beta.yml is the Windows beta feed; beta-mac.yml and beta-linux.yml stay
  assert.deepEqual(base(R2.stagePlan('1.2.0-beta.1', ['beta.yml', 'beta-mac.yml', 'beta-linux.yml', 'Plexiform-1.2.0-beta.1-win-x64.exe'], 'beta/')), ['beta-linux.yml', 'beta-mac.yml']);
  // a Windows-only staging has nothing to promote
  assert.throws(() => R2.promotePlan('1.2.0', WIN_NAMES), /no feed file/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-win-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), n);
  const off = fakeAws(new Map());
  R2.main(['stage', '1.2.0', dir], off.run, () => {}, R2_ENV);
  const keys = (b) => [...b.calls].filter((c) => c[0] === 'cp').map((c) => c[2].replace('s3://bk/', ''));
  assert.deepEqual(keys(off).sort(), OTHER_NAMES.map((n) => `1.2.0/${n}`).sort());
  const on = fakeAws(new Map());
  R2.main(['stage', '1.2.0', dir], on.run, () => {}, R2_WIN);
  assert.deepEqual(keys(on).sort(), names.map((n) => `1.2.0/${n}`).sort());

  const bucket = () => new Map(names.map((n) => [`1.2.0/${n}`, n]));
  const signed = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-win-'));
  fs.writeFileSync(path.join(signed, 'release.json'), 'm');
  fs.writeFileSync(path.join(signed, 'release.json.sig'), 's');
  const roots = (b) => [...b.keys()].filter((k) => !k.includes('/')).sort();
  const pOff = bucket();
  R2.main(['promote', '1.2.0', '--manifest-dir', signed], fakeAws(pOff).run, () => {}, R2_ENV);
  assert.deepEqual(roots(pOff), [...OTHER_NAMES, 'release.json', 'release.json.sig'].sort());
  const pOn = bucket();
  R2.main(['promote', '1.2.0', '--manifest-dir', signed], fakeAws(pOn).run, () => {}, R2_WIN);
  assert.deepEqual(roots(pOn), [...names, 'release.json', 'release.json.sig'].sort());

  const fOff = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-win-'));
  R2.main(['fetch-staged', '1.2.0', fOff], fakeAws(bucket()).run, () => {}, R2_ENV);
  assert.deepEqual(fs.readdirSync(fOff).sort(), [...OTHER_NAMES].sort());
  const fOn = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-win-'));
  R2.main(['fetch-staged', '1.2.0', fOn], fakeAws(bucket()).run, () => {}, R2_WIN);
  assert.deepEqual(fs.readdirSync(fOn).sort(), [...names].sort());
  // only the exact string 'true' turns it on
  const Sign = require('../scripts/release-sign.js');
  assert.equal(Sign.windowsEnabled({ WINDOWS_RELEASE: '1' }), false);
  assert.equal(Sign.windowsEnabled({}), false);
});

// H4 (code review): R2 first, the manifest signed at promote time last, to both <version>/ and the root.
test('R2 promote copies the staged files, then uploads the manifest signed now: <version>/ first, the root last', () => {
  const bucket = new Map([['1.1.0/latest.yml', 'y'], ['1.1.0/Plexiform-1.1.0-win-x64.exe', 'e']]);
  const { run, calls } = fakeAws(bucket);
  const signed = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-'));
  fs.writeFileSync(path.join(signed, 'release.json'), 'm');
  fs.writeFileSync(path.join(signed, 'release.json.sig'), 's');
  R2.main(['promote', '1.1.0', '--manifest-dir', signed], run, () => {}, R2_WIN);
  const copies = calls.filter((c) => c[0] === 'cp').map((c) => [c[1].startsWith(signed) ? `signed/${path.basename(c[1])}` : c[1], c[2]]);
  assert.deepEqual(copies, [
    ['s3://bk/1.1.0/Plexiform-1.1.0-win-x64.exe', 's3://bk/Plexiform-1.1.0-win-x64.exe'],
    ['s3://bk/1.1.0/latest.yml', 's3://bk/latest.yml'],
    ['signed/release.json', 's3://bk/1.1.0/release.json'],
    ['signed/release.json.sig', 's3://bk/1.1.0/release.json.sig'],
    ['signed/release.json', 's3://bk/release.json'],
    ['signed/release.json.sig', 's3://bk/release.json.sig'],
  ]);
  // L8: every copy says its content type
  for (const c of calls.filter((x) => x[0] === 'cp')) assert.ok(c.includes('--content-type'), c.join(' '));
  assert.throws(() => R2.main(['promote', '1.1.0'], run, () => {}, R2_WIN), /needs --manifest-dir/);
});

// M7 (code review): re-running a tag must not change a release that is live.
test('R2 stage refuses a version that was already promoted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'));
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'y');
  const { run } = fakeAws(new Map([['1.2.0/release.json', 'm'], ['1.2.0/latest.yml', 'y']]));
  assert.throws(() => R2.main(['stage', '1.2.0', dir], run, () => {}, R2_WIN), /already promoted/);
  const fresh = fakeAws(new Map());
  R2.main(['stage', '1.3.0', dir], fresh.run, () => {}, R2_WIN);
  assert.deepEqual(fresh.calls.filter((x) => x[0] === 'cp').map((x) => x[2]), ['s3://bk/1.3.0/latest.yml']);
});

test('R2: only staging may run without its secrets; promote and the fetches fail hard', () => {
  const cfg = R2.config({});
  assert.deepEqual(cfg.missing, ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_RELEASES_BUCKET']);
  const full = R2.config(R2_ENV);
  assert.equal(full.endpoint, 'https://acc.r2.cloudflarestorage.com');
  assert.equal(full.env.AWS_DEFAULT_REGION, 'auto');
  const logs = [];
  R2.main(['stage', '1.2.0', 'out'], () => assert.fail('no aws call'), (s) => logs.push(s), {});
  assert.match(logs[0], /skipped/);
  for (const argv of [['promote', '1.2.0', '--manifest-dir', 'x'], ['promote-beta', '1.2.0-beta.1', '--manifest-dir', 'x'], ['fetch-live', 'x'], ['fetch-staged', '1.2.0', 'x']]) {
    assert.throws(() => R2.main(argv, () => assert.fail('no aws call'), () => {}, {}), /not set/, argv[0]);
  }
});

test('R2 fetch-live and fetch-staged download what is there, and nothing when nothing is live', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const empty = fakeAws(new Map());
  R2.main(['fetch-live', out], empty.run, () => {}, R2_ENV);
  assert.deepEqual(fs.readdirSync(out), []);
  const { run } = fakeAws(new Map([['beta/release.json', 'm'], ['beta/release.json.sig', 's'], ['beta/1.0.0-beta.2/beta.yml', 'y'], ['beta/1.0.0-beta.2/release.json', 'm']]));
  R2.main(['fetch-live', out, '--beta'], run, () => {}, R2_ENV);
  assert.deepEqual(fs.readdirSync(out).sort(), ['release.json', 'release.json.sig']);
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-'));
  R2.main(['fetch-staged', '1.0.0-beta.2', staged, '--beta'], run, () => {}, R2_WIN);
  assert.deepEqual(fs.readdirSync(staged), ['beta.yml'], 'the staged files, never a manifest');
});

// N4 (security re-review): a failed listing read as "nothing there" could stage over a promoted version.
test('N4: an aws ls failure is an error with its stderr; only a genuinely empty prefix is empty', () => {
  const failing = (err) => () => { throw err; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-ls-'));
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'y');
  const denied = awsFail(255, 'An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied');
  assert.throws(() => R2.main(['stage', '1.2.0', dir], failing(denied), () => {}, R2_ENV), /aws s3 ls s3:\/\/bk\/1\.2\.0\/ failed \(exit 255\): An error occurred \(AccessDenied\)/);
  // exit 1 with something on stderr is a failure too, not an empty prefix
  assert.throws(() => R2.main(['fetch-live', dir], failing(awsFail(1, 'Could not connect to the endpoint URL')), () => {}, R2_ENV), /exit 1\): Could not connect/);
  assert.throws(() => R2.main(['fetch-staged', '1.2.0', dir], failing(Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' })), () => {}, R2_ENV), /failed: spawn aws ENOENT/);
  const signed = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-ls-'));
  for (const n of ['release.json', 'release.json.sig']) fs.writeFileSync(path.join(signed, n), n);
  assert.throws(() => R2.main(['promote', '1.2.0', '--manifest-dir', signed], failing(denied), () => {}, R2_ENV), /AccessDenied/);
  // stage asks for stderr to be piped to it, so it can say what went wrong
  let opts = null;
  const empty = fakeAws(new Map());
  R2.main(['stage', '1.3.0', dir], (bin, args, o) => { if (args[1] === 'ls') opts = o; return empty.run(bin, args, o); }, () => {}, R2_ENV);
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(empty.calls.filter((c) => c[0] === 'cp').map((c) => c[2]), ['s3://bk/1.3.0/latest-mac.yml'], 'an empty prefix stages as before');
});

test('N4: fetch-live --version downloads the release.json that version was promoted with', () => {
  const { run } = fakeAws(new Map([['release.json', 'live'], ['release.json.sig', 'ls'], ['1.2.0/release.json', 'old'], ['1.2.0/release.json.sig', 'os'], ['1.2.0/latest-mac.yml', 'y']]));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'promoted-'));
  R2.main(['fetch-live', out, '--version', '1.2.0'], run, () => {}, R2_ENV);
  assert.equal(fs.readFileSync(path.join(out, 'release.json'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(out, 'release.json.sig'), 'utf8'), 'os');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'promoted-'));
  const logs = [];
  R2.main(['fetch-live', none, '--version', '1.1.0'], run, (m) => logs.push(m), R2_ENV);
  assert.deepEqual(fs.readdirSync(none), []);
  assert.match(logs[0], /no release\.json at 1\.1\.0\//);
  assert.throws(() => R2.main(['fetch-live', none, '--version', '../x'], run, () => {}, R2_ENV), /not a version/);
});

test('the smoke test refuses a real home or data folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-t-'));
  assert.equal(Smoke.unsafeReason({ home: tmp, dataDir: tmp, tmp: os.tmpdir() }), null);
  assert.match(Smoke.unsafeReason({ home: os.homedir(), dataDir: tmp, tmp: os.tmpdir() }), /HOME .* is not a temp folder/);
  assert.match(Smoke.unsafeReason({ home: tmp, dataDir: undefined, tmp: os.tmpdir() }), /not set/);
  assert.equal(Smoke.reportPathFrom(['x', '--smoke-test=/tmp/r.json']), '/tmp/r.json');
  assert.equal(Smoke.reportPathFrom(['x']), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('uninstall: NSIS and the .deb take the hooks out before the binary goes, and not on an update', () => {
  assert.equal(config.nsis.include, 'build/installer.nsh');
  const nsh = fs.readFileSync(path.join(__dirname, '..', config.nsis.include), 'utf8');
  // customUnInstall runs after $INSTDIR is deleted; customRemoveFiles runs before.
  assert.match(nsh, /!macro customRemoveFiles[\s\S]*\$\{ifNot\} \$\{isUpdated\}\s*[\s\S]*--uninstall-hooks[\s\S]*RMDir \/r \$INSTDIR\s*!macroend/);
  assert.ok(!/!macro customUnInstall\b/.test(nsh));
  const at = config.deb.fpm.indexOf('--before-remove');
  assert.ok(at >= 0);
  const prerm = fs.readFileSync(config.deb.fpm[at + 1], 'utf8');
  assert.match(prerm, /^#!\/bin\/sh\n/);
  assert.match(prerm, /remove\|purge\) ;;\n\s*\*\) exit 0 ;;/, 'an upgrade leaves the hooks alone');
  assert.match(prerm, /runuser -u "\$user" -- env HOME="\$home" ELECTRON_RUN_AS_NODE=1 "\$APP" "\$SCRIPT"/);
  assert.match(prerm, new RegExp(`/usr/bin/${config.linux.executableName}\\b`));
  // Windows has no exec bit; the git mode is what the Linux runner builds from
  if (process.platform !== 'win32') assert.ok(fs.statSync(config.deb.fpm[at + 1]).mode & 0o111, 'prerm is executable');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'hooks', 'uninstall-hooks.js')), 'shipped in extraResources hooks/');
});

test('Linux has its own icon set: square PNGs named by size', () => {
  const dir = path.join(__dirname, '..', config.linux.icon);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  for (const s of [16, 32, 48, 64, 128, 256, 512]) assert.ok(files.includes(`${s}x${s}.png`), `${s}x${s}.png`);
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    assert.equal(`${w}x${h}.png`, f, 'the name says the real size');
  }
});

const ROOT = path.join(__dirname, '..');
const readText = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Top-level jobs of a workflow, as { name: text }.
function jobsOf(yml) {
  const body = yml.slice(yml.indexOf('\njobs:\n') + 7);
  const out = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { cur = m[1]; out[cur] = ''; } else if (cur) out[cur] += `${line}\n`;
  }
  return out;
}

// B1 / M1 (reviews): the key must not be reachable from a branch push or a branch-name condition.
test('release.yml: tags and manual runs only, nothing signed, no branch conditions', () => {
  const yml = readText('.github/workflows/release.yml');
  const on = yml.slice(yml.indexOf('\non:\n'), yml.indexOf('\npermissions:'));
  assert.ok(!/branches:/.test(on), 'no branch push trigger');
  assert.ok(!/refs\/heads\//.test(yml), 'no branch-name condition');
  assert.equal((yml.match(/if: github\.event_name == 'workflow_dispatch' && inputs\.beta\n/g) || []).length, 2, 'beta only on a manual run');
  assert.ok(!/SIGNING_KEY/.test(yml), 'a tag build signs nothing');
  assert.match(yml, /\npermissions:\n {2}contents: read\n/);
  const jobs = jobsOf(yml);
  assert.match(jobs.build, /permissions:\n {6}contents: read/);
  for (const j of ['stage', 'stage-beta']) assert.match(jobs[j], /permissions:\n {6}contents: write/, j);
  // the bounded unit tests (a hang on Windows ate the whole job once)
  assert.match(jobs.build, /timeout-minutes: 60/);
  assert.match(jobs.build, /name: Unit tests\n(?:.*\n)*? {8}timeout-minutes: 20\n/);
  assert.match(jobs.build, /node --test --test-force-exit --test-timeout=120000 test\/\*\.test\.js test\/adapters\/\*\.test\.js/);
  assert.match(jobs.build, /node --test --test-force-exit --test-timeout=120000 remote\/test\//);
  assert.ok(!/npm test/.test(jobs.build));
  // macOS-first: Windows unit tests only report; mac and linux block on a tag
  const coe = /name: Unit tests\n(?:.*\n)*? {8}continue-on-error: (.*)\n/.exec(jobs.build)[1];
  assert.equal(coe, "${{ !startsWith(github.ref, 'refs/tags/') || matrix.platform == 'win' }}");
  // on a tag the expression reduces to `matrix.platform == 'win'`: mac and linux have no other way to be non-blocking
  assert.deepEqual([...jobs.build.matchAll(/platform: (\w+)/g)].map((m) => m[1]), ['mac', 'win', 'linux']);
  assert.equal((coe.match(/matrix\.platform == '(\w+)'/g) || []).join(), "matrix.platform == 'win'");
  assert.match(jobs.build, /dist\/\*\.yml/, 'beta*.yml as well as latest*.yml');
  // N2: both stage jobs read the repo variable and drop Windows before the checksums and every upload
  for (const j of ['stage', 'stage-beta']) {
    assert.match(jobs[j], /\n {4}env:\n {6}WINDOWS_RELEASE: \$\{\{ vars\.WINDOWS_RELEASE \}\}\n/, j);
    const prune = jobs[j].indexOf('release-sign.js prune out');
    assert.ok(prune > jobs[j].indexOf('download-artifact'), j);
    for (const later of ['release-sign.js check out', 'sha256sum', 'gh release upload', 'release-r2.js stage']) assert.ok(jobs[j].indexOf(later) > prune, `${j}: ${later}`);
  }
  // stage-beta runs its scripts from this workflow's own commit
  assert.match(jobs['stage-beta'], /ref: \$\{\{ github\.sha \}\}/);
});

test('release-promote.yml: the release environment, both keys only there, signed from the GitHub Release, the feed before GitHub', () => {
  const yml = readText('.github/workflows/release-promote.yml');
  const jobs = jobsOf(yml);
  assert.deepEqual(Object.keys(jobs), ['promote']);
  assert.match(jobs.promote, /\n {4}environment: release\n/);
  assert.match(jobs.promote, /PLEXIFORM_UPDATE_SIGNING_KEY: \$\{\{ secrets\.PLEXIFORM_UPDATE_SIGNING_KEY \}\}/);
  assert.match(jobs.promote, /PLEXIFORM_UPDATE_SIGNING_KEY_BETA: \$\{\{ secrets\.PLEXIFORM_UPDATE_SIGNING_KEY_BETA \}\}/);
  assert.match(yml, /\npermissions:\n {2}contents: read\n/);
  const order = ['gh release view', 'gh release download', 'release-r2.js fetch-live live', 'release-r2.js fetch-live promoted', 'release-sign.js build assets', 'release-sign.js verify-files', 'release-r2.js "$cmd"', 'gh release edit'];
  const at = order.map((s) => jobs.promote.indexOf(s));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'download, live, sign, check R2, promote R2, then publish on GitHub');
  assert.ok(!/resign/.test(jobs.promote), 'never re-signs what R2 serves');
  assert.match(jobs.promote, /extra=\(--rollback --promoted promoted /, 'N4: a rollback is checked against the release.json it was promoted with');
  assert.match(jobs.promote, /\n {6}WINDOWS_RELEASE: \$\{\{ vars\.WINDOWS_RELEASE \}\}\n/, 'N2: sign and promote read the repo variable');
  assert.match(jobs.promote, /if: env\.WINDOWS_RELEASE != 'true'\n[\s\S]*?grep -E -- '-win-\|\^\(latest\|beta\|alpha\)\\\.yml\$'[\s\S]*?exit 1/, 'L2: a draft holding Windows files is refused unless Windows ships');
});

// M4 / #6 (reviews): workflow inputs reach the shell only through env.
test('workflows: inputs never interpolated into a run script; every action pinned to a commit', () => {
  for (const f of ['.github/workflows/release.yml', '.github/workflows/release-promote.yml']) {
    const yml = readText(f);
    for (const line of yml.split('\n')) {
      if (!/\$\{\{[^}]*inputs\./.test(line)) continue;
      assert.match(line, /^\s+(?:[A-Z_]+|ref|if|group):\s|^\s+if:\s|^\s+ref:\s/, `${f}: ${line.trim()}`);
    }
    // every job that names a signing key runs in the release environment
    for (const [name, body] of Object.entries(jobsOf(yml))) {
      if (/SIGNING_KEY/.test(body)) assert.match(body, /\n {4}environment: release\n/, `${f} ${name}`);
    }
    for (const m of yml.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
  }
});

// M9 (code review): the copied NSIS block must stay electron-builder's own.
test('installer.nsh: the copied removal block is exactly electron-builder\'s default for the pinned version', () => {
  const ours = readText('build/installer.nsh');
  const tpl = fs.readFileSync(require.resolve('app-builder-lib/templates/nsis/uninstaller.nsh'), 'utf8');
  const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const def = /!ifmacrodef customRemoveFiles\s*\n\s*!insertmacro customRemoveFiles\s*\n\s*!else\n([\s\S]*?)\n\s*!endif/.exec(tpl);
  assert.ok(def, 'electron-builder still has a default customRemoveFiles block');
  const copy = /; ---- electron-builder's default block from here ----\n([\s\S]*?)!macroend/.exec(ours);
  assert.ok(copy);
  assert.equal(norm(copy[1]), norm(def[1]));
  assert.match(ours, /nsExec::Exec \/TIMEOUT=\d+ '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --uninstall-hooks'/);
  assert.ok(!/ExecWait/.test(ours.replace(/^;.*$/gm, '')), 'no unbounded wait');
});

test('electron-builder is pinned exactly, at 26.15.3 or later, and node_modules has that version', () => {
  const want = pkg.devDependencies['electron-builder'];
  assert.match(want, /^\d+\.\d+\.\d+$/, 'no range');
  const [maj, min, pat] = want.split('.').map(Number);
  assert.ok(maj > 26 || (maj === 26 && (min > 15 || (min === 15 && pat >= 3))), want);
  assert.equal(require('electron-builder/package.json').version, want);
  assert.equal(require('app-builder-lib/package.json').version, want);
});

test('the builder config has no update-feed override: the feed is brand.js', () => {
  assert.equal(config.publish[0].url, Brand.urls.updates);
  assert.ok(!/PLEXIFORM_UPDATE_FEED/.test(readText('electron-builder.config.js')));
  assert.ok(!/PLEXIFORM_UPDATE_FEED/.test(readText('.github/workflows/release.yml')));
});

// M10 (code review): prerm against stub getent, runuser, readlink and timeout.
test('prerm: only login accounts and root with Plexiform data, each run as itself under a time limit; never on upgrade', { skip: process.platform === 'win32' && 'POSIX sh' }, () => {
  const { execFileSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prerm-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  const app = path.join(root, 'opt', 'Plexiform', 'plexiform');
  fs.mkdirSync(path.join(path.dirname(app), 'resources', 'hooks'), { recursive: true });
  fs.writeFileSync(app, '#!/bin/sh\n');
  fs.chmodSync(app, 0o755);
  fs.writeFileSync(path.join(path.dirname(app), 'resources', 'hooks', 'uninstall-hooks.js'), '');
  const home = (n, data = true) => { const h = path.join(root, 'home', n); fs.mkdirSync(data ? path.join(h, '.claude-traffic-light') : h, { recursive: true }); return h; };
  const passwd = [
    `root:x:0:0:root:${home('root')}:/bin/bash`,
    `daemon:x:2:2:daemon:${home('daemon')}:/usr/sbin/nologin`,
    `alice:x:1000:1000:Alice:${home('alice')}:/bin/bash`,
    `bob:x:1001:1001:Bob:${home('bob', false)}:/bin/bash`,
    `nobody:x:65534:65534:nobody:${home('nobody')}:/usr/sbin/nologin`,
    `weird:x:abc:1:w:${home('weird')}:/bin/sh`,
  ].join('\n');
  const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  stub('readlink', `echo "${app}"`);
  stub('runuser', `echo "runuser $*" >> "${log}"`);
  stub('timeout', `echo "timeout $1" >> "${log}"; shift; exec "$@"`);
  for (const tool of ['dirname', 'cat']) fs.symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
  const getent = () => stub('getent', `[ "$1" = passwd ] && cat <<'EOF'\n${passwd}\nEOF`);
  const prerm = config.deb.fpm[config.deb.fpm.indexOf('--before-remove') + 1];
  const run = (arg) => {
    fs.rmSync(log, { force: true });
    execFileSync('/bin/sh', [prerm, arg], { env: { PATH: bin, PLEXIFORM_BIN: path.join(root, 'link') } });
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  getent();
  const calls = run('remove');
  const script = path.join(path.dirname(app), 'resources', 'hooks', 'uninstall-hooks.js');
  assert.deepEqual(calls, [
    'timeout 30', `runuser -u root -- env HOME=${path.join(root, 'home', 'root')} ELECTRON_RUN_AS_NODE=1 ${app} ${script}`,
    'timeout 30', `runuser -u alice -- env HOME=${path.join(root, 'home', 'alice')} ELECTRON_RUN_AS_NODE=1 ${app} ${script}`,
  ]);
  assert.deepEqual(run('upgrade'), [], 'an upgrade keeps the hooks');
  fs.rmSync(path.join(bin, 'timeout'));
  assert.equal(run('purge').filter((l) => l.startsWith('runuser')).length, 2, 'without timeout it still runs');
  fs.rmSync(path.join(bin, 'getent'));
  assert.deepEqual(run('remove'), [], 'no getent: nothing, and no failure');
  getent();
  fs.rmSync(path.join(bin, 'runuser'));
  assert.deepEqual(run('remove'), [], 'no runuser: nothing, and no failure');
});

// L11 (code review): an empty, not-yet-loading window is not "loaded".
test('smoke: window-loaded waits for the widget page itself to finish loading', async () => {
  const { EventEmitter } = require('events');
  const wc = Object.assign(new EventEmitter(), { url: '', loading: false, getURL() { return this.url; }, isLoading() { return this.loading; } });
  let settled = null;
  const p = Smoke.windowLoaded(wc, { timeoutMs: 2000 }).then((v) => { settled = v; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, null, 'blank and idle is not loaded');
  wc.loading = true;
  wc.emit('did-finish-load');
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, null, 'a load event for no page yet');
  wc.url = 'file:///x/app.asar/index.html';
  wc.emit('did-finish-load');
  await p;
  assert.equal(settled, true, 'the page\'s own did-finish-load');
  const idle = Object.assign(new EventEmitter(), { getURL: () => 'file:///x/index.html', isLoading: () => false });
  assert.equal(await Smoke.windowLoaded(idle, { timeoutMs: 500, pollMs: 10 }), true, 'already loaded and idle');
  const other = Object.assign(new EventEmitter(), { getURL: () => 'https://example.com/index.html', isLoading: () => false });
  assert.equal(await Smoke.windowLoaded(other, { timeoutMs: 50 }), false);
});

// electron-builder 26 only runs build/sign.js when it has an identity.
test('mac: ad-hoc identity until a certificate is given, so build/sign.js runs on electron-builder 26', () => {
  const load = (env) => {
    const saved = { CSC_LINK: process.env.CSC_LINK, CSC_NAME: process.env.CSC_NAME };
    for (const k of Object.keys(saved)) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../electron-builder.config.js')];
    try { return require('../electron-builder.config.js').mac.identity; } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      delete require.cache[require.resolve('../electron-builder.config.js')];
    }
  };
  assert.equal(load({}), '-');
  assert.equal(load({ CSC_LINK: 'cert.p12' }), undefined);
});

// GitHub refuses a workflow file that isn't valid YAML, and then shows a failed
// run on every push while no tag or dispatch can start it. The regex checks
// above read the text, so they can't catch that. js-yaml comes with
// electron-builder.
test('every workflow file is valid YAML with jobs and an on: trigger', () => {
  const yaml = require('js-yaml');
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 2, files.join(','));
  for (const f of files) {
    const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(doc && typeof doc === 'object' && doc.jobs && Object.keys(doc.jobs).length, `${f}: no jobs`);
    assert.ok('on' in doc || true in doc, `${f}: no on: trigger`);
  }
});

// Node 22 (the version CI runs) treats a bare directory argument to --test as
// one missing file: the remote suite then "fails" without running a test.
test('release.yml passes test files, never a bare directory, to node --test', () => {
  const yml = readText('.github/workflows/release.yml');
  const runs = yml.split('\n').filter((l) => /node --test\b/.test(l));
  assert.ok(runs.length >= 2, runs.join('\n'));
  for (const l of runs) assert.doesNotMatch(l, /\s[\w./-]+\/(\s|\|\||$)/, `bare directory in: ${l.trim()}`);
  assert.match(yml, /remote\/test\/\*\.test\.js/);
});

// A failing Windows smoke test must not fail the Windows job: stage needs every
// build job, so it would block the macOS release while Windows doesn't ship.
test('release.yml: the Mac/Windows smoke test only reports on Windows; Mac and Linux block', () => {
  const yml = readText('.github/workflows/release.yml');
  const step = yml.slice(yml.indexOf('- name: Smoke test (Mac, Windows)'), yml.indexOf('- uses: actions/upload-artifact'));
  assert.match(step, /continue-on-error: \$\{\{ matrix\.platform == 'win' \}\}/);
  const linux = yml.slice(yml.indexOf('- name: Smoke test (Linux)'), yml.indexOf('- name: Smoke test (Mac, Windows)'));
  assert.doesNotMatch(linux, /continue-on-error/);
});
