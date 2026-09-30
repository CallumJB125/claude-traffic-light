// What a phone may approve at all. Everything not listed here is desk-only:
//   - Read / Grep / Glob, unless they touch credential paths
//   - Edit / Write (MultiEdit, NotebookEdit) inside the session's directory,
//     not credential paths and not files that later run code
//   - Bash (and other agents' shell tools) only when every simple command
//     starts with an allow-listed program, nothing is expanded or redirected,
//     and no shell/interpreter/eval appears anywhere
// The deny-list (denylist.js) still runs first, as defence in depth.
import { tokenize, commands, SHELLS, INTERPRETERS } from './shell.js';
import { CREDENTIAL_PATHS, RUNS_CODE_LATER, SHELL_TOOLS, DESK_MESSAGE, evaluateDenyList } from './denylist.js';

const READ_TOOLS = /^(Read|Grep|Glob|LS|NotebookRead)$/;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const MAX_COMMAND_CHARS = 2000;

const subcommands = (...subs) => {
  const set = new Set(subs);
  return (args) => (set.has(args[0]) ? null : `only ${subs.join('/')} are allowed remotely`);
};
const noArgs = (re, why) => (args) => (args.some((a) => re.test(a)) ? why : null);

// git: no global options (-c/-C/--git-dir), a read-mostly subcommand, and no
// option that writes files or runs programs. Destructive variants (force
// push, reset --hard, branch -D, checkout .) are caught by the deny-list.
const GIT_SUBS = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'fetch', 'push', 'branch', 'switch', 'checkout', 'restore', 'stash', 'rev-parse', 'blame', 'ls-files', 'shortlog', 'describe']);
function gitArgs(args) {
  if (!args.length || args[0].startsWith('-')) return 'git options before the subcommand';
  if (!GIT_SUBS.has(args[0])) return `git ${args[0]} is desk-only`;
  if (args.some((a) => /^--(output|ext-diff|exec|upload-pack|receive-pack|repo|config-env|template)(=|$)/.test(a))) return 'git option that writes files or runs programs';
  return null;
}

const PKG_SUBS = ['test', 't', 'run', 'run-script', 'lint', 'build', 'typecheck', 'ls', 'outdated'];

export const DEFAULT_BASH_ALLOW = {
  ls: null, cat: null, head: null, tail: null, wc: null, pwd: null, echo: null, grep: null, egrep: null, fgrep: null,
  diff: null, sort: null, uniq: null, mkdir: null, touch: null, which: null, date: null, tree: null, file: null,
  stat: null, du: null, df: null, jq: null, basename: null, dirname: null, realpath: null,
  rg: noArgs(/^--pre(-glob)?(=|$)/, 'rg --pre runs a program'),
  find: noArgs(/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/, 'find -exec / -delete'),
  git: gitArgs,
  npm: subcommands(...PKG_SUBS), pnpm: subcommands(...PKG_SUBS), yarn: subcommands(...PKG_SUBS), bun: subcommands('test', 'run'),
  tsc: null, eslint: null, prettier: null, jest: null, vitest: null, pytest: null,
  go: subcommands('test', 'build', 'vet', 'fmt', 'list'),
  cargo: subcommands('test', 'build', 'check', 'clippy', 'fmt'),
  gh: (args) => ({ pr: ['view', 'list', 'status', 'checks', 'diff'], issue: ['view', 'list'], run: ['view', 'list', 'watch'] }[args[0]]?.includes(args[1]) ? null : 'only read-only gh commands are allowed remotely'),
};

const FORBIDDEN_HAZARDS = ['expansion', 'substitution', 'process-substitution', 'redirect', 'subshell', 'group', 'background', 'escape', 'unterminated-quote'];
// Redirections that only discard or merge output are fine.
const HARMLESS_REDIRECTS = /(^|\s)(2>&1|[12]?>\s?\/dev\/null)(?=\s|$)/g;

function bashReason(command, allow) {
  if (typeof command !== 'string' || !command.trim()) return 'no command';
  if (command.length > MAX_COMMAND_CHARS) return 'command too long to review remotely';
  const { tokens, hazards } = tokenize(command.replace(HARMLESS_REDIRECTS, ' '));
  const bad = FORBIDDEN_HAZARDS.find((h) => hazards.has(h));
  if (bad) return `shell ${bad} is desk-only`;
  const cmds = commands(tokens);
  if (!cmds.length) return 'no command';
  for (const c of cmds) {
    if (c.wrapped || c.words[0] !== c.cmd) return `${c.words[0]}: only plain commands, no wrappers or paths`;
    for (const w of c.words) {
      if (SHELLS.has(w) || INTERPRETERS.test(w) || /^(eval|exec|source|xargs)$/.test(w) || w === '-c') return `"${w}" is desk-only`;
    }
    if (!Object.prototype.hasOwnProperty.call(allow, c.cmd)) return `${c.cmd} is not on the remote allow-list`;
    const check = allow[c.cmd];
    const why = typeof check === 'function' ? check(c.args) : null;
    if (why) return why;
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
export function allowListReason({ toolName, toolInput, cwd }, { bashAllow = DEFAULT_BASH_ALLOW } = {}) {
  const name = String(toolName ?? '');
  const input = toolInput ?? {};
  if (READ_TOOLS.test(name)) {
    const p = [input.file_path, input.path, input.pattern, input.notebook_path].filter((x) => typeof x === 'string');
    return p.some((x) => CREDENTIAL_PATHS.test(x)) ? 'reads credentials' : null;
  }
  if (EDIT_TOOLS.test(name)) {
    const p = pathOf(input);
    if (!p) return 'no file path';
    if (CREDENTIAL_PATHS.test(p) || RUNS_CODE_LATER.test(p)) return 'protected path';
    if (!inside(cwd, p)) return 'outside the session directory';
    return null;
  }
  if (SHELL_TOOLS.test(name)) return bashReason(input.command, bashAllow);
  return `${name || 'this tool'} is desk-only`;
}

// The full remote check: deny-list first (specific reasons), then the allow-list.
export function remoteVerdict(compiled, { toolName, toolInput, repoLabels = [], cwd = null }, opts = {}) {
  const deny = evaluateDenyList(compiled, { toolName, toolInput, repoLabels });
  if (deny.blocked) return deny;
  const why = allowListReason({ toolName, toolInput, cwd }, opts);
  return why ? { blocked: true, ruleId: 'not-on-remote-allow-list', reason: why, message: DESK_MESSAGE } : { blocked: false };
}
