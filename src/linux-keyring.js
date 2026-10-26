'use strict';
// Linux only, before app.ready: on a desktop Chromium doesn't recognise
// (openbox, i3, sway, many XFCE setups with no XDG_CURRENT_DESKTOP), Electron
// picks safeStorage's `basic_text` backend even when a Secret Service keyring
// is running, so Find agents says the keychain isn't available. When one owns
// org.freedesktop.secrets on the session bus, ask for libsecret instead.
//
// Values accepted by --password-store in the pinned Electron 44
// (safeStorage.getSelectedStorageBackend in electron.d.ts): basic,
// gnome-libsecret, kwallet, kwallet5, kwallet6. Desktops it maps by itself
// are left alone, and so is a --password-store the person passed.
const { execFileSync } = require('child_process');

const DBUS_SEND = '/usr/bin/dbus-send';
const TIMEOUT_MS = 1000;
const STORE = 'gnome-libsecret';
// Chromium picks libsecret or kwallet for these by itself (electron.d.ts).
const RECOGNISED = new Set(['x-cinnamon', 'deepin', 'gnome', 'pantheon', 'xfce', 'ukui', 'unity', 'kde']);

function recognisedDesktop(env) {
  const names = String(env.XDG_CURRENT_DESKTOP || '').split(':').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.some((n) => RECOGNISED.has(n));
}

function secretServiceRunning(exec) {
  try {
    const out = exec(DBUS_SEND, ['--session', '--print-reply', `--reply-timeout=${TIMEOUT_MS}`, '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'], { timeout: TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); // privacy-flow: linux-keyring-probe
    return /\bboolean\s+true\b/.test(String(out));
  } catch { return false; }
}

// → the --password-store value to add, or null.
function choose({ platform = process.platform, env = process.env, hasSwitch = () => false, exec = execFileSync } = {}) {
  if (platform !== 'linux' || hasSwitch('password-store') || recognisedDesktop(env)) return null;
  return secretServiceRunning(exec) ? STORE : null;
}

function apply(app, opts = {}) {
  const store = choose({ ...opts, hasSwitch: (name) => app.commandLine.hasSwitch(name) });
  if (store) app.commandLine.appendSwitch('password-store', store);
  return store;
}

module.exports = { choose, apply, DBUS_SEND, TIMEOUT_MS, STORE };
