'use strict';
// Default-profile Hermes observer plugin. Enable through Hermes' supported CLI;
// never edit provider configuration or Hermes capability/trust records ourselves.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Runtime = require('./runtime');
const NAME = 'plexiform-activity';
const MARKER = 'plexiform-hermes-activity-v1';
const MANIFEST = `name: ${NAME}\nversion: 1.1.0\ndescription: Local session activity for Plexiform; no conversation content\nprovides_hooks:\n  - on_session_start\n  - on_stream_start\n  - on_session_end\n  - on_session_finalize\n  - pre_approval_request\n  - post_approval_response\n`;
const PREVIOUS_MANIFESTS = [`name: ${NAME}\nversion: 1.0.0\ndescription: Local session activity for Plexiform; no conversation content\nprovides_hooks:\n  - on_session_start\n  - on_stream_start\n  - on_session_end\n  - on_session_finalize\n`];
const configPath = home => path.join(home, '.hermes', 'plugins', NAME, 'plexiform.json');
const template = () => fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hermes-plugin.py'), 'utf8');
const manifestFor = (text, manifest = MANIFEST) => `${manifest}# plexiform-config-sha256: ${crypto.createHash('sha256').update(text).digest('hex')}\n`;
// Earlier shipped hooks/hermes-plugin.py bodies: still ours, so connecting
// again upgrades them in place instead of refusing a "foreign" plugin.
const PREVIOUS_TEMPLATES = new Set(['d3d84e5f9e481c5d97823abdd7e42b760f4ffa9e905aeb6ca73ab93d5935921d', '10ddfcbfa3edd43d7577ab6a81e3c34ac95b5fd762d08f50e8de4468ca050f5c']);
const ourTemplate = text => text === template() || PREVIOUS_TEMPLATES.has(crypto.createHash('sha256').update(text).digest('hex'));
const isGeneratedCacheFile = name => /^__init__\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(name);
function findBin(home) {
  return [path.join(home, '.local', 'bin', 'hermes'), '/opt/homebrew/bin/hermes', '/usr/local/bin/hermes'].find(p => {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}
function owned(home, current = false) {
  const file = configPath(home), dir = path.dirname(file);
  // Do not follow a plugin-directory or owned-file symlink during replacement/removal.
  for (const p of [path.join(home, '.hermes'), path.dirname(dir), dir, file, path.join(dir, '__init__.py'), path.join(dir, 'plugin.yaml')]) {
    let stat;
    try { stat = fs.lstatSync(p); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('Hermes activity plugin uses a symlink; left unchanged.');
  }
  if (!fs.existsSync(dir)) return false;
  try {
    const text = fs.readFileSync(file, 'utf8'), c = JSON.parse(text);
    const body = fs.readFileSync(path.join(dir, '__init__.py'), 'utf8'), manifest = fs.readFileSync(path.join(dir, 'plugin.yaml'), 'utf8');
    if (current) return c.owner === MARKER && body === template() && manifest === manifestFor(text);
    return c.owner === MARKER && ourTemplate(body) && [MANIFEST, ...PREVIOUS_MANIFESTS].some(m => manifest === manifestFor(text, m));
  } catch { return false; }
}
function install({ home, runtime }) {
  if (runtime.platform === 'win32') throw new Error('Hermes activity connection currently supports macOS and Linux.');
  const file = configPath(home), dir = path.dirname(file);
  const isOwned = owned(home);
  if (fs.existsSync(dir) && !isOwned) throw new Error('An existing Hermes plugin occupies plexiform-activity; left unchanged.');
  // Hermes can activate dependency declarations, skills, MCP or alternate
  // entrypoints from extra files. Never enable an expanded plugin directory.
  if (isOwned) {
    for (const name of fs.readdirSync(dir)) {
      if (['__init__.py', 'plugin.yaml', 'plexiform.json'].includes(name)) continue;
      const cache = path.join(dir, name);
      if (name === '__pycache__' && fs.lstatSync(cache).isDirectory() && !fs.lstatSync(cache).isSymbolicLink()
        && fs.readdirSync(cache).every(n => isGeneratedCacheFile(n) && fs.lstatSync(path.join(cache, n)).isFile() && !fs.lstatSync(path.join(cache, n)).isSymbolicLink())) continue;
      throw new Error('Additional files exist in the Hermes activity plugin; left unchanged and not enabled.');
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const command = [runtime.execPath || process.execPath, path.join(runtime.hooksDir, 'hermes-activity.js')];
  const config = { owner: MARKER, command, dataDir: runtime.dataDir, electron: !!runtime.execPath };
  const configText = JSON.stringify(config);
  Runtime.writeTextAtomic(path.join(dir, '__init__.py'), template(), fs, undefined, { newMode: 0o600 });
  Runtime.writeTextAtomic(path.join(dir, 'plugin.yaml'), manifestFor(configText), fs, undefined, { newMode: 0o600 });
  Runtime.writeTextAtomic(file, configText, fs, undefined, { newMode: 0o600 });
  return { ok: true, file };
}
async function connect({ home, runtime, run = execFile, bin = findBin(home) }) {
  if (!bin) return { ok: false, error: 'Hermes CLI was not found on this computer.' };
  const installed = install({ home, runtime });
  const env = { HOME: home, HERMES_HOME: path.join(home, '.hermes'), PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8' };
  const ok = await new Promise(resolve => {
    const child = run(bin, ['--profile', 'default', 'plugins', 'enable', NAME, '--no-allow-tool-override'], { cwd: path.join(home, '.hermes'), env, timeout: 10000, maxBuffer: 16384, killSignal: 'SIGKILL' }, err => resolve(!err)); // privacy-flow: hermes-activity-enable
    child.stdin?.end();
  });
  return ok ? { ...installed, hermesActivity: true } : { ok: false, file: installed.file, error: 'Activity plugin installed, but Hermes did not confirm enabling it. Check Hermes, then try connecting again.' };
}
function uninstall({ home }) {
  const file = configPath(home), dir = path.dirname(file);
  if (!fs.existsSync(dir)) return { id: 'hermes-activity', file, changed: false };
  if (!owned(home)) throw new Error('Hermes activity plugin was changed; left unchanged.');
  const cache = path.join(dir, '__pycache__');
  if (fs.existsSync(cache) && fs.lstatSync(cache).isDirectory() && !fs.lstatSync(cache).isSymbolicLink()) {
    for (const name of fs.readdirSync(cache)) {
      const p = path.join(cache, name), stat = fs.lstatSync(p);
      if (isGeneratedCacheFile(name) && stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(p);
    }
    try { fs.rmdirSync(cache); } catch {}
  }
  for (const name of ['__init__.py', 'plugin.yaml', 'plexiform.json']) fs.unlinkSync(path.join(dir, name));
  // Preserve any other files; Hermes owns its own enabled list.
  try { fs.rmdirSync(dir); } catch {}
  return { id: 'hermes-activity', file, changed: true };
}
// Health discovery: this build's plugin, unmodified (never throws).
function isInstalled({ home }) { try { return owned(home, true); } catch { return false; } }
// An earlier shipped copy of ours: Reconnect upgrades it.
function holdsOurs({ home }) { try { return owned(home); } catch { return false; } }
module.exports = { NAME, MANIFEST, configPath, findBin, install, connect, uninstall, isInstalled, holdsOurs };
