// The environment for running gh, git and ccusage. A GUI app on macOS starts
// with launchd's short PATH, so Homebrew's folders are added there. Linux
// gets /usr/local/bin. Windows is left alone: its PATH is complete, and the
// variable is spelled "Path", so setting "PATH" beside it would give the
// child two values.
const path = require('path');

function toolEnv(extra = {}, env = process.env, platform = process.platform) {
  if (platform === 'darwin') return { ...env, PATH: `${env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`, ...extra };
  if (platform === 'linux') return { ...env, PATH: [env.PATH, '/usr/local/bin'].filter(Boolean).join(path.posix.delimiter), ...extra };
  return { ...env, ...extra };
}

module.exports = { toolEnv };
