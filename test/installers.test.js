// Installers and updates: the electron-builder config, the R2 release plan,
// auto-update wiring, and the smoke test's refusal to run on a real home.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const Brand = require('../brand.js');
const config = require('../electron-builder.config.js');
const pkg = require('../package.json');
const R2 = require('../scripts/release-r2.js');
const AutoUpdate = require('../src/auto-update.js');
const Smoke = require('../src/smoke.js');

test('installer names say the brand; productName and appId wait for Stage 2', () => {
  assert.equal(config.productName, pkg.build.productName);
  assert.equal(config.appId, 'com.callumbaker.claude-buddy');
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

test('R2 staging puts the feed files last and caches only installers', () => {
  const plan = R2.stagePlan('1.2.0', ['latest-mac.yml', 'Plexiform-1.2.0-mac-arm64.dmg', 'latest.yml', 'Plexiform-1.2.0-win-x64.exe', '.DS_Store']);
  assert.deepEqual(plan.map((p) => p.key), ['1.2.0/Plexiform-1.2.0-mac-arm64.dmg', '1.2.0/Plexiform-1.2.0-win-x64.exe', '1.2.0/latest-mac.yml', '1.2.0/latest.yml']);
  assert.equal(R2.cacheControl('latest-linux.yml'), 'no-cache, max-age=0');
  assert.match(R2.cacheControl('Plexiform-1.2.0-linux-x86_64.AppImage'), /immutable/);
  assert.throws(() => R2.stagePlan('../evil', []), /not a version/);
});

test('R2 promote copies installers before the feed, and refuses an unstaged version', () => {
  const keys = ['1.2.0/Plexiform-1.2.0-mac-arm64.zip', '1.2.0/latest-mac.yml', '1.2.0/Plexiform-1.2.0-win-x64.exe', '1.2.0/latest.yml', '1.2.0/nested/x'];
  const plan = R2.promotePlan('1.2.0', keys);
  assert.deepEqual(plan.map((p) => p.to), ['Plexiform-1.2.0-mac-arm64.zip', 'Plexiform-1.2.0-win-x64.exe', 'latest-mac.yml', 'latest.yml']);
  assert.throws(() => R2.promotePlan('1.3.0', keys), /no latest\*\.yml staged/);
});

test('R2 is skipped cleanly when its secrets are not set', () => {
  const cfg = R2.config({});
  assert.deepEqual(cfg.missing, ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_RELEASES_BUCKET']);
  const full = R2.config({ R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b', R2_ACCOUNT_ID: 'acc', R2_RELEASES_BUCKET: 'plexiform-releases' });
  assert.equal(full.endpoint, 'https://acc.r2.cloudflarestorage.com');
  assert.equal(full.env.AWS_DEFAULT_REGION, 'auto');
});

test('auto-update runs only where an unsigned app can update itself', () => {
  assert.equal(AutoUpdate.supported({ platform: 'win32', env: {}, packaged: true }), true);
  assert.equal(AutoUpdate.supported({ platform: 'linux', env: { APPIMAGE: '/x.AppImage' }, packaged: true }), true);
  assert.equal(AutoUpdate.supported({ platform: 'linux', env: {}, packaged: true }), false);
  assert.equal(AutoUpdate.supported({ platform: 'darwin', env: {}, packaged: true }), false);
  assert.equal(AutoUpdate.supported({ platform: 'win32', env: {}, packaged: false }), false);
});

test('auto-update reports through UpdateCheck and never restarts by itself', async () => {
  const au = Object.assign(new EventEmitter(), { checked: 0, installed: 0, checkForUpdates() { this.checked++; return Promise.resolve(); }, quitAndInstall() { this.installed++; } });
  const reports = [];
  let restart = null;
  let external = false;
  const updateCheck = { report: (s) => reports.push(s), onRestart: (fn) => { restart = fn; }, useExternalSource: () => { external = true; } };
  const timers = [];
  const handle = AutoUpdate.start({ app: { isPackaged: true, getVersion: () => '1.0.0' }, updateCheck, updater: au, platform: 'win32', env: {}, setTimer: (fn) => { timers.push(fn); return {}; }, setRepeat: () => ({}) });
  assert.ok(handle && external);
  assert.equal(au.allowDowngrade, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  await timers[0]();
  assert.equal(au.checked, 1);
  au.emit('update-available', { version: '1.1.0' });
  au.emit('download-progress', { percent: 42.4 });
  au.emit('update-downloaded', { version: '1.1.0' });
  assert.deepEqual(reports.map((r) => r.state), ['downloading', 'downloading', 'ready']);
  assert.equal(reports[1].progress, 42);
  assert.equal(au.installed, 0, 'no restart until asked');
  restart();
  assert.equal(au.installed, 1);
  au.emit('error', new Error('boom'));
  assert.equal(reports.at(-1).state, 'error');
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
  assert.ok(fs.statSync(config.deb.fpm[at + 1]).mode & 0o111, 'prerm is executable');
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
