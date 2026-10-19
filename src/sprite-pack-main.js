// IPC for user sprite packs (src/sprite-pack.js). The widget, the Lights
// editor and Settings may list packs and pick one; config.spritePack holds the
// chosen pack's folder name, or null for the built-in character. Frames reach
// the renderer only as data: URLs built from the validated list.
//   widget:sprite-packs      → { packs, errors, active, current }
//   widget:use-sprite-pack   (name|null) → { ok, active, reason? }
const path = require('path');
const SpritePack = require('./sprite-pack.js');

function register({ ipcMain, allowed, home, root, loadConfig, saveConfig, notify = () => {}, fs }) {
  const store = SpritePack.create({ root: root || path.join(home, '.plexiform', 'sprites'), ...(fs ? { fs } : {}) });
  const activeName = () => {
    const v = (loadConfig() || {}).spritePack;
    return typeof v === 'string' && v ? v : null;
  };

  function packs() {
    const { packs: list, errors } = store.list();
    const active = activeName();
    let current = null;
    if (active) {
      const f = store.frames(active);
      if (f && !f.error) current = { name: f.name, fps: f.fps, frames: f.frames };
      else errors.push({ pack: active, reason: (f && f.error) || 'not found' });
    }
    return { packs: list, errors, active, current };
  }

  function use(name) {
    if (name == null || name === '') {
      saveConfig({ spritePack: null });
      notify();
      return { ok: true, active: null };
    }
    if (typeof name !== 'string') return { ok: false, active: activeName(), reason: 'not a pack name' };
    const f = store.frames(name);
    if (!f || f.error) return { ok: false, active: activeName(), reason: (f && f.error) || 'not found' };
    saveConfig({ spritePack: name });
    notify();
    return { ok: true, active: name };
  }

  ipcMain.handle('widget:sprite-packs', (e) => (allowed(e) ? packs() : null));
  ipcMain.handle('widget:use-sprite-pack', (e, name) => (allowed(e) ? use(name) : null));
  return { packs, use, store };
}

module.exports = { register };
