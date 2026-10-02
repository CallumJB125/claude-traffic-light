// What a phone may approve at all. Everything not listed here is desk-only:
//   - Read / Grep / Glob, unless they touch credential paths or secrets files
//   - Edit / Write (MultiEdit, NotebookEdit) inside the session's directory,
//     not credential paths, secrets files or files that later run code
//   - Bash (and other agents' shell tools) only when every simple command
//     starts with an allow-listed, read-only program, nothing is expanded,
//     substituted or redirected (globs only in a last, non-hidden path
//     segment; no brace or ~user expansion), no secrets file is named, and no
//     shell/interpreter/eval appears anywhere
// Commands that run repo-controlled code — package scripts (`npm test`,
// `npm run <script>`), test runners, compilers with plugins, git commit/push
// (hooks) — are desk-only. A repo can opt in to remote test commands
// (trustTestCommands), still without options that name another program;
// commit/push never are.
// Paths are checked as written: this module is pure (it also runs in the
// phone PWA). Where a filesystem exists the caller can pass `realpath` (e.g.
// fs.realpathSync) and paths are also checked after resolving symlinks.
// "Inside the session directory" means nothing when that directory is /, the
// home directory or above it (the hook's cwd can be any of these): edits are
// then desk-only, and so is a Grep over /, home or a folder holding
// credentials. Pass `home` (os.homedir()); without it any directory fewer
// than three levels deep (/, /Users, /Users/x) is treated as home or above.
// Paths are judged raw and after dropping // and . and resolving .., so
// '.git/./hooks' is still '.git/hooks'.
// The deny-list (denylist.js) still runs first, as defence in depth.
import { tokenize, commands, SHELLS, INTERPRETERS, GLOB, TILDE, BRACE } from './shell.js';
import { CREDENTIAL_PATHS, RUNS_CODE_LATER, SHELL_TOOLS, DESK_MESSAGE, evaluateDenyList, cleanPath, pathForms, patchPaths, stringsIn } from './denylist.js';

const READ_TOOLS = /^(Read|Grep|Glob|LS|NotebookRead)$/;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const MAX_COMMAND_CHARS = 2000;

const subcommands = (...subs) => {
  const set = new Set(subs);
  return (args) => (set.has(args[0]) ? null : `only ${subs.join('/')} are allowed remotely`);
};
const noArgs = (re, why) => (args) => (args.some((a) => re.test(a)) ? why : null);
// Options before `--` only: after it they belong to the script.
const noOptions = (re, why) => (args) => {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((a) => re.test(a)) ? why : null;
};
const both = (...checks) => (args) => checks.reduce((why, check) => why ?? check(args), null);

// Files whose contents are secrets, beyond the credential directories.
export const SECRET_FILES = /(^|[/=:])\.env(rc)?(\.[^/]*)?$|(^|\/)(\.git-credentials|\.pgpass|id_(rsa|dsa|ecdsa|ed25519))$|\.(pem|key|p12|pfx|jks|keystore)$/i;

// git: read-only subcommands only, no global options (-c/-C/--git-dir, so no
// core.pager / core.sshCommand / alias overrides), and no option that writes
// files or runs a program (external diff, textconv, pager, upload-pack).
// commit/push/fetch/checkout run hooks → desk-only.
const GIT_READ_SUBS = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse']);
function gitArgs(args) {
  if (!args.length || args[0].startsWith('-')) return 'git options before the subcommand';
  if (!GIT_READ_SUBS.has(args[0])) return `git ${args[0]} is desk-only (it can run hooks or change the repo)`;
  if (args.some((a) => /^--(output|ext-diff|textconv|exec|upload-pack|receive-pack|repo|config-env|template|open-files-in-pager|paginate)(=|$)|^-O/.test(a))) return 'git option that writes files or runs programs';
  return null;
}

export const DEFAULT_BASH_ALLOW = {
  ls: null, cat: null, head: null, tail: null, wc: null, pwd: null, echo: null, grep: null, egrep: null, fgrep: null,
  diff: null, which: null, date: null,
  sort: noArgs(/^-[a-zA-Z]*o|^--(output|compress-program)(=|$)/, 'sort -o writes a file'),
  uniq: (args) => (args.filter((a) => !a.startsWith('-')).length > 1 ? 'uniq writes its second file' : null),
  tree: noArgs(/^-[a-zA-Z]*[oR]|^--(fromfile|output)/, 'tree -o writes a file'),
  file: noArgs(/^-[a-zA-Z]*C|^--compile/, 'file -C writes a file'),
  stat: null, du: null, df: null, jq: null, basename: null, dirname: null, realpath: null,
  rg: noArgs(/^--pre(-glob)?(=|$)/, 'rg --pre runs a program'),
  find: noArgs(/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/, 'find -exec / -delete'),
  git: gitArgs,
  gh: (args) => ({ pr: ['view', 'list', 'status', 'checks', 'diff'], issue: ['view', 'list'], run: ['view', 'list'] }[args[0]]?.includes(args[1]) ? null : 'only read-only gh commands are allowed remotely'),
};

// Runs repo-controlled code (package.json scripts, test/config files,
// compiler plugins). Only for repos that opted in (trustTestCommands).
const PKG_SUBS = ['test', 't', 'run', 'run-script', 'lint', 'build', 'typecheck'];
// Options that point a trusted runner at a program or config outside the repo.
const PKG_PROGRAM_OPTS = noOptions(/^-C$|^--(script-shell|node-options|userconfig|globalconfig|prefix|dir|cwd|shell|preload|require|import)(=|$)/, 'option that runs another program or project');
export const TEST_COMMAND_ALLOW = {
  npm: both(subcommands(...PKG_SUBS), PKG_PROGRAM_OPTS), pnpm: both(subcommands(...PKG_SUBS), PKG_PROGRAM_OPTS),
  yarn: both(subcommands(...PKG_SUBS), PKG_PROGRAM_OPTS), bun: both(subcommands('test', 'run'), PKG_PROGRAM_OPTS),
  tsc: null, jest: null, vitest: null,
  pytest: (args) => (args.some((a, k) => (a === '-p' && !/^no:/.test(args[k + 1] ?? '')) || (/^-p./.test(a) && !/^-pno:/.test(a))) ? 'pytest -p loads a plugin' : null),
  go: both(subcommands('test', 'build', 'vet'), noArgs(/^--?(exec|toolexec|vettool)(=|$)/, 'go option runs a program')),
  cargo: both(subcommands('test', 'build', 'check'), noArgs(/^--config(=|$)|^-Z/, 'cargo option can run a program')),
};

const FORBIDDEN_HAZARDS = ['expansion', 'substitution', 'process-substitution', 'subshell', 'group', 'background', 'escape', 'unterminated-quote', 'bidi', 'invisible'];
// Redirections that only discard output or merge one stream into another.
// Judged per parsed redirect, never by rewriting the text (that could move
// a newline and with it a command boundary).
const harmlessRedirect = (r) => r.op === '>' && (
  (/^(>|>>|&>|&>>|>\|)$/.test(r.raw) && r.target === '/dev/null') || (r.raw === '>&' && /^([0-9]|-|\/dev\/null)$/.test(r.target)));

// Expansions the allow-list can't see through: a glob reaching hidden files or
// another directory level, ~user, brace expansion.
function expansionReason(e) {
  if (e.x & BRACE && /\{[^}]*(,|\.\.)[^}]*\}/.test(e.word)) return 'brace expansion is desk-only';
  if (e.x & TILDE && !/^~(\/|$)/.test(e.word)) return `${e.word.split('/')[0]} expansion is desk-only`;
  if (e.x & GLOB) {
    const segs = e.word.split('/');
    for (let k = 0; k < segs.length; k++) {
      if (!/[*?[]/.test(segs[k])) continue;
      if (/^[.?[]/.test(segs[k]) || segs[k].includes('**')) return 'a glob that can match hidden files is desk-only';
      if (k < segs.length - 1) return 'a glob in a directory name is desk-only';
    }
  }
  return null;
}

// Closed Windows lexical checks tighten automatic approval only; they do
// not grant a root capability or substitute for native owner/DACL inspection.
const driveAbsolute = p => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p);
const windowsSpelling = p => typeof p === 'string' && /^(?:[a-z]:|\\|\/\/)/i.test(p);
const windowsForm = p => p.replace(/\\/g, '/');
function windowsPathReason(paths, cwd, home) {
  if (!driveAbsolute(cwd) && !paths.some(windowsSpelling)) return null;
  if (typeof cwd === 'string' && windowsSpelling(cwd) && !driveAbsolute(cwd)) return 'unsupported Windows session directory';
  for (const original of paths.concat(typeof cwd === 'string' ? [cwd] : [])) {
    const p = windowsForm(original);
    if (p.startsWith('~') || /^\/\//.test(p) || /^\/(?!\/)/.test(p) || (/^[a-z]:/i.test(p) && !driveAbsolute(p))) return 'Windows path namespace needs a person';
    const tail = driveAbsolute(p) ? p.slice(3) : p;
    const ambiguousComponent = tail.split('/').some(part => part === '..' ||
      (/[. ]$/.test(part) && part !== '.') || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
    if (tail.includes(':') || /~[0-9]/.test(tail) || /[\p{Cc}\p{Cf}]/u.test(p) || ambiguousComponent) return 'ambiguous Windows path needs a person';
  }
  // A project-less Windows search can otherwise cover the home or a drive.
  if (driveAbsolute(cwd) && typeof home === 'string') {
    const dir = cleanPath(windowsForm(cwd)).replace(/\/$/, '').toLowerCase();
    const h = cleanPath(windowsForm(home)).replace(/\/$/, '').toLowerCase();
    if (/^[a-z]:$/i.test(dir) || dir === h || h.startsWith(dir + '/')) return 'the Windows session directory is the drive or home directory';
  }
  return null;
}

// `p` after symlinks, when the caller supplied a realpath; null if unknown.
function resolvedPath(p, cwd, realpath) {
  if (typeof realpath !== 'function' || typeof p !== 'string' || !p) return null;
  const windows = driveAbsolute(p) || driveAbsolute(cwd);
  const value = windows ? windowsForm(p) : p;
  const base = typeof cwd === 'string' && (cwd.startsWith('/') || driveAbsolute(cwd)) ? (windows ? windowsForm(cwd) : cwd).replace(/\/+$/, '') : null;
  const abs = value.startsWith('/') || driveAbsolute(value) ? value : base ? `${base}/${value}` : null;
  if (!abs) return null;
  try { const result = realpath(abs); return windows && typeof result === 'string' ? windowsForm(result) : result; } catch (error) {
    // A Windows access/security failure is not evidence of a missing leaf.
    if (windows && error?.code !== 'ENOENT') return null;
  }
  const k = abs.lastIndexOf('/');
  try {
    const parentPath = windows && k === 2 && driveAbsolute(abs) ? abs.slice(0, 3) : abs.slice(0, k) || '/';
    const parent = realpath(parentPath);
    return `${(windows ? windowsForm(parent) : parent).replace(/\/+$/, '')}/${abs.slice(k + 1)}`;
  } catch { return null; }
}

// Is `dir` the root, the home directory or above it? A relative dir can't be placed, so it counts.
function broadDir(dir, homes) {
  if (typeof dir !== 'string') return false;
  if (!dir.startsWith('/')) return true;
  const c = cleanPath(dir);
  if (c === '/') return true;
  for (const h of homes) if (c === h || h.startsWith(c + '/')) return true;
  return homes.length ? false : c.split('/').filter(Boolean).length < 3;
}

function homesOf(home, realpath) {
  if (typeof home !== 'string' || !home.startsWith('/')) return [];
  const homes = [cleanPath(home)];
  const real = resolvedPath(homes[0], null, realpath);
  if (real) homes.push(cleanPath(real));
  return homes;
}

const isSecret = (p) => CREDENTIAL_PATHS.test(p) || SECRET_FILES.test(p);
const secretForms = (p, dir) => pathForms(p, dir).some(isSecret);
const runsCodeForms = (p, dir) => pathForms(p, dir).some((x) => RUNS_CODE_LATER.test(x));
// Folders that hold a credential path one level down (.config/gh, Library/Keychains, .docker/config.json).
const CREDENTIAL_PARENT = /(^|\/)(\.config|Library|\.docker)$/i;

function bashReason(command, allow, cwd, realpath) {
  if (typeof command !== 'string' || !command.trim()) return 'no command';
  if (command.length > MAX_COMMAND_CHARS) return 'command too long to review remotely';
  const { tokens, hazards } = tokenize(command);
  const bad = FORBIDDEN_HAZARDS.find((h) => hazards.has(h));
  if (bad) return `shell ${bad} is desk-only`;
  const cmds = commands(tokens);
  if (!cmds.length) return 'no command';
  for (const c of cmds) {
    if (c.redirects.some((r) => !harmlessRedirect(r))) return 'shell redirect is desk-only';
    if (c.wrapped || c.words[0] !== c.cmd) return `${c.words[0]}: only plain commands, no wrappers or paths`;
    for (const w of c.words) {
      if (SHELLS.has(w) || INTERPRETERS.test(w) || /^(eval|exec|source|xargs)$/.test(w) || w === '-c') return `"${w}" is desk-only`;
    }
    if (!Object.prototype.hasOwnProperty.call(allow, c.cmd)) return `${c.cmd} is not on the remote allow-list`;
    const check = allow[c.cmd];
    const why = typeof check === 'function' ? check(c.args) : null;
    if (why) return why;
    for (const e of c.expanded) { const r = expansionReason(e); if (r) return r; }
    for (const a of c.args) {
      if (SECRET_FILES.test(a) || SECRET_FILES.test(cleanPath(a))) return 'names a secrets file (.env, keys)';
      if (a.startsWith('-') || a.startsWith('~')) continue;
      const real = resolvedPath(a, cwd, realpath);
      if (real && isSecret(real)) return 'a symlink to credentials or secrets';
    }
  }
  return null;
}

const pathOf = (input) => [input?.file_path, input?.notebook_path, input?.path].find((p) => typeof p === 'string');

function inside(dir, p) {
  if (!p.startsWith('/')) return !p.split('/').includes('..');
  if (typeof dir !== 'string' || !dir.startsWith('/')) return false;
  const norm = (x) => x.replace(/\/+$/, '');
  const parts = p.split('/');
  return !parts.includes('..') && (p === norm(dir) || p.startsWith(norm(dir) + '/'));
}

// null = remotely approvable; otherwise why it is desk-only.
export function allowListReason({ toolName, toolInput, cwd }, { bashAllow = DEFAULT_BASH_ALLOW, trustTestCommands = false, realpath = null, home = null } = {}) {
  const name = String(toolName ?? '');
  const input = toolInput ?? {};
  const dir = typeof cwd === 'string' && cwd.startsWith('/') ? cleanPath(cwd) : cwd;
  const homes = homesOf(home, realpath);
  if (READ_TOOLS.test(name)) {
    const windows = driveAbsolute(cwd) || windowsSpelling(cwd) || [input.file_path, input.path, input.notebook_path, input.glob, ...(name === 'Glob' ? [input.pattern] : [])].some(windowsSpelling);
    if (windows && typeof realpath !== 'function') return 'Windows paths need a filesystem check';
    if (windows && !driveAbsolute(cwd)) return 'Windows paths need a drive-qualified session directory';
    const paths = [input.file_path, input.path, input.notebook_path, input.glob, ...(name === 'Glob' ? [input.pattern] : [])].filter(x => typeof x === 'string');
    const windowsReason = windowsPathReason(paths, cwd, home);
    if (windowsReason) return windowsReason;
    // A glob can traverse more entries than one realpath check covers. Keep
    // Windows expansion manual until its native traversal boundary is bound.
    if (windows && name === 'Glob') return 'Windows glob searches need a person';
    const p = [input.file_path, input.path, input.pattern, input.notebook_path, input.glob].filter((x) => typeof x === 'string');
    if (p.some((x) => secretForms(x, dir) || secretForms(x.replace(/[*?]+/g, ''), dir))) return 'reads credentials';
    if (name === 'Grep') {
      const where = typeof input.path === 'string' && input.path ? input.path : '.';
      const abs = where.startsWith('~') ? (homes.length ? cleanPath(homes[0] + where.slice(1)) : null)
        : where.startsWith('/') ? cleanPath(where) : typeof dir === 'string' && dir.startsWith('/') ? cleanPath(`${dir}/${where}`) : null;
      if (!abs) { if (where.startsWith('~') || where.split('/').includes('..')) return 'searches outside the session directory'; }
      else if (broadDir(abs, homes) || CREDENTIAL_PARENT.test(abs)) return 'searches /, home or a folder holding credentials';
    }
    const candidates = [input.file_path, input.path, input.notebook_path].filter(x => typeof x === 'string' && x);
    const checked = candidates.map(x => resolvedPath(x, dir, realpath));
    if (windows && checked.some(x => typeof x !== 'string' || !(driveAbsolute(x) || /^\/\/\?\/[a-z]:\//i.test(x)))) return 'Windows path could not be checked';
    const real = checked.filter(Boolean);
    if (windows && name === 'Grep') {
      const where = typeof input.path === 'string' && input.path ? input.path : '.';
      const resolved = resolvedPath(where, dir, realpath);
      const absolute = driveAbsolute(where) ? windowsForm(where) : driveAbsolute(dir) ? `${windowsForm(dir)}/${windowsForm(where)}` : null;
      const broad = value => {
        if (typeof value !== 'string') return false;
        const cleaned = cleanPath(value.replace(/^\/\/\?\/(?=[a-z]:\/)/i, '')).replace(/\/$/, '').toLowerCase();
        const h = typeof home === 'string' ? cleanPath(windowsForm(home)).replace(/\/$/, '').toLowerCase() : null;
        return /^[a-z]:$/i.test(cleaned) || CREDENTIAL_PARENT.test(cleaned) || (h && (cleaned === h || h.startsWith(cleaned + '/')));
      };
      if (!resolved) return 'Windows search path could not be checked';
      if (broad(absolute) || broad(resolved)) return 'searches a Windows drive, home or a folder holding credentials';
    }
    return real.some(isSecret) ? 'reads credentials through a symlink' : null;
  }
  if (EDIT_TOOLS.test(name)) {
    if (driveAbsolute(cwd) || windowsSpelling(pathOf(input))) return 'Windows writes need a person';
    const p = pathOf(input);
    if (!p) return 'no file path';
    if (secretForms(p, dir) || runsCodeForms(p, dir)) return 'protected path';
    if (!inside(dir, p)) return 'outside the session directory';
    if (broadDir(dir, homes)) return 'the session directory is / or the home directory';
    const realCwd = typeof dir === 'string' && dir.startsWith('/') ? resolvedPath(dir, null, realpath) : null;
    if (realCwd && broadDir(realCwd, homes)) return 'the session directory is / or the home directory (through a symlink)';
    const real = resolvedPath(p, dir, realpath);
    if (real) {
      if (isSecret(real) || RUNS_CODE_LATER.test(real)) return 'protected path (through a symlink)';
      if (realCwd && !inside(cleanPath(realCwd), cleanPath(real))) return 'outside the session directory (through a symlink)';
      if (broadDir(cleanPath(real).replace(/\/[^/]*$/, '') || '/', homes)) return 'writes straight into / or the home directory (through a symlink)';
    }
    return null;
  }
  if (SHELL_TOOLS.test(name)) return bashReason(input.command, trustTestCommands ? { ...bashAllow, ...TEST_COMMAND_ALLOW } : bashAllow, cwd, realpath);
  if (stringsIn(input).flatMap(patchPaths).some((p) => secretForms(p, dir) || runsCodeForms(p, dir))) return 'protected path (named in a patch)';
  return `${name || 'this tool'} is desk-only`;
}

// The full remote check: deny-list first (specific reasons), then the allow-list.
export function remoteVerdict(compiled, { toolName, toolInput, repoLabels = [], cwd = null }, opts = {}) {
  const deny = evaluateDenyList(compiled, { toolName, toolInput, repoLabels, cwd });
  if (deny.blocked) return deny;
  const why = allowListReason({ toolName, toolInput, cwd }, opts);
  return why ? { blocked: true, ruleId: 'not-on-remote-allow-list', reason: why, message: DESK_MESSAGE } : { blocked: false };
}
