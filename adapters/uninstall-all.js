// Takes every entry Buddy added out of the agents' configs and ~/.claude.json,
// leaving everything else as it was. The Windows uninstaller and the .deb's
// prerm run it (main.js --uninstall-hooks, hooks/uninstall-hooks.js) so no
// agent is left running a hook command whose binary is gone.
//
// Each adapter's own uninstall does the work. A config file that doesn't
// exist, or holds none of Buddy's entries, is not written at all, so an
// agent that was never connected doesn't gain a file.
const fs = require('fs');
const Adapters = require('./index.js');
const Runtime = require('./runtime.js');

// Every hook `command` string anywhere in a JSON config's hooks block.
function commandsIn(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => commandsIn(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'command' && typeof v === 'string') out.push(v);
      else commandsIn(v, out);
    }
  }
  return out;
}

function holdsOurs(adapter, file) {
  if (adapter.id === 'codex') {
    const text = fs.readFileSync(file, 'utf8');
    return adapter.strip(text) !== text;
  }
  return commandsIn(Runtime.readJsonConfig(file).hooks).some((c) => adapter.isOurs(c));
}

// mcp: mcp-install.js, or null where it can't be loaded. → [{ id, file, changed, error? }]
function run({ home, mcp = null }) {
  const results = [];
  for (const adapter of Adapters.list()) {
    const file = adapter.configPath(home);
    try {
      if (!fs.existsSync(file) || !holdsOurs(adapter, file)) { results.push({ id: adapter.id, file, changed: false }); continue; }
      adapter.uninstall({ home });
      results.push({ id: adapter.id, file, changed: true });
    } catch (err) {
      results.push({ id: adapter.id, file, changed: false, error: err.message });
    }
  }
  if (mcp) {
    const file = mcp.configPath(home);
    try {
      const r = fs.existsSync(file) ? mcp.uninstall({ home }) : { changed: false };
      results.push({ id: 'mcp', file, changed: !!r.changed });
    } catch (err) {
      results.push({ id: 'mcp', file, changed: false, error: err.message });
    }
  }
  return results;
}

module.exports = { run, commandsIn, holdsOurs };
