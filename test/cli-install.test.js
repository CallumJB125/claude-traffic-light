const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CliInstall = require('../src/cli-install.js');

const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-cli-install-'));
  temps.push(dir);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const app = path.join(dir, 'Plexiform.app', 'Contents', 'Resources');
  fs.mkdirSync(path.join(app, 'bin'), { recursive: true });
  const target = path.join(app, 'bin', 'plexiform');
  fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
  return { dir, home, target, link: path.join(home, '.local', 'bin', 'plexiform') };
}

test('target: Resources/bin when packaged, the checkout\'s bin otherwise', () => {
  assert.equal(CliInstall.target({ packaged: true, resourcesPath: '/A/Resources', appDir: '/A/Resources/app.asar' }), path.join('/A/Resources', 'bin', 'plexiform'));
  assert.equal(CliInstall.target({ packaged: false, resourcesPath: '/x', appDir: '/src/plexiform' }), path.join('/src/plexiform', 'bin', 'plexiform'));
});

test('nothing happens without confirmation, and the dialog names both exact paths', async () => {
  const { home, target, link } = fakeHome();
  let asked = null;
  const r = await CliInstall.installWithConsent({ home, target, confirm: async (opts) => { asked = opts; return false; } });
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.equal(fs.existsSync(path.join(home, '.local')), false);
  assert.equal(asked.defaultId, 0);
  assert.equal(asked.cancelId, 0);
  assert.equal(asked.buttons[asked.cancelId], 'Cancel');
  assert.ok(asked.detail.includes(link));
  assert.ok(asked.detail.includes(target));
});

test('confirmed: creates ~/.local/bin and the symlink; a second click is a no-op', async () => {
  const { home, target, link } = fakeHome();
  const r = await CliInstall.installWithConsent({ home, target, confirm: async () => true });
  assert.deepEqual(r, { ok: true, link, target });
  assert.equal(fs.readlinkSync(link), target);
  assert.equal(CliInstall.status({ home, target }).installed, true);
  let asked = false;
  const again = await CliInstall.installWithConsent({ home, target, confirm: async () => { asked = true; return true; } });
  assert.equal(again.already, true);
  assert.equal(asked, false);
});

test('an old Plexiform link is replaced after confirmation, which says so', async () => {
  const { home, target, link } = fakeHome();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync('/Old/Plexiform.app/Contents/Resources/bin/plexiform', link);
  let detail = '';
  const r = await CliInstall.installWithConsent({ home, target, confirm: async (o) => { detail = o.detail; return true; } });
  assert.equal(r.ok, true);
  assert.match(detail, /replaces the existing link to \/Old\/Plexiform\.app/);
  assert.equal(fs.readlinkSync(link), target);
  assert.deepEqual(fs.readdirSync(path.dirname(link)), ['plexiform']);
});

test('something else at ~/.local/bin/plexiform is never replaced, and no dialog is shown', async () => {
  const { home, target, link } = fakeHome();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(link, 'mine');
  let asked = false;
  const r = await CliInstall.installWithConsent({ home, target, confirm: async () => { asked = true; return true; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Something else is already at/);
  assert.equal(asked, false);
  assert.equal(fs.readFileSync(link, 'utf8'), 'mine');
  fs.rmSync(link);
  fs.symlinkSync('/usr/local/bin/other-tool', link);
  assert.equal(CliInstall.status({ home, target }).blocked, true);
  assert.equal((await CliInstall.installWithConsent({ home, target, confirm: async () => true })).ok, false);
  assert.equal(fs.readlinkSync(link), '/usr/local/bin/other-tool');
});

test('a missing launcher is reported, not linked', async () => {
  const { home, dir } = fakeHome();
  const r = await CliInstall.installWithConsent({ home, target: path.join(dir, 'nope', 'bin', 'plexiform'), confirm: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.error, /no command line tool/);
  assert.equal(fs.existsSync(path.join(home, '.local')), false);
});

test('register: both channels go through the sender check; install only via the dialog', async () => {
  const { home, dir } = fakeHome();
  const handlers = {};
  const utilityHandle = (ch, allowed, fn) => { handlers[ch] = (e) => (allowed(e) ? fn(e) : null); };
  const appDir = path.join(dir, 'Plexiform.app', 'Contents', 'Resources');
  let shown = 0;
  const dialog = { showMessageBox: async () => { shown += 1; return { response: 1 }; } };
  CliInstall.register({ utilityHandle, allowed: (e) => e.ok, dialog, BrowserWindow: { fromWebContents: () => null }, home, packaged: true, resourcesPath: appDir, appDir });
  assert.deepEqual(Object.keys(handlers).sort(), ['cli-install', 'cli-install-status']);
  assert.equal(await handlers['cli-install']({ ok: false }), null);
  assert.equal(shown, 0);
  assert.equal(fs.existsSync(path.join(home, '.local')), false);
  const s = await handlers['cli-install-status']({ ok: true });
  assert.equal(s.installed, false);
  const r = await handlers['cli-install']({ ok: true, sender: {} });
  assert.equal(r.ok, true);
  assert.equal(shown, 1);
});

test('main.js and the Settings page wire the button, and nothing installs it at start-up', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/src\/cli-install\.js'\)\.register\(\{ utilityHandle, allowed: settingsOnly,/);
  assert.doesNotMatch(main, /CliInstall\.install\(|cli-install\.js'\)\.install/);
  assert.match(fs.readFileSync(path.join(root, 'settings.html'), 'utf8'), /id="cli-install">Install command line tool</);
  assert.match(fs.readFileSync(path.join(root, 'settings-preload.js'), 'utf8'), /cliInstall: \(\) => ipcRenderer\.invoke\('cli-install'\)/);
  assert.match(fs.readFileSync(path.join(root, 'settings.js'), 'utf8'), /getElementById\('cli-install'\)\.addEventListener\('click'/);
});
