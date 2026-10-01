// Things a phone can never approve: the desktop answers "approve at your
// desk" instead. Checked on the desktop only, against the pending request's
// own tool input — the input whose hash the signed decision was verified
// against — and the repo labels the desktop (never the hub or phone) assigns.
//
// Defence in depth behind the remote allow-list (allowlist.js): the
// allow-list decides what a phone may approve at all; this list names the
// dangerous shapes explicitly so they stay desk-only even if someone widens
// the allow-list.
//
// Anything that runs code named in an argument (sh -c, env -S, git -c
// core.pager, docker run, ssh host cmd, sed e, …) is listed here, never left to
// the allow-list alone, because the same list decides what a desktop shortcut
// may allow without looking.
//
// Shell commands are tokenised first (shell.js) — every check below looks at
// words, never runs a backtracking regex over the raw command — and inputs
// over MAX_REMOTE_INPUT_CHARS aren't scanned at all: they're desk-only.
//
// A config rule is one of:
//   { id, reason, tool?: RegExp|string, input?: RegExp|string, labels?: string[] }
//       tool   matches the tool name (default: any tool)
//       input  matches any string value inside the input
//       labels matches if the repo carries any of these labels
//     All given parts must match. Keep `input` regexes simple (no nested or
//     adjacent unbounded quantifiers); they run on ≤ 8 KB of text.
//   { id, reason, builtin: 'shell' }            the tokenised shell checks
//   { id, reason, builtin: 'git-force-push' }   just the force-push check
import { canonicalize } from './canonical.js';
import { parseShell, SHELLS, INTERPRETERS } from './shell.js';

export const DESK_MESSAGE = 'approve at your desk';
export const MAX_REMOTE_INPUT_CHARS = 8192;

export const SHELL_TOOLS = /^(Bash|BashOutput|shell|run_shell_command|exec_command|execute_command|terminal|run_terminal_cmd|local_shell)$/i;
export const FILE_WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|write_file|edit_file|replace|apply_patch|str_replace_editor|create_file)$/i;

// Paths whose contents are secrets or grant access.
export const CREDENTIAL_PATHS = /(^|[\s"'=:/~])(\.ssh|\.aws|\.gnupg|\.kube|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.claude|\.claude\.json|\.claude-traffic-light|\.board|Library\/Keychains|\.zsh_history|\.bash_history|\.history|fish_history)(\/|\b|$)/i;
// Files that run code later: writing one is as good as running it.
export const RUNS_CODE_LATER = /(^|\/)(\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|profile|envrc)$|\.git\/(hooks|config)(\/|$)|\.husky\/|LaunchAgents\/|LaunchDaemons\/|crontab|\.github\/workflows\/|\.claude\/|\.mcp\.json$|\.vscode\/(tasks|settings)\.json$|package\.json$|\.gitconfig$|\.config\/|\.local\/bin\/|(GNU)?[Mm]akefile$|\.?[Jj]ustfile$|\.pre-commit-config\.ya?ml$|conftest\.py$|(jest|vitest|vite|playwright|babel|eslint)\.config\.[cm]?[jt]s$|\.eslintrc\.c?js$|\.babelrc\.js$|\.npmrc$|\.yarnrc(\.ya?ml)?$|pyproject\.toml$|setup\.py$|tox\.ini$|\.cargo\/config(\.toml)?$|build\.rs$|\.devcontainer\/|\.idea\/(runConfigurations\/|workspace\.xml$)|\.vscode\/launch\.json$|\.gitattributes$|\.lintstagedrc[^/]*$|lefthook\.ya?ml$|CLAUDE\.md$|AGENTS\.md$)|(^~|^\/Users\/[^/]+|^\/home\/[^/]+|^\/root)\/bin\/|^\/(usr\/(local\/)?|opt\/homebrew\/)?s?bin\//i;

// A path with // and . segments dropped and .. resolved, without a filesystem,
// so 'dir/./sub' can't slip past a 'dir/sub' pattern.
export function cleanPath(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (part !== '..' || !abs) out.push(part);
  }
  return ((abs ? '/' : '') + out.join('/')) || (abs ? '/' : '.');
}
const pathMatches = (re, p) => re.test(p) || re.test(cleanPath(p));

// ── git ────────────────────────────────────────────────────────────────────
// Config keys whose value is a program git runs (or a file of such keys).
const GIT_CODE_KEY = /^(core\.(sshcommand|pager|fsmonitor|hookspath|editor|askpass|gitproxy|alternaterefscommand)|.*\.(helper|command|textconv|cmd|program|driver|uploadpack|receivepack|difffilter)|alias\.|diff\.external|uploadpack\.packobjectshook|filter\..*\.(clean|smudge|process)|include(if)?\.|pager\.|sequence\.editor|protocol\..*allow)/i;

function gitParts(c) {
  if (c.cmd !== 'git') return null;
  const a = c.args;
  let k = 0;
  const config = [];
  let execPath = false;
  while (k < a.length && a[k].startsWith('-')) {
    const o = a[k];
    if (o === '-c' || o === '--config-env') { config.push(a[k + 1] ?? ''); k += 2; }
    else if (o.startsWith('--config-env=')) { config.push(o.slice(13)); k += 1; }
    else if (o === '-C' || o === '--git-dir' || o === '--work-tree' || o === '--namespace' || o === '--super-prefix' || o === '--attr-source') k += 2;
    else { if (o.startsWith('--exec-path=')) execPath = true; k += 1; }
  }
  const keys = config.map((x) => x.split('=')[0]);
  return { alias: keys.some((x) => /^alias\./i.test(x)), keys, execPath, sub: a[k] ?? '', rest: a.slice(k + 1) };
}

// git running a program named on the command line (config, options, transports).
function gitProgramReason(c) {
  const g = gitParts(c);
  if (!g) return null;
  const key = g.keys.find((k) => GIT_CODE_KEY.test(k));
  if (key) return `git config ${key} runs a program`;
  if (g.execPath) return 'git --exec-path runs git commands from another directory';
  const r = g.rest;
  const has = (re) => r.some((a) => re.test(a));
  if (has(/^(ext|fd)::/)) return 'git ext:: transport runs a command';
  if (has(/^--(upload-pack|receive-pack|exec)(=|$)/)) return 'git option that runs a program';
  if (has(/^--(output|ext-diff)(=|$)/)) return 'git option that writes a file or runs a program';
  switch (g.sub) {
    case 'config': {
      const pos = r.filter((a) => !a.startsWith('-'));
      if (has(/^(--get\S*|-l|--list|--unset(-all)?|--remove-section|--rename-section)$/) || /^(get|list|unset|remove-section|rename-section)$/.test(pos[0] ?? '')) return null;
      if (pos.length < 2 && !has(/^--(add|replace-all|edit)$/)) return null;
      const k = pos.find((p) => GIT_CODE_KEY.test(p));
      return k ? `git config ${k} runs a program` : null;
    }
    case 'clone': case 'init': {
      if (has(/^(-u|--template(=|$))/)) return `git ${g.sub} option that runs a program or installs hooks`;
      for (let i = 0; i < r.length; i++) {
        const v = r[i] === '-c' || r[i] === '--config' ? r[i + 1] : r[i].startsWith('--config=') ? r[i].slice(9) : null;
        if (v != null && GIT_CODE_KEY.test(v.split('=')[0])) return `git config ${v.split('=')[0]} runs a program`;
      }
      return null;
    }
    case 'rebase': return has(/^-x|^--exec(=|$)/) ? 'git rebase --exec runs commands' : null;
    case 'bisect': return r[0] === 'run' ? 'git bisect run runs commands' : null;
    case 'submodule': return r.includes('foreach') ? 'git submodule foreach runs commands' : null;
    case 'difftool': case 'mergetool': return has(/^-x|^--extcmd(=|$)/) ? `git ${g.sub} --extcmd runs a program` : null;
    case 'grep': return has(/^-O|^--open-files-in-pager(=|$)/) ? 'git grep -O runs a program' : null;
    case 'send-email': return has(/^--(to-cmd|cc-cmd|header-cmd|sendmail-cmd|smtp-server=[/.~])/) ? 'git send-email runs a program' : null;
    default: return null;
  }
}

// Any push that can overwrite or delete remote history.
function gitPushReason(c) {
  const g = gitParts(c);
  if (!g) return null;
  if (g.alias) return 'git alias defined on the command line';
  if (g.sub !== 'push') return null;
  for (const a of g.rest) {
    if (/^--(force|force-with-lease|force-if-includes)(=|$)/.test(a)) return `force push (${a})`;
    if (a === '--delete' || a === '--mirror' || a === '--prune') return `push ${a}`;
    if (/^-[a-zA-Z]+$/.test(a) && /[fd]/.test(a)) return `force/delete push (${a})`;
    if (!a.startsWith('-') && (a.startsWith('+') || a.startsWith(':'))) return `force/delete refspec ${a}`;
  }
  return null;
}

function gitDestructiveReason(c) {
  const g = gitParts(c);
  if (!g) return null;
  const has = (re) => g.rest.some((a) => re.test(a));
  switch (g.sub) {
    case 'reset': return has(/^--(hard|merge|keep)$/) ? 'git reset --hard' : null;
    case 'clean': return has(/^-[a-zA-Z]*f|^--force$/) ? 'git clean -f' : null;
    case 'filter-branch': case 'filter-repo': return `git ${g.sub}`;
    case 'update-ref': return has(/^-d$|^--stdin$/) ? 'git update-ref -d' : null;
    case 'reflog': return /^(expire|delete)$/.test(g.rest[0] || '') ? `git reflog ${g.rest[0]}` : null;
    case 'branch': return has(/^-[a-zA-Z]*D|^--delete$|^-[a-zA-Z]*d/) ? 'git branch delete' : null;
    case 'checkout': return has(/^--$|^-[a-zA-Z]*f|^--force$|^\.$/) ? 'git checkout discarding changes' : null;
    case 'restore': return !has(/^--staged$|^-S$/) || has(/^--worktree$|^-W$/) ? 'git restore discarding changes' : null;
    case 'stash': return /^(drop|clear)$/.test(g.rest[0] || '') ? `git stash ${g.rest[0]}` : null;
    case 'gc': case 'prune': return has(/^--prune/) || g.sub === 'prune' ? 'git prune' : null;
    default: return null;
  }
}

// ── programs that run code named in an argument ────────────────────────────
// Variables that make the program they reach run other code.
const ENV_RUNS_CODE = /^(GIT_(SSH|SSH_COMMAND|EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|ASKPASS|PROXY_COMMAND|EXEC_PATH|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|TEMPLATE_DIR)|SSH_ASKPASS|SUDO_ASKPASS|EDITOR|VISUAL|PAGER|MANPAGER|SYSTEMD_PAGER|LESSOPEN|LESSCLOSE|BROWSER|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|BASH_ENV|ENV|PROMPT_COMMAND|PS[0-4]|NODE_OPTIONS|PERL5OPT|PERL5LIB|RUBYOPT|PYTHONSTARTUP|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTC_WRAPPER|CARGO_TARGET_\w+_RUNNER|npm_config_(script_shell|node_options|userconfig|globalconfig))$/i;

function envReason(c) {
  const set = [...c.env];
  if (/^(export|declare|typeset|readonly|local)$/.test(c.cmd)) {
    for (const a of c.args) { const k = a.indexOf('='); if (k > 0) set.push({ name: a.slice(0, k), value: a.slice(k + 1) }); }
  }
  const e = set.find((x) => ENV_RUNS_CODE.test(x.name) || (/^GOFLAGS$/i.test(x.name) && /-(exec|toolexec|vettool)\b/.test(x.value)));
  return e ? `${e.name} makes the next program run code` : null;
}

// Words that aren't options, skipping the values of options matching `takesValue`.
function positionals(args, takesValue) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') { if (takesValue.test(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

const CONTAINER_VALUE = /^(-H|--host|-c|--context|--config|-l|--log-level|--tlscacert|--tlscert|--tlskey|-f|--file|-p|--project-name|--project-directory|--env-file|--profile|--ansi|-n|--namespace|--kubeconfig|--cluster|--user|-s|--server|--token)$/;
function containerReason(c) {
  if (/^(docker|podman|nerdctl|finch|docker-compose|podman-compose)$/.test(c.cmd)) {
    const p = positionals(c.args, CONTAINER_VALUE);
    const sub = /compose$/.test(c.cmd) ? p[0] : /^(compose|container)$/.test(p[0] ?? '') ? p[1] : p[0];
    return /^(run|exec)$/.test(sub ?? '') ? `${c.cmd} ${sub} runs a command in a container` : null;
  }
  if (/^(kubectl|oc)$/.test(c.cmd)) {
    const sub = positionals(c.args, CONTAINER_VALUE)[0] ?? '';
    return /^(exec|run|debug)$/.test(sub) ? `${c.cmd} ${sub} runs a command in a pod` : null;
  }
  return null;
}

const SSH_VALUE = 'BbcDEeFIiJLlmOoPpQRSWw';
function remoteReason(c) {
  if (/^(ssh|scp|sftp)$/.test(c.cmd)) {
    const a = c.args;
    let host = -1;
    for (let i = 0; i < a.length; i++) {
      const w = a[i];
      if (w === '--') { host = i + 1; break; }
      if (!w.startsWith('-') || w === '-') { if (c.cmd === 'ssh') { host = i; break; } continue; }
      for (let j = 1; j < w.length; j++) {
        if (!SSH_VALUE.includes(w[j])) continue;
        const v = w.slice(j + 1) || (a[++i] ?? '');
        if (w[j] === 'F' || (w[j] === 'o' && /^\s*(proxycommand|localcommand|permitlocalcommand|knownhostscommand)\b/i.test(v))) return `${c.cmd} option runs a local command`;
        break;
      }
    }
    if (c.cmd === 'ssh' && host >= 0 && host + 1 < a.length) return 'ssh runs a command on another machine';
  }
  if (c.cmd === 'rsync' && c.args.some((a) => /^--rsync-path(=|$)/.test(a))) return 'rsync --rsync-path runs a program';
  return null;
}

const PKG_VALUE = /^(-C|--prefix|-w|--workspace|--userconfig|--cache|--registry|--filter|--dir|--cwd)$/;
function packageRunnerReason(c) {
  if (/^(npx|pnpx|bunx)$/.test(c.cmd)) return `${c.cmd} downloads or runs a package binary`;
  const sub = /^(npm|pnpm|yarn|bun)$/.test(c.cmd) ? positionals(c.args, PKG_VALUE)[0] ?? '' : '';
  if ((c.cmd === 'npm' && /^(exec|x)$/.test(sub)) || (/^(pnpm|yarn)$/.test(c.cmd) && /^(dlx|exec)$/.test(sub)) || (c.cmd === 'bun' && sub === 'x')) {
    return `${c.cmd} ${sub} downloads or runs a package binary`;
  }
  return null;
}

// The scripts of a sed command line: -e / --expression values, else the first
// operand (and the one after an empty BSD `-i ''` suffix).
function sedScripts(a) {
  const out = [];
  let file = false, i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (x === '--') { i++; break; }
    if (x === '--expression' || x === '--file') { if (x === '--file') file = true; else out.push(a[i + 1] ?? ''); i++; continue; }
    if (x.startsWith('--expression=')) { out.push(x.slice(13)); continue; }
    if (x.startsWith('--file=')) { file = true; continue; }
    if (x.startsWith('--')) continue;
    if (!x.startsWith('-') || x === '-') break;
    for (let j = 1; j < x.length; j++) {
      if ('efl'.includes(x[j])) {
        const attached = x.slice(j + 1);
        const v = attached || (a[i + 1] ?? '');
        if (!attached) i++;
        if (x[j] === 'e') out.push(v); else if (x[j] === 'f') file = true;
        break;
      }
      if (x[j] === 'i') break;
    }
  }
  if (!out.length && !file && i < a.length) { out.push(a[i]); if (a[i] === '' && i + 1 < a.length) out.push(a[i + 1]); }
  return out;
}

// GNU sed's `e` command and the e flag of s/// hand text to a shell; `w`/`W`
// and the w flag write files. Syntax it doesn't follow counts as `e`.
function sedScript(s) {
  const writes = [];
  const n = s.length;
  let i = 0;
  const skipTo = (d) => { for (; i < n && s[i] !== d; i++) if (s[i] === '\\') i++; i++; };
  const rest = () => { const st = i; while (i < n && s[i] !== '\n') { if (s[i] === '\\') i++; i++; } return s.slice(st, i).trim(); };
  while (i < n) {
    const c = s[i];
    if (/[\s;{}!0-9$,~+IM]/.test(c)) { i++; continue; }
    if (c === '/') { i++; skipTo('/'); continue; }
    if (c === '\\') { const d = s[i + 1]; i += 2; if (d === undefined || d === '\n') return { exec: true, writes }; skipTo(d); continue; }
    if (c === '#') { rest(); continue; }
    if (c === 's' || c === 'y') {
      const d = s[i + 1];
      if (d === undefined || d === '\n' || d === '\\') return { exec: true, writes };
      i += 2; skipTo(d); skipTo(d);
      if (c === 'y') continue;
      const f0 = i;
      while (i < n && /[a-zA-Z0-9]/.test(s[i])) i++;
      const flags = s.slice(f0, i);
      const w = flags.indexOf('w');
      if ((w < 0 ? flags : flags.slice(0, w)).includes('e')) return { exec: true, writes };
      if (w >= 0) { i = f0 + w + 1; writes.push(rest()); }
      continue;
    }
    if (c === 'e') return { exec: true, writes };
    i++;
    if (c === 'w' || c === 'W') writes.push(rest());
    else if ('aicrR:'.includes(c)) rest();
    else if ('btT'.includes(c)) { while (i < n && s[i] !== ';' && s[i] !== '\n') i++; }
    else if (!'=dDgGhHlLnNpPqQxzF'.includes(c)) return { exec: true, writes };
  }
  return { exec: false, writes };
}

// awk program texts: -e / --source values, else the first operand.
function awkPrograms(a) {
  const out = [];
  let file = false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--') { if (!out.length && !file && i + 1 < a.length) out.push(a[i + 1]); break; }
    if (x === '-e' || x === '--source') { out.push(a[++i] ?? ''); continue; }
    if (x.startsWith('--source=')) { out.push(x.slice(9)); continue; }
    if (/^(-l|--load)(=|$)|^-l./.test(x)) { out.push('@load'); if (x === '-l' || x === '--load') i++; continue; }
    if (/^(-f|--file|-i|--include|-E|--exec)$/.test(x)) { file = true; i++; continue; }
    if (/^(-F|-v|--field-separator|--assign)$/.test(x)) { i++; continue; }
    if (x.startsWith('-') && x !== '-') continue;
    if (!out.length && !file) out.push(x);
    break;
  }
  return out;
}

// An awk program without its string and regex literals, so a '|' left over is
// a pipe. A '/' after an operand is division; reading it as a regex instead
// could only hide a pipe, so the operand test errs that way.
function awkCode(p) {
  let out = '';
  let prev = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '"' || (c === '/' && !/[\w)\]$]/.test(prev))) {
      for (i++; i < p.length && p[i] !== c; i++) if (p[i] === '\\') i++;
      out += c + c;
      prev = 'x';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

const EDITORS = /^(vim?|nvim|gvim|mvim|ex|view|vimdiff|nvi|rvim)$/;
function programOptionReason(c) {
  const a = c.args;
  const has = (re) => a.some((x) => re.test(x));
  const cmd = c.cmd;
  if (/^[gmn]?awk$/.test(cmd) || (cmd === 'busybox' && a[0] === 'awk')) {
    return awkPrograms(cmd === 'busybox' ? a.slice(1) : a).some((p) => /system\s*\(|\||@\w/.test(awkCode(p))) ? 'awk program runs commands (system, pipes)' : null;
  }
  if (/^g?sed$/.test(cmd)) return sedScripts(a).some((s) => sedScript(s).exec) ? 'sed e command runs a shell' : null;
  if (EDITORS.test(cmd) && a.some((x, k) => /^(-c|--cmd|-S)$/.test(x) || /^\+[^\d/]/.test(x) || (x === '-u' && !/^(NONE|NORC|DEFAULTS)$/.test(a[k + 1] ?? '')))) return 'editor runs commands from its arguments';
  if (/^emacs(client)?$/.test(cmd) && has(/^--?(eval|execute)(=|$)|^-e$/)) return 'editor runs code from its arguments';
  if (/^(g|bsd)?tar$/.test(cmd) && has(/^--(to-command|checkpoint-action|use-compress-program|info-script|new-volume-script|rsh-command|rmt-command)(=|$)|^-[a-zA-Z]*I|^-F$/)) return 'tar option runs a program';
  if (cmd === 'zip' && has(/^(-TT|--unzip-command)/)) return 'zip -TT runs a program';
  if (cmd === 'go' && has(/^--?(exec|toolexec|vettool)(=|$)/)) return 'go option runs a program';
  if (cmd === 'cargo' && has(/^--config(=|$)/)) return 'cargo --config can set a program to run';
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd) && has(/^--(script-shell|node-options|userconfig|globalconfig)(=|$)/)) return `${cmd} option runs a program`;
  if (cmd === 'sort' && has(/^--compress-program(=|$)/)) return 'sort --compress-program runs a program';
  if (cmd === 'rg' && has(/^--pre(=|$)/)) return 'rg --pre runs a program';
  if (cmd === 'man' && has(/^-P|^--pager(=|$)|^-H|^--html(=|$)/)) return 'man option runs a program';
  if (/^(gdb|lldb)$/.test(cmd) && has(/^(-ex|-iex|--eval-command|--init-eval-command|-o|--one-line|-O|--one-line-before-file)(=|$)/)) return 'debugger runs commands from its arguments';
  if (cmd === 'parallel') return 'parallel runs commands through a shell';
  return null;
}

function inlineCodeReason(c) {
  const a = c.args;
  const has = (re) => a.some((x) => re.test(x));
  if (SHELLS.has(c.cmd) && has(/^-[a-zA-Z]*c[a-zA-Z]*$|^--command(=|$)/)) return 'runs inline code (-c / -e)';
  if (!INTERPRETERS.test(c.cmd)) return null;
  if (has(/^-[a-zA-Z]*[ceEp]$|^--(eval|command|exec|print)(=|$)|^-$/)) return 'runs inline code (-c / -e)';
  if (c.cmd === 'php' && has(/^-[a-zA-Z]*[rBRE]$/)) return 'runs inline code (php -r)';
  if (/^(pwsh|powershell)$/.test(c.cmd) && has(/^-(c|command|e|ec|encodedcommand)$/i)) return 'runs inline code (-Command)';
  if (c.cmd === 'deno' && a[0] === 'eval') return 'runs inline code (deno eval)';
  if (c.redirects.some((r) => r.heredoc || r.herestring)) return 'feeds inline code to an interpreter';
  return null;
}

function unicodeReason(c) {
  if (/[^\x21-\x7e]/.test(c.cmd)) return `non-ASCII program name (${JSON.stringify(c.cmd.normalize('NFKC'))})`;
  return c.words.some((w) => !w.startsWith('-') && w.normalize('NFKC').startsWith('-')) ? 'option written with look-alike characters' : null;
}

// A substitution, arithmetic or prompt expansion in an assigned value runs
// code (arithmetic evaluates array subscripts, ${x@P} expands $(…) in x).
const RUNS_ON_EXPANSION = /\$SUB|\$\[|\$\{[^}]*@P/;
function assignmentReason(c) {
  const values = c.env.map((e) => e.value);
  if (/^(export|declare|typeset|readonly|local)$/.test(c.cmd)) for (const a of c.args) if (a.includes('=')) values.push(a.slice(a.indexOf('=') + 1));
  if (values.some((v) => RUNS_ON_EXPANSION.test(v))) return 'an assigned value runs a command substitution or expansion';
  return c.words.some((w) => /\$\{[^}]*@P/.test(w)) ? 'prompt expansion (${x@P}) runs substitutions' : null;
}

function writesCodeOrSecrets(c) {
  const target = (p) => pathMatches(RUNS_CODE_LATER, p) || pathMatches(CREDENTIAL_PATHS, p);
  if (c.redirects.some((r) => r.op === '>' && target(r.target))) return 'writes a file that runs code later, or a secret';
  if (/^(tee|cp|mv|ln|install|rsync)$/.test(c.cmd) && c.args.some((a) => pathMatches(RUNS_CODE_LATER, a))) return 'writes a file that runs code later, or a secret';
  const sed = /^g?sed$/.test(c.cmd);
  if ((sed || c.cmd === 'perl') && c.args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)) && c.args.some(target)) return 'edits a file that runs code later, or a secret, in place';
  if (sed && sedScripts(c.args).some((s) => sedScript(s).writes.some(target))) return 'writes a file that runs code later, or a secret';
  return null;
}

// ── tokenised shell checks: [id, (cmd) → reason | null] ────────────────────
const SHELL_CHECKS = [
  ['dynamic-command', (c) => (c.cmd.includes('$') ? 'command name comes from a variable or substitution' : null)],
  ['rm-recursive', (c) => (c.cmd === 'rm' && c.args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive') ? 'recursive delete' : null)],
  ['find-delete', (c) => (c.cmd === 'find' && c.args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a)) ? 'find that deletes or runs commands' : null)],
  ['shred-wipe', (c) => (/^(shred|wipefs|srm)$/.test(c.cmd) ? 'secure wipe' : null)],
  ['mkfs', (c) => (/^(mkfs(\..+)?|mke2fs|newfs(_.+)?|fdisk|sfdisk|gdisk|parted)$/.test(c.cmd) || (c.cmd === 'diskutil' && /^(erase\w*|partitionDisk|zeroDisk|randomDisk|secureErase|reformat)$/i.test(c.args[0] || '')) ? 'formats or repartitions a disk' : null)],
  ['dd', (c) => (c.cmd === 'dd' && c.args.some((a) => a.startsWith('of=')) ? 'raw disk write (dd)' : null)],
  ['raw-device-write', (c) => (c.redirects.some((r) => r.op === '>' && /^\/dev\/(sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd)/.test(r.target)) ? 'writes to a raw device' : null)],
  ['chmod-chown-broad', (c) => (/^(chmod|chown|chgrp)$/.test(c.cmd) && c.args.some((a, k) => /^-[a-zA-Z]*R/.test(a) || a === '--recursive' || /^0?[0-7]?777$/.test(a) || (/^[augo]*[+=][rwxXst]*w/.test(a) && c.args[k + 1] === '/')) ? 'recursive or world-writable permission change' : null)],
  ['pipe-to-shell', (c) => (c.piped && (SHELLS.has(c.cmd) || INTERPRETERS.test(c.cmd) || c.cmd === 'source' || c.cmd === '.' || c.cmd === 'xargs') ? 'pipes content into an interpreter (curl | sh)' : null)],
  ['interpreter-inline', inlineCodeReason],
  ['eval', (c) => (c.cmd === 'eval' ? 'eval' : null)],
  ['network-tool', (c) => (/^(nc|ncat|netcat|socat|telnet)$/.test(c.cmd) || c.redirects.some((r) => /^\/dev\/(tcp|udp)\//.test(r.target)) ? 'raw network tool' : null)],
  ['sudo', (c) => (c.elevated || /^(su|sudo|doas|pkexec)$/.test(c.cmd) ? 'runs as another user (sudo)' : null)],
  ['kill-all', (c) => (/^(killall|pkill|shutdown|reboot|halt|poweroff)$/.test(c.cmd) || (c.cmd === 'kill' && c.args.includes('-1')) || (c.cmd === 'launchctl' && /^(bootout|unload|remove|disable)$/.test(c.args[0] || '')) ? 'kills processes or shuts down' : null)],
  ['git-destructive', gitDestructiveReason],
  ['git-force-push', gitPushReason],
  ['writes-code-or-secrets', writesCodeOrSecrets],
  ['git-runs-program', gitProgramReason],
  ['code-env', envReason],
  ['assignment-expansion', assignmentReason],
  ['container-exec', containerReason],
  ['remote-exec', remoteReason],
  ['package-runner', packageRunnerReason],
  ['runs-program-option', programOptionReason],
  ['unicode', unicodeReason],
  ['unparsed', (c) => (c.unparsed ? `can't tell what runs (${c.unparsed})` : null)],
];

// First finding for one shell command string: { id, reason } or null.
export function shellFinding(text, only = null) {
  if (/:\s*\(\s*\)\s*\{/.test(text)) return { id: 'fork-bomb', reason: 'fork bomb' };
  const { cmds, hazards } = parseShell(text);
  if (!only && hazards.has('bidi')) return { id: 'unicode', reason: 'bidi control characters (what is shown is not what runs)' };
  if (!only && hazards.has('invisible')) return { id: 'unicode', reason: 'invisible characters outside quoted text' };
  if (!only && (hazards.has('substitution') || hazards.has('process-substitution'))
    && cmds.some((c) => SHELLS.has(c.cmd) || c.cmd === 'eval' || c.cmd === 'source' || c.cmd === '.')
    && cmds.some((c) => /^(curl|wget|fetch|http|aria2c)$/.test(c.cmd))) {
    return { id: 'shell-from-download', reason: 'runs a downloaded script' };
  }
  if (!only && hazards.has('process-substitution') && cmds.some((c) => SHELLS.has(c.cmd) || c.cmd === 'source' || c.cmd === '.')) {
    return { id: 'runs-generated-code', reason: "runs another command's output as a script" };
  }
  for (const c of cmds) {
    for (const [id, check] of SHELL_CHECKS) {
      if (only && id !== only) continue;
      const reason = check(c);
      if (reason) return { id, reason };
    }
  }
  return null;
}

export function gitForcePushViolation(text) {
  return shellFinding(text, 'git-force-push')?.reason ?? null;
}

export const DEFAULT_RULES = [
  { id: 'shell', builtin: 'shell', tool: SHELL_TOOLS, reason: 'dangerous shell command' },
  { id: 'credential-paths', input: CREDENTIAL_PATHS, paths: true, reason: 'touches credentials or agent configuration' },
  { id: 'runs-code-later', tool: FILE_WRITE_TOOLS, input: RUNS_CODE_LATER, paths: true, reason: 'writes a file that later runs code' },
  { id: 'prod-repo', labels: ['prod', 'production'], reason: 'production repository' },
];

// ── evaluation ──────────────────────────────────────────────────────────────
function toRegExp(x) {
  if (x == null) return null;
  return x instanceof RegExp ? x : new RegExp(String(x));
}

function stringsIn(v, out = [], depth = 0) {
  if (depth > 64) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.push(k); stringsIn(v[k], out, depth + 1); }
  return out;
}

const test = (re, s) => { re.lastIndex = 0; return re.test(s); };

export function compileRules(rules = DEFAULT_RULES) {
  return rules.map((r) => ({
    ...r,
    tool: toRegExp(r.tool),
    input: toRegExp(r.input),
    labels: Array.isArray(r.labels) ? r.labels.map((l) => String(l).toLowerCase()) : null,
  }));
}

// For file tools a `paths: true` rule looks at the path fields only (raw and
// cleaned): a file's content isn't a path it touches. Tools without a path
// field (apply_patch) and every other tool are scanned whole.
const READ_FILE_TOOLS = /^(Read|Grep|Glob|LS|NotebookRead|read_file|read_many_files|list_directory|glob|search_file_content)$/i;
function pathTexts(toolName, input, texts) {
  let vals = null;
  if ((FILE_WRITE_TOOLS.test(toolName) || READ_FILE_TOOLS.test(toolName)) && input && typeof input === 'object' && !Array.isArray(input)) {
    const fields = ['file_path', 'notebook_path', 'path', 'glob', ...(/^glob$/i.test(toolName) ? ['pattern'] : [])];
    vals = fields.map((f) => input[f]).filter((x) => typeof x === 'string');
  }
  return (vals?.length ? vals : texts).flatMap((t) => [t, cleanPath(t)]);
}

const desk = (ruleId, reason) => ({ blocked: true, ruleId, reason, message: DESK_MESSAGE });

// → { blocked: true, ruleId, reason, message } or { blocked: false }
export function evaluateDenyList(compiled, { toolName, toolInput, repoLabels = [] }) {
  const canonical = canonicalize(toolInput ?? {});
  if (canonical.length > MAX_REMOTE_INPUT_CHARS) return desk('input-too-large', 'input too large to review remotely');
  const labels = new Set((repoLabels || []).map((l) => String(l).toLowerCase()));
  const texts = stringsIn(toolInput ?? {});
  // A shell tool's description is shown, never run: judge everything else as commands.
  const plain = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput);
  const shellTexts = plain ? stringsIn(Object.fromEntries(Object.entries(toolInput).filter(([k]) => k !== 'description'))) : texts;
  for (const r of compiled) {
    if (r.tool && !test(r.tool, String(toolName ?? ''))) continue;
    if (r.labels && !r.labels.some((l) => labels.has(l))) continue;
    if (r.builtin === 'shell' || r.builtin === 'git-force-push') {
      const only = r.builtin === 'git-force-push' ? 'git-force-push' : null;
      for (const t of shellTexts) {
        const f = shellFinding(t, only);
        if (f) return desk(f.id, `${r.reason}: ${f.reason}`);
      }
      continue;
    }
    if (r.input && !(r.paths ? pathTexts(String(toolName ?? ''), toolInput, texts) : texts).some((t) => test(r.input, t))) continue;
    if (!r.input && !r.labels && !r.tool) continue; // an empty rule matches nothing
    return desk(r.id, r.reason);
  }
  return { blocked: false };
}
