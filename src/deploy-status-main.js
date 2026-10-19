'use strict';
// Main's side of deploy status (src/deploy-status.js): the poll loop, the
// tokens the user pasted in Preferences (sealed with the OS keychain through
// Electron safeStorage, never written in the clear, never sent to a renderer),
// and the IPC for Home and Preferences. Network: flow deploy-status in PRIVACY.md.
const fs = require('fs');
const path = require('path');
const Deploy = require('./deploy-status.js');

const TOKEN_MAX = 400;
const TICK_MS = 15000;
const HOSTS = { vercel: 'api.vercel.com', netlify: 'api.netlify.com', cloudflare: 'api.cloudflare.com' };

// The sealed settings file: {enabled, tokens: {provider: base64 ciphertext}}.
function createStore({ file, safeStorage }) {
  const read = () => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const write = (v) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const sealable = () => !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  return {
    enabled: () => read().enabled !== false,
    setEnabled(on) { write({ ...read(), enabled: !!on }); return !!on; },
    saved: () => Object.fromEntries(Deploy.PROVIDERS.map((p) => [p, !!(read().tokens || {})[p]])),
    tokens() {
      const out = {};
      if (!sealable()) return out;
      for (const [p, sealed] of Object.entries(read().tokens || {})) {
        if (!Deploy.PROVIDERS.includes(p) || typeof sealed !== 'string') continue;
        try { out[p] = safeStorage.decryptString(Buffer.from(sealed, 'base64')); } catch { /* sealed by another keychain: ignored */ }
      }
      return out;
    },
    save(provider, token) {
      if (!sealable()) return { ok: false, error: 'This computer has no secure storage for the token.' };
      const v = read();
      write({ ...v, tokens: { ...(v.tokens || {}), [provider]: safeStorage.encryptString(token).toString('base64') } });
      return { ok: true };
    },
    remove(provider) {
      const v = read();
      const tokens = { ...(v.tokens || {}) };
      delete tokens[provider];
      write({ ...v, tokens });
      return { ok: true };
    },
  };
}

// fetch: the app's net.fetch. Only the three API hosts are ever asked, with the user's own token.
function httpWith(fetchImpl) {
  return async (url, token) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !Object.values(HOSTS).includes(u.host)) throw new Error('not a deploy host');
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error' }); // privacy-flow: deploy-status
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
}

function install({ ipcMain, file, safeStorage, fetch: fetchImpl, clipboard, shell, sessions, online, allowedHome, allowedSettings, scrub, onFired = () => {}, log = () => {}, setInterval: every = setInterval, paused = false }) {
  const store = createStore({ file, safeStorage });
  const watcher = Deploy.create({ http: httpWith(fetchImpl), tokens: () => store.tokens(), online, scrub, log });
  const tick = async () => {
    try {
      const fired = await watcher.tick({ sessions: sessions(), enabled: store.enabled() });
      if (fired.length) onFired(fired);
    } catch (e) { log(`[deploy] ${e.message}`); }
  };
  if (!paused) {
    const timer = every(tick, TICK_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  ipcMain.handle('home:deploys', (e) => (allowedHome(e) && store.enabled() ? { rows: watcher.status().map(({ cwd, ...row }) => row) } : null));
  ipcMain.handle('home:deploy-act', async (e, action, handle) => {
    if (!allowedHome(e) || typeof handle !== 'string' || handle.length > 200) return { ok: false };
    if (action === 'copy-prompt') {
      const text = watcher.prompt(handle);
      if (!text) return { ok: false, error: 'That deploy is no longer failing.' };
      clipboard.writeText(text);
      return { ok: true, note: 'Copied. Paste it into Claude in that project.' };
    }
    if (action === 'open') {
      const url = watcher.urlFor(handle);
      if (!url) return { ok: false };
      await shell.openExternal(url); // privacy-flow: deploy-status
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle('deploy:settings', (e) => (allowedSettings(e) ? { enabled: store.enabled(), saved: store.saved() } : null));
  ipcMain.handle('deploy:set-enabled', (e, on) => (allowedSettings(e) && typeof on === 'boolean' ? { ok: true, enabled: store.setEnabled(on) } : { ok: false }));
  ipcMain.handle('deploy:token-save', (e, provider, token) => {
    if (!allowedSettings(e) || !Deploy.PROVIDERS.includes(provider)) return { ok: false };
    const t = typeof token === 'string' ? token.trim() : '';
    if (!t || t.length > TOKEN_MAX || /\s/.test(t)) return { ok: false, error: 'Paste the token on its own.' };
    return store.save(provider, t);
  });
  ipcMain.handle('deploy:token-remove', (e, provider) => (allowedSettings(e) && Deploy.PROVIDERS.includes(provider) ? store.remove(provider) : { ok: false }));

  return { tick, active: () => (store.enabled() ? watcher.active() : []), status: () => watcher.status(), watcher, store };
}

module.exports = { install, createStore, httpWith, HOSTS };
