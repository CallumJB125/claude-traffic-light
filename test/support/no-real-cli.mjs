// Test guard, loaded with `node --import`. A test must never start the real
// `claude` or `codex`: they would read the developer's real config and spend
// real quota. Every child_process launcher is wrapped; a launch that resolves
// to one of those CLIs throws before anything is spawned. Fakes under the OS
// temp dir, the repo's fixture dirs or PLEXIFORM_TEST_FAKE_BIN_DIRS are allowed.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const nodeModule = require('node:module');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WIN = process.platform === 'win32';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const slash = (p) => p.replace(/\\/g, '/');
const under = (p, root) => { const a = slash(p), b = slash(root).replace(/\/+$/, ''); return a === b || a.startsWith(`${b}/`); };

function fakeRoots() {
  const roots = [os.tmpdir(), ...(IS_WIN ? [] : ['/tmp', '/var/tmp']), path.join(REPO, 'test', 'fixtures'), path.join(REPO, 'board', 'runner', 'test', 'fixtures'), path.join(REPO, 'board', 'tasks-engine', 'test')];
  for (const d of (process.env.PLEXIFORM_TEST_FAKE_BIN_DIRS || '').split(IS_WIN ? ';' : ':')) if (d) roots.push(d);
  return roots.map(real);
}

function cliRoots() {
  const homes = new Set([os.homedir()]);
  if (process.env.HOME) homes.add(process.env.HOME);
  const roots = ['/Applications/Codex.app', '/Applications/ChatGPT.app'];
  for (const h of homes) {
    roots.push(`${h}/.local/share/claude`, `${h}/.claude/local`);
    for (const prefix of [`${h}/.npm-global`, `${h}/.volta/tools/image/packages`]) roots.push(`${prefix}/lib/node_modules/@anthropic-ai/claude-code`, `${prefix}/lib/node_modules/@openai/codex`);
  }
  for (const prefix of ['/opt/homebrew', '/usr/local', '/usr']) roots.push(`${prefix}/lib/node_modules/@anthropic-ai/claude-code`, `${prefix}/lib/node_modules/@openai/codex`);
  if (process.env.APPDATA) roots.push(`${process.env.APPDATA}/npm/node_modules/@anthropic-ai/claude-code`, `${process.env.APPDATA}/npm/node_modules/@openai/codex`);
  return roots;
}

const SEGMENTS = ['/node_modules/@anthropic-ai/claude-code/', '/node_modules/@openai/codex/'];
const hasSegment = (p) => { const s = `${slash(p)}/`; return SEGMENTS.some((x) => s.includes(x)); };
const baseOf = (p) => path.basename(slash(p)).replace(/\.(exe|cmd|ps1|bat)$/i, '').toLowerCase();
const isNode = (file) => { const b = baseOf(file); return b === 'node' || slash(String(file)) === slash(process.execPath); };

// A bare name resolves through the child's PATH, so a fake `claude` first on
// that PATH is a fake.
function resolveFile(file, env) {
  const f = String(file);
  if (f.includes('/') || f.includes('\\')) return real(f);
  const exts = IS_WIN ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const dir of String(env?.PATH ?? env?.Path ?? process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) { const c = path.join(dir, f + ext); try { if (fs.statSync(c).isFile()) return real(c); } catch { /* next */ } }
  }
  return null;
}

function deniedTarget(file, env) {
  const f = String(file);
  const resolved = resolveFile(f, env);
  if (resolved && fakeRoots().some((r) => under(resolved, r))) return false;
  if (['claude', 'codex'].includes(baseOf(f)) || (resolved && ['claude', 'codex'].includes(baseOf(resolved)))) return true;
  const probe = resolved ?? path.resolve(f);
  return hasSegment(probe) || cliRoots().some((r) => under(probe, r));
}

const TOKEN = /(^|[\s/\\;&|"'])(claude|codex)(\.exe|\.cmd)?(\s|$|["'])/i;
function shellDenied(command) {
  const roots = fakeRoots();
  const kept = String(command).split(/\s+/).filter((t) => !(path.isAbsolute(t.replace(/^["']|["']$/g, '')) && roots.some((r) => under(real(t.replace(/^["']|["']$/g, '')), r)))).join(' ');
  return TOKEN.test(kept) || hasSegment(kept) || cliRoots().some((r) => slash(kept).includes(r));
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);

function check(kind, file, args, options, isShellString) {
  const env = options && typeof options === 'object' ? options.env : undefined;
  let bad = false;
  let shown = String(file);
  if (isShellString) {
    bad = shellDenied(file);
    shown = String(file).split(/\s+/)[0];
  } else {
    bad = deniedTarget(file, env);
    const list = Array.isArray(args) ? args : [];
    if (!bad && isNode(file) && list.length) { bad = deniedTarget(list[0], env); if (bad) shown += ` ${list[0]}`; }
    if (!bad && (SHELLS.has(baseOf(file)) || (options && typeof options === 'object' && options.shell))) {
      const i = list.findIndex((a) => /^(-c|\/c|-command)$/i.test(String(a)));
      const cmd = options && options.shell ? [file, ...list].join(' ') : i >= 0 ? list[i + 1] : null;
      if (cmd != null && shellDenied(cmd)) bad = true;
    }
  }
  if (bad) throw new Error(`no-real-cli: test tried to run ${shown} (${kind})`);
}

// (file, args?, options?) launchers and the command-string launchers.
const FILE_LAUNCHERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];
const STRING_LAUNCHERS = ['exec', 'execSync'];

function argsAndOptions(a, b) { return Array.isArray(a) ? [a, b] : [[], a]; }

for (const name of FILE_LAUNCHERS) {
  const orig = cp[name];
  const wrapped = function (file, a, b, ...rest) {
    const [args, options] = argsAndOptions(a, b);
    check(name, file, args, options, false);
    return orig.call(this, file, a, b, ...rest);
  };
  if (orig[util.promisify.custom]) wrapped[util.promisify.custom] = (file, a, b, ...rest) => { const [args, options] = argsAndOptions(a, b); check(name, file, args, options, false); return orig[util.promisify.custom](file, a, b, ...rest); };
  cp[name] = wrapped;
}
for (const name of STRING_LAUNCHERS) {
  const orig = cp[name];
  const wrapped = function (command, ...rest) {
    check(name, command, [], null, true);
    return orig.call(this, command, ...rest);
  };
  if (orig[util.promisify.custom]) wrapped[util.promisify.custom] = (command, ...rest) => { check(name, command, [], null, true); return orig[util.promisify.custom](command, ...rest); };
  cp[name] = wrapped;
}
{
  const orig = cp.fork;
  cp.fork = function (modulePath, a, b, ...rest) {
    const [args, options] = argsAndOptions(a, b);
    const exec = (options && options.execPath) || process.execPath;
    check('fork', exec, [String(modulePath), ...args], options, false);
    return orig.call(this, modulePath, a, b, ...rest);
  };
}

nodeModule.syncBuiltinESMExports();
globalThis.__plexiformNoRealCli = true;
