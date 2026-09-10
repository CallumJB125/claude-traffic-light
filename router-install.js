// Switches the router on and off: writes the `claude` shim and a marker-
// guarded PATH line in the user's shell rc, and takes both away again. Like
// hooks/install.js it is safe to run repeatedly and only ever touches its own
// block. Every path is injectable, so tests run against a temp HOME.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BEGIN = '# claude-buddy router >>>';
const END = '# claude-buddy router <<<';
const TEMPLATE = path.join(__dirname, 'bin', 'claude-router.sh');
const FROZEN_NAME = 'router-baseline-frozen.json';

function detectShell(shellPath) {
  const name = path.basename(String(shellPath || ''));
  if (/^zsh/.test(name)) return 'zsh';
  if (/^bash/.test(name)) return 'bash';
  if (/^fish/.test(name)) return 'fish';
  return null;
}

// macOS terminals start login shells, and a login bash reads .bash_profile,
// not .bashrc; Linux terminals start interactive non-login shells.
function rcFile(shell, { home, env = {}, platform = process.platform } = {}) {
  if (shell === 'zsh') return path.join(env.ZDOTDIR || home, '.zshrc');
  if (shell === 'fish') return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'config.fish');
  if (shell === 'bash') {
    if (platform !== 'darwin') return path.join(home, '.bashrc');
    const profile = path.join(home, '.bash_profile');
    const rc = path.join(home, '.bashrc');
    return fs.existsSync(profile) || !fs.existsSync(rc) ? profile : rc;
  }
  return null;
}

function allRcFiles({ home, env = {} }) {
  return [
    path.join(env.ZDOTDIR || home, '.zshrc'), path.join(home, '.zshrc'),
    path.join(home, '.bash_profile'), path.join(home, '.bashrc'),
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'config.fish'),
  ].filter((f, i, a) => a.indexOf(f) === i);
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Last in the file, so a later `export PATH=…/.local/bin:$PATH` (where the
// native claude installer puts it) can't land in front of the shim.
function rcBlock(shell, binDir) {
  const line = shell === 'fish'
    ? `fish_add_path --path --move --prepend ${shQuote(binDir)}`
    : `export PATH=${shQuote(binDir)}":$PATH"`;
  return `${BEGIN}\n${line}\n${END}\n`;
}

function stripBlock(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inside = false;
  for (const l of lines) {
    if (l.trim() === BEGIN) { inside = true; continue; }
    if (inside) { if (l.trim() === END) inside = false; continue; }
    out.push(l);
  }
  return out.join('\n');
}

function addBlock(text, block) {
  const base = stripBlock(text).replace(/\n*$/, '');
  return `${base ? `${base}\n\n` : ''}${block}`;
}

const hasBlock = (text) => String(text || '').split('\n').some((l) => l.trim() === BEGIN);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function paths({ home = os.homedir(), root } = {}) {
  const r = root || path.join(home, '.claude-traffic-light');
  return { home, root: r, binDir: path.join(r, 'bin'), shim: path.join(r, 'bin', 'claude'), routerDir: path.join(r, 'router'), frozen: path.join(r, FROZEN_NAME) };
}

function renderShim({ template = TEMPLATE, routerScript, electron, root, configPath, binDir }) {
  return fs.readFileSync(template, 'utf8')
    .replace('__CTL_ROUTER__', shQuote(routerScript))
    .replace('__CTL_ELECTRON__', shQuote(electron || ''))
    .replace('__CTL_ROOT__', shQuote(root))
    .replace('__CTL_CONFIG__', shQuote(configPath))
    .replace('__CTL_SHIM_DIR__', shQuote(binDir));
}

// opts: { home, root, shellPath, env, platform, routerScript, electron,
// configPath, template, baseline }. `baseline` is frozen once, on the first
// switch-on: it is the pre-routing mix every later saving is measured from.
function install(opts = {}) {
  const p = paths(opts);
  const env = opts.env || {};
  const shell = detectShell(opts.shellPath);
  const rc = shell ? rcFile(shell, { home: p.home, env, platform: opts.platform }) : null;
  fs.mkdirSync(p.binDir, { recursive: true });
  fs.mkdirSync(p.routerDir, { recursive: true });
  const shim = renderShim({ template: opts.template, routerScript: opts.routerScript, electron: opts.electron, root: p.root, configPath: opts.configPath || path.join(p.root, 'config.json'), binDir: p.binDir });
  if (readText(p.shim) !== shim) fs.writeFileSync(p.shim, shim);
  fs.chmodSync(p.shim, 0o755);
  let rcChanged = false;
  if (rc) {
    const before = readText(rc);
    const after = addBlock(before || '', rcBlock(shell, p.binDir));
    if (after !== before) {
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      // writeFileSync follows a symlinked rc (dotfile repos) instead of
      // replacing the link with a plain file.
      fs.writeFileSync(rc, after);
      rcChanged = true;
    }
  }
  freezeBaseline(opts, opts.baseline);
  return { ...status(opts), rcChanged };
}

// Once ever: the first switch-on's mix stays the yardstick. → true if written.
function freezeBaseline(opts, baseline) {
  const p = paths(opts);
  if (!baseline || fs.existsSync(p.frozen)) return false;
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.frozen, JSON.stringify({ frozenAt: new Date(opts.now || Date.now()).toISOString(), ...baseline }, null, 2));
  return true;
}

// Leaves the frozen baseline, decisions and history behind for the stats.
function uninstall(opts = {}) {
  const p = paths(opts);
  fs.rmSync(p.shim, { force: true });
  const changed = [];
  for (const f of allRcFiles({ home: p.home, env: opts.env || {} })) {
    const text = readText(f);
    if (text == null || !hasBlock(text)) continue;
    fs.writeFileSync(f, `${stripBlock(text).replace(/\n*$/, '')}\n`);
    changed.push(f);
  }
  return { ...status(opts), rcChanged: changed };
}

function status(opts = {}) {
  const p = paths(opts);
  const shell = detectShell(opts.shellPath);
  const rc = shell ? rcFile(shell, { home: p.home, env: opts.env || {}, platform: opts.platform }) : null;
  const shimExists = fs.existsSync(p.shim);
  const rcHasBlock = rc ? hasBlock(readText(rc)) : false;
  return { installed: shimExists && rcHasBlock, shell, rcFile: rc, shim: p.shim, binDir: p.binDir, shimExists, rcHasBlock, frozen: fs.existsSync(p.frozen) ? p.frozen : null };
}

function readFrozen(opts = {}) {
  try { return JSON.parse(readText(paths(opts).frozen)); } catch { return null; }
}

module.exports = { BEGIN, END, TEMPLATE, detectShell, rcFile, rcBlock, stripBlock, addBlock, hasBlock, paths, renderShim, install, freezeBaseline, uninstall, status, readFrozen, shQuote };
