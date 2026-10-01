// What a phone may approve at all. Everything not listed here is desk-only:
//   - Read / Grep / Glob, unless they touch credential paths
//   - Edit / Write (MultiEdit, NotebookEdit) inside the session's directory,
//     not credential paths and not files that later run code
//   - Bash (and other agents' shell tools) only when every simple command
//     starts with an allow-listed, read-only program, nothing is expanded or
//     redirected, and no shell/interpreter/eval appears anywhere
// Commands that run repo-controlled code — package scripts, test runners,
// compilers with plugins, git commit/push (hooks) — are desk-only. A repo can
// opt in to remote test commands (trustTestCommands); commit/push never are.
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
  diff: null, sort: null, uniq: null, which: null, date: null, tree: null, file: null,
  stat: null, du: null, df: null, jq: null, basename: null, dirname: null, realpath: null,
  rg: noArgs(/^--pre(-glob)?(=|$)/, 'rg --pre runs a program'),
  find: noArgs(/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/, 'find -exec / -delete'),
  git: gitArgs,
  gh: (args) => ({ pr: ['view', 'list', 'status', 'checks', 'diff'], issue: ['view', 'list'], run: ['view', 'list'] }[args[0]]?.includes(args[1]) ? null : 'only read-only gh commands are allowed remotely'),
};

// Runs repo-controlled code (package.json scripts, test/config files,
// compiler plugins). Only for repos that opted in (trustTestCommands).
const PKG_SUBS = ['test', 't', 'run', 'run-script', 'lint', 'build', 'typecheck'];
export const TEST_COMMAND_ALLOW = {
  npm: subcommands(...PKG_SUBS), pnpm: subcommands(...PKG_SUBS), yarn: subcommands(...PKG_SUBS), bun: subcommands('test', 'run'),
  tsc: null, jest: null, vitest: null, pytest: null,
  go: subcommands('test', 'build', 'vet'),
  cargo: subcommands('test', 'build', 'check'),
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
export function allowListReason({ toolName, toolInput, cwd }, { bashAllow = DEFAULT_BASH_ALLOW, trustTestCommands = false } = {}) {
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
  if (SHELL_TOOLS.test(name)) return bashReason(input.command, trustTestCommands ? { ...bashAllow, ...TEST_COMMAND_ALLOW } : bashAllow);
  return `${name || 'this tool'} is desk-only`;
}

// The full remote check: deny-list first (specific reasons), then the allow-list.
export function remoteVerdict(compiled, { toolName, toolInput, repoLabels = [], cwd = null }, opts = {}) {
  const deny = evaluateDenyList(compiled, { toolName, toolInput, repoLabels });
  if (deny.blocked) return deny;
  const why = allowListReason({ toolName, toolInput, cwd }, opts);
  return why ? { blocked: true, ruleId: 'not-on-remote-allow-list', reason: why, message: DESK_MESSAGE } : { blocked: false };
}
