const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../src/linux-keyring.js');

// A fake exec: records each call and answers like dbus-send would. Real dbus is never called.
function fakeExec(reply) {
  const calls = [];
  const exec = (file, args, opts) => { calls.push({ file, args, opts }); if (reply instanceof Error) throw reply; return reply; };
  return { exec, calls };
}
const OWNED = 'method return time=1.0 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2\n   boolean true\n';
const NOT_OWNED = OWNED.replace('true', 'false');

test('A9: an unrecognised Linux desktop with a running Secret Service gets gnome-libsecret', () => {
  const f = fakeExec(OWNED);
  assert.equal(K.choose({ platform: 'linux', env: {}, exec: f.exec }), 'gnome-libsecret');
  assert.equal(f.calls.length, 1);
  const [{ file, args, opts }] = f.calls;
  assert.equal(file, '/usr/bin/dbus-send', 'an absolute dbus-send, never one found on PATH');
  assert.ok(path.isAbsolute(file));
  assert.deepEqual(args.slice(0, 3), ['--session', '--print-reply', '--reply-timeout=1000']);
  assert.ok(args.includes('org.freedesktop.DBus.NameHasOwner') && args.includes('string:org.freedesktop.secrets'));
  assert.equal(opts.timeout, 1000, 'one second at most');
  assert.equal(K.choose({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'openbox' }, exec: f.exec }), 'gnome-libsecret');
});

test('A9: no Secret Service, or dbus-send missing, failing or timing out: nothing is added', () => {
  assert.equal(K.choose({ platform: 'linux', env: {}, exec: fakeExec(NOT_OWNED).exec }), null);
  assert.equal(K.choose({ platform: 'linux', env: {}, exec: fakeExec(Object.assign(new Error('spawnSync /usr/bin/dbus-send ENOENT'), { code: 'ENOENT' })).exec }), null);
  assert.equal(K.choose({ platform: 'linux', env: {}, exec: fakeExec(Object.assign(new Error('spawnSync /usr/bin/dbus-send ETIMEDOUT'), { code: 'ETIMEDOUT' })).exec }), null);
  assert.equal(K.choose({ platform: 'linux', env: {}, exec: fakeExec('').exec }), null);
});

test('A9: desktops Chromium maps itself, a --password-store already given, and other platforms are left alone, without asking dbus', () => {
  for (const env of [{ XDG_CURRENT_DESKTOP: 'GNOME' }, { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, { XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'XFCE' }, { XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, { XDG_CURRENT_DESKTOP: 'Unity' }]) {
    const f = fakeExec(OWNED);
    assert.equal(K.choose({ platform: 'linux', env, exec: f.exec }), null, env.XDG_CURRENT_DESKTOP);
    assert.equal(f.calls.length, 0);
  }
  const given = fakeExec(OWNED);
  assert.equal(K.choose({ platform: 'linux', env: {}, hasSwitch: (n) => n === 'password-store', exec: given.exec }), null);
  assert.equal(given.calls.length, 0);
  for (const platform of ['darwin', 'win32']) {
    const f = fakeExec(OWNED);
    assert.equal(K.choose({ platform, env: {}, exec: f.exec }), null);
    assert.equal(f.calls.length, 0);
  }
});

test('A9: apply appends the switch on the app command line only when chosen, with a value the pinned Electron accepts', () => {
  const switches = [];
  const app = (has) => ({ commandLine: { hasSwitch: (n) => has.includes(n), appendSwitch: (k, v) => switches.push([k, v]) } });
  assert.equal(K.apply(app([]), { platform: 'linux', env: {}, exec: fakeExec(OWNED).exec }), 'gnome-libsecret');
  assert.deepEqual(switches, [['password-store', 'gnome-libsecret']]);
  assert.equal(K.apply(app(['password-store']), { platform: 'linux', env: {}, exec: fakeExec(OWNED).exec }), null);
  assert.equal(switches.length, 1);
  // The value must be one Electron documents for --password-store.
  const dts = fs.readFileSync(require.resolve('electron/electron.d.ts'), 'utf8');
  assert.match(dts, new RegExp(`--password-store="${K.STORE}"`));
});

test('A9: main applies it before app.ready, on Linux only', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = main.indexOf("require('./src/linux-keyring.js').apply(app)");
  assert.ok(at > 0, 'main wires it');
  assert.match(main.slice(main.lastIndexOf('\n', at), at), /process\.platform === 'linux'/);
  assert.ok(at < main.indexOf('app.whenReady('), 'before the first whenReady');
});
