#!/usr/bin/env node
// `npm run install-hooks`: registers the Claude Code hooks from a checkout,
// with plain `node` (there is no app binary to run as Node here). The app
// itself installs through adapters/claude-code.js with its own binary. Safe to
// run repeatedly; only ever adds or strips Buddy's own entries.
const os = require('os');
const path = require('path');
const Claude = require('../adapters/claude-code.js');
const Runtime = require('../adapters/runtime.js');

// `--remote <url>`: this machine becomes a reporter for a Buddy elsewhere
// (hooks/remote.js pair; it asks for the pairing code).
const remoteAt = process.argv.indexOf('--remote');
if (require.main === module && remoteAt >= 0) {
  require('./remote.js').cli(['pair', process.argv[remoteAt + 1], ...process.argv.slice(2).filter((a) => a === '--no-hooks' || a === '--force')]).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module) {
  const runtime = Runtime.make({ execPath: null, hooksDir: __dirname, dataDir: path.join(os.homedir(), '.claude-traffic-light') });
  try {
    const r = Claude.install({ home: os.homedir(), runtime });
    console.log('Installed Claude Code hooks into', r.file);
    console.log('Restart any running Claude Code sessions for the hooks to take effect.');
  } catch (err) {
    console.error('Could not update', Claude.configPath(os.homedir()), `- ${err.message}; left it alone.`);
    process.exit(1);
  }
}
