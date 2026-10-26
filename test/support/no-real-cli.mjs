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

const CLI_PACKAGE = /^@(anthropic-ai\/claude-code|openai\/codex)(@|\/|$)/;

function deniedTarget(file, env) {
  const f = String(file);
  if (CLI_PACKAGE.test(f)) return true;
  const resolved = resolveFile(f, env);
  if (resolved && fakeRoots().some((r) => under(resolved, r))) return false;
  if (['claude', 'codex'].includes(baseOf(f)) || (resolved && ['claude', 'codex'].includes(baseOf(resolved)))) return true;
  const probe = resolved ?? path.resolve(f);
  return hasSegment(probe) || cliRoots().some((r) => under(probe, r));
}

// Conservative: a false positive in a test is acceptable, a missed real launch is not.
const TOKEN = /(^|[\s/\;&|"'=(`])(claude|codex)(\.exe|\.cmd)?([\s;&|)`"']|$)/i;
function shellDenied(command) {
  const roots = fakeRoots();
  const kept = String(command).split(/\s+/).filter((t) => !(path.isAbsolute(t.replace(/^["']|["']$/g, '')) && roots.some((r) => under(real(t.replace(/^["']|["']$/g, '')), r)))).join(' ');
  return TOKEN.test(kept) || hasSegment(kept) || CLI_PACKAGE.test(kept) || cliRoots().some((r) => slash(kept).includes(r));
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);
// Launchers whose real target is one of their arguments.
const WRAPPERS = new Set(['env', 'npx', 'xargs', 'timeout', 'nice', 'caffeinate', 'arch', 'sudo', 'script', 'stdbuf', 'command', 'nohup', 'time', 'exec']);
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

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
    if (!bad && isNode(file)) {
      // The script is the first non-flag entry; later entries only count when they look like paths.
      let first = true;
      for (let i = 0; i < list.length && !bad; i++) {
        const a = String(list[i]);
        if (NODE_EVAL_FLAGS.has(a)) break;
        if (NODE_VALUE_FLAGS.has(a)) {
          if (list[i + 1] != null && deniedTarget(list[i + 1], env)) { bad = true; shown += ` ${list[i + 1]}`; }
          i += 1;
          continue;
        }
        if (a.startsWith('-')) continue;
        if ((first || /[\\/]/.test(a) || CLI_PACKAGE.test(a)) && deniedTarget(a, env)) { bad = true; shown += ` ${a}`; }
        first = false;
      }
    }
    if (!bad && WRAPPERS.has(baseOf(file))) {
      const strings = list.filter((a) => typeof a === 'string');
      const hit = strings.find((a) => !a.startsWith('-') && deniedTarget(a, env));
      if (hit) { bad = true; shown += ` ${hit}`; } else if (shellDenied(strings.join(' '))) bad = true;
    }
    if (!bad && (SHELLS.has(baseOf(file)) || (options && typeof options === 'object' && options.shell))) {
      const i = list.findIndex((a) => /^(-[a-z]*c|\/c|-command)$/i.test(String(a)));
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

// Grandchildren: a node child only gets the guard if --import reaches it via NODE_OPTIONS.
const GUARD_IMPORT = `--import=${import.meta.url}`;
const withGuard = (v) => (String(v || '').includes(GUARD_IMPORT) ? v : `${v ? `${v} ` : ''}${GUARD_IMPORT}`);
function guardOptions(file, options) {
  if (!options || typeof options !== 'object' || !options.env || typeof options.env !== 'object' || !isNode(file)) return options;
  return { ...options, env: { ...options.env, NODE_OPTIONS: withGuard(options.env.NODE_OPTIONS) } };
}
// Put the (possibly rewritten) options back where the caller had them.
const repack = (a, b, options) => (Array.isArray(a) ? [a, options] : [options, b]);

for (const name of FILE_LAUNCHERS) {
  const orig = cp[name];
  const wrapped = function (file, a, b, ...rest) {
    const [args, options] = argsAndOptions(a, b);
    check(name, file, args, options, false);
    const [x, y] = repack(a, b, guardOptions(file, options));
    return orig.call(this, file, x, y, ...rest);
  };
  if (orig[util.promisify.custom]) {
    wrapped[util.promisify.custom] = (file, a, b, ...rest) => {
      const [args, options] = argsAndOptions(a, b);
      check(name, file, args, options, false);
      const [x, y] = repack(a, b, guardOptions(file, options));
      return orig[util.promisify.custom](file, x, y, ...rest);
    };
  }
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
    const [x, y] = repack(a, b, guardOptions(exec, options));
    return orig.call(this, modulePath, x, y, ...rest);
  };
}

process.env.NODE_OPTIONS = withGuard(process.env.NODE_OPTIONS);
nodeModule.syncBuiltinESMExports();
globalThis.__plexiformNoRealCli = true;
