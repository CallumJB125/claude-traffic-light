// C-P: answering permission prompts from the widget is ON only for a brand-new install. Every reader's own default
// stays false (main.js, mcp-server.js, set-status.js, the adapters); this writes the key once, before anything
// reads the config and before the rename step rewrites the hooks, so an existing install is never flipped.
// A new install is one that has not been onboarded, has not seen the old Help, has no old-product install to bring
// across, and has not chosen claudeAutoConnect yet. Pure decision + one small atomic write. Only that branch also
// records askNotice 'pending': the one-time first-use notice (C-N) is never shown to an existing install.
const fs = require('fs');
const path = require('path');

function decide({ saved, firstRun, renameFound = false, devRun = false } = {}) {
  const cfg = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  if (devRun || typeof cfg.askFromWidget === 'boolean') return null; // dev runs share the machine; a recorded choice stands
  const existing = !firstRun || renameFound || cfg.claudeAutoConnect !== undefined;
  return !existing;
}

/** Records the default in <root>/config.json when there is none. → the value written, or null. */
function migrate({ root, firstRun, renameFound = false, devRun = false, fsImpl = fs } = {}) {
  const file = path.join(root, 'config.json');
  let saved = {};
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch { /* no config yet */ }
  const value = decide({ saved, firstRun, renameFound, devRun });
  if (value === null) return null;
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify({ ...saved, askFromWidget: value, ...(value ? { askNotice: 'pending' } : {}) }, null, 2), { mode: 0o600 });
  fsImpl.renameSync(tmp, file);
  return value;
}

module.exports = { decide, migrate };
