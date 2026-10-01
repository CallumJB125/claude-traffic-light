const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LoginItem = require('../src/login-item.js');

test('login item: macOS and Windows use Electron’s own setting', () => {
  const calls = [];
  const app = { getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings: (o) => calls.push(o) };
  for (const platform of ['darwin', 'win32']) {
    const li = LoginItem.create({ app, platform });
    assert.equal(li.get(), true);
    li.set(false);
  }
  assert.deepEqual(calls, [{ openAtLogin: false }, { openAtLogin: false }]);
});

test('login item: Linux writes and removes an XDG autostart entry that runs $APPIMAGE', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-login-'));
  const li = LoginItem.create({ app: null, platform: 'linux', env: { APPIMAGE: '/home/u/Apps/Plexiform 1.0.AppImage' }, home, execPath: '/tmp/.mount_x/plexiform' });
  assert.equal(li.file, path.join(home, '.config', 'autostart', 'plexiform.desktop'));
  assert.equal(li.get(), false);
  li.set(true);
  assert.equal(li.get(), true);
  const text = fs.readFileSync(li.file, 'utf8');
  assert.match(text, /^\[Desktop Entry\]\nType=Application\nName=Plexiform\n/);
  assert.match(text, /\nExec="\/home\/u\/Apps\/Plexiform 1\.0\.AppImage"\n/);
  li.set(false);
  assert.equal(li.get(), false);
  const deb = LoginItem.create({ app: null, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') }, home, execPath: '/opt/Claude Buddy/plexiform' });
  deb.set(true);
  assert.match(fs.readFileSync(path.join(home, 'xdg', 'autostart', 'plexiform.desktop'), 'utf8'), /Exec="\/opt\/Claude Buddy\/plexiform"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('login item: Exec quoting escapes what the Desktop Entry spec reserves', () => {
  assert.equal(LoginItem.execQuote('/a "b" $c `d` \\e 100%'), '"/a \\"b\\" \\$c \\`d\\` \\\\e 100%%"');
});

// M5 (code review): an autostart folder it can't write to must not throw into the tray menu or startup.
test('login item (Linux): a failed write or remove returns false and logs, never throws', () => {
  const logs = [];
  const broken = { existsSync: () => false, rmSync: () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); }, mkdirSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, writeFileSync: () => {} };
  const li = LoginItem.create({ app: null, platform: 'linux', env: {}, home: '/home/u', execPath: '/opt/p', fsImpl: broken, log: (m) => logs.push(m) });
  assert.equal(li.set(true), false);
  assert.equal(li.set(false), false);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /could not write .*autostart/);
});
