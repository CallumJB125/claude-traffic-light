// C-P: answering permission prompts from the widget is ON only for a brand-new install. Every reader's own default
// stays false (main.js, mcp-server.js, set-status.js, the adapters); this writes the key once, before anything
// reads the config and before the rename step rewrites the hooks, so an existing install is never flipped.
// A new install is one that has not been onboarded, has not seen the old Help, has no old-product install to bring
// across, and has not chosen claudeAutoConnect yet. Pure decision + one small atomic write. Only that branch also
// records askNotice 'pending': the one-time first-use notice (C-N) is never shown to an existing install.
const fs = require('fs');
const path = require('path');
const Claude = require('../adapters/claude-code.js');

function decide({ saved, configExisted = false, hooksPresent = false, firstRun, renameFound = false, devRun = false } = {}) {
  const cfg = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  if (devRun || typeof cfg.askFromWidget === 'boolean') return null; // dev runs share the machine; a recorded choice stands
  // Any config.json at all, our hooks already in Claude's settings, a rename, or markers: not a first install.
  const existing = configExisted || hooksPresent || !firstRun || renameFound || cfg.claudeAutoConnect !== undefined;
  return !existing;
}

// Read-only: is one of Plexiform's hook commands (this app's or an older copy's) already in Claude Code's settings?
function claudeHooksPresent(home, fsImpl = fs) {
  if (!home) return false;
  try {
    const settings = JSON.parse(fsImpl.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    return Object.values((settings && settings.hooks) || {}).some((groups) => Array.isArray(groups)
      && groups.some((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => typeof (h && h.command) === 'string' && Claude.isOurs(h.command))));
  } catch { return false; }
}

/** Records the default in <root>/config.json when there is none. → the value written, or null. */
function migrate({ root, home = null, firstRun, renameFound = false, devRun = false, fsImpl = fs } = {}) {
  const file = path.join(root, 'config.json');
  let saved = {};
  let configExisted = false;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    configExisted = true;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch (err) { configExisted = !!err && err.code !== 'ENOENT'; } // unreadable or corrupt is still a config that was there
  const value = decide({ saved, configExisted, hooksPresent: claudeHooksPresent(home, fsImpl), firstRun, renameFound, devRun });
  if (value === null) return null;
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify({ ...saved, askFromWidget: value, ...(value ? { askNotice: 'pending' } : {}) }, null, 2), { mode: 0o600 });
  fsImpl.renameSync(tmp, file);
  return value;
}

module.exports = { decide, migrate, claudeHooksPresent };
