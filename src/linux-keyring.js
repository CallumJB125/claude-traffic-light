'use strict';
// Linux only, before app.ready: on a desktop Chromium doesn't recognise
// (openbox, i3, sway, many XFCE setups with no XDG_CURRENT_DESKTOP), Electron
// picks safeStorage's `basic_text` backend even when a Secret Service keyring
// is running, so Find agents says the keychain isn't available. When one owns
// org.freedesktop.secrets on the session bus (or the bus can start one), ask
// for libsecret instead. A yes is remembered in ROOT_DIR/linux-keyring: what
// libsecret sealed can't be opened with basic_text, so a later launch that
// races the keyring daemon must not flip back (libsecret D-Bus-activates the
// daemon itself, and Chromium falls back on its own if there truly is none).
//
// Values accepted by --password-store in the pinned Electron 44
// (safeStorage.getSelectedStorageBackend in electron.d.ts): basic,
// gnome-libsecret, kwallet, kwallet5, kwallet6. Desktops it maps by itself
// are left alone, and so is a --password-store the person passed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DBUS_SEND = '/usr/bin/dbus-send';
const TIMEOUT_MS = 1000;
const STORE = 'gnome-libsecret';
const MARKER = 'linux-keyring';
// Chromium picks libsecret or kwallet for these by itself (electron.d.ts).
const RECOGNISED = new Set(['x-cinnamon', 'deepin', 'gnome', 'pantheon', 'xfce', 'ukui', 'unity', 'kde']);

function recognisedDesktop(env) {
  const names = String(env.XDG_CURRENT_DESKTOP || '').split(':').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.some((n) => RECOGNISED.has(n));
}

// → the reply text, or null when dbus-send is missing, fails or times out.
function ask(exec, method, ...args) {
  try {
    return String(exec(DBUS_SEND, ['--session', '--print-reply', `--reply-timeout=${TIMEOUT_MS}`, '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      `org.freedesktop.DBus.${method}`, ...args], { timeout: TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); // privacy-flow: linux-keyring-probe
  } catch { return null; }
}

// Running now, or activatable on demand. The second question is asked only after a clean "no", so a hung bus costs one timeout.
function secretServiceAvailable(exec) {
  const owner = ask(exec, 'NameHasOwner', 'string:org.freedesktop.secrets');
  if (owner === null) return false;
  if (/\bboolean\s+true\b/.test(owner)) return true;
  const names = ask(exec, 'ListActivatableNames');
  return names !== null && /"org\.freedesktop\.secrets"/.test(names);
}

function markerStore(dir) {
  const file = dir ? path.join(dir, MARKER) : null;
  return {
    has: () => { try { return !!file && fs.readFileSync(file, 'utf8').trim() === STORE; } catch { return false; } },
    set: () => { try { if (file) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, `${STORE}\n`, { mode: 0o600 }); } } catch { /* asked again next launch */ } },
  };
}

// → the --password-store value to add, or null. `dir` holds the marker (ROOT_DIR).
function choose({ platform = process.platform, env = process.env, hasSwitch = () => false, exec = execFileSync, dir = null } = {}) {
  if (platform !== 'linux' || hasSwitch('password-store') || recognisedDesktop(env)) return null;
  const marker = markerStore(dir);
  if (marker.has()) return STORE;
  if (!secretServiceAvailable(exec)) return null;
  marker.set();
  return STORE;
}

function apply(app, opts = {}) {
  const store = choose({ ...opts, hasSwitch: (name) => app.commandLine.hasSwitch(name) });
  if (store) app.commandLine.appendSwitch('password-store', store);
  return store;
}

module.exports = { choose, apply, DBUS_SEND, TIMEOUT_MS, STORE, MARKER };
