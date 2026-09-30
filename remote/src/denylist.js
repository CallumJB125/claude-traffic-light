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
export const CREDENTIAL_PATHS = /(^|[\s"'=:/~])(\.ssh|\.aws|\.gnupg|\.kube|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.claude|\.claude\.json|\.claude-traffic-light|\.board|Library\/Keychains)(\/|\b|$)/;
// Files that run code later: writing one is as good as running it.
export const RUNS_CODE_LATER = /(^|\/)(\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|profile|envrc)$|\.git\/(hooks|config)(\/|$)|\.husky\/|LaunchAgents\/|LaunchDaemons\/|crontab|\.github\/workflows\/|\.claude\/|\.mcp\.json$|\.vscode\/(tasks|settings)\.json$|package\.json$)/;

// ── git ────────────────────────────────────────────────────────────────────
function gitParts(c) {
  if (c.cmd !== 'git') return null;
  const a = c.args;
  let k = 0;
  let alias = false;
  while (k < a.length && a[k].startsWith('-')) {
    if (a[k] === '-c' || a[k] === '--config-env') { if (/^alias\./i.test(a[k + 1] || '') || a[k] === '--config-env') alias = true; k += 2; }
    else if (a[k] === '-C' || a[k] === '--git-dir' || a[k] === '--work-tree' || a[k] === '--namespace' || a[k] === '--exec-path') k += 2;
    else k += 1;
  }
  return { alias, sub: a[k] ?? '', rest: a.slice(k + 1) };
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
  ['pipe-to-shell', (c) => (c.piped && (SHELLS.has(c.cmd) || INTERPRETERS.test(c.cmd) || c.cmd === 'source' || c.cmd === 'xargs') ? 'pipes content into an interpreter (curl | sh)' : null)],
  ['interpreter-inline', (c) => ((SHELLS.has(c.cmd) && c.args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) || (INTERPRETERS.test(c.cmd) && c.args.some((a) => /^-[a-zA-Z]*[ceEp]$|^--(eval|command|exec|print)$|^-$/.test(a))) ? 'runs inline code (-c / -e)' : null)],
  ['eval', (c) => (c.cmd === 'eval' ? 'eval' : null)],
  ['network-tool', (c) => (/^(nc|ncat|netcat|socat|telnet)$/.test(c.cmd) ? 'raw network tool' : null)],
  ['sudo', (c) => (c.elevated || /^(su|sudo|doas|pkexec)$/.test(c.cmd) ? 'runs as another user (sudo)' : null)],
  ['kill-all', (c) => (/^(killall|pkill|shutdown|reboot|halt|poweroff)$/.test(c.cmd) || (c.cmd === 'kill' && c.args.includes('-1')) || (c.cmd === 'launchctl' && /^(bootout|unload|remove|disable)$/.test(c.args[0] || '')) ? 'kills processes or shuts down' : null)],
  ['git-destructive', gitDestructiveReason],
  ['git-force-push', gitPushReason],
  ['writes-code-or-secrets', (c) => (c.redirects.some((r) => r.op === '>' && (RUNS_CODE_LATER.test(r.target) || CREDENTIAL_PATHS.test(r.target))) || (/^(tee|cp|mv|ln|install|rsync)$/.test(c.cmd) && c.args.some((a) => RUNS_CODE_LATER.test(a))) ? 'writes a file that runs code later, or a secret' : null)],
];

// First finding for one shell command string: { id, reason } or null.
export function shellFinding(text, only = null) {
  if (/:\s*\(\s*\)\s*\{/.test(text)) return { id: 'fork-bomb', reason: 'fork bomb' };
  const { cmds, hazards } = parseShell(text);
  if (!only && (hazards.has('substitution') || hazards.has('process-substitution'))
    && cmds.some((c) => SHELLS.has(c.cmd) || c.cmd === 'eval' || c.cmd === 'source' || c.cmd === '.')
    && cmds.some((c) => /^(curl|wget|fetch|http|aria2c)$/.test(c.cmd))) {
    return { id: 'shell-from-download', reason: 'runs a downloaded script' };
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
  { id: 'credential-paths', input: CREDENTIAL_PATHS, reason: 'touches credentials or agent configuration' },
  { id: 'runs-code-later', tool: FILE_WRITE_TOOLS, input: RUNS_CODE_LATER, reason: 'writes a file that later runs code' },
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

const desk = (ruleId, reason) => ({ blocked: true, ruleId, reason, message: DESK_MESSAGE });

// → { blocked: true, ruleId, reason, message } or { blocked: false }
export function evaluateDenyList(compiled, { toolName, toolInput, repoLabels = [] }) {
  const canonical = canonicalize(toolInput ?? {});
  if (canonical.length > MAX_REMOTE_INPUT_CHARS) return desk('input-too-large', 'input too large to review remotely');
  const labels = new Set((repoLabels || []).map((l) => String(l).toLowerCase()));
  const texts = stringsIn(toolInput ?? {});
  for (const r of compiled) {
    if (r.tool && !test(r.tool, String(toolName ?? ''))) continue;
    if (r.labels && !r.labels.some((l) => labels.has(l))) continue;
    if (r.builtin === 'shell' || r.builtin === 'git-force-push') {
      const only = r.builtin === 'git-force-push' ? 'git-force-push' : null;
      for (const t of texts) {
        const f = shellFinding(t, only);
        if (f) return desk(f.id, `${r.reason}: ${f.reason}`);
      }
      continue;
    }
    if (r.input && !texts.some((t) => test(r.input, t))) continue;
    if (!r.input && !r.labels && !r.tool) continue; // an empty rule matches nothing
    return desk(r.id, r.reason);
  }
  return { blocked: false };
}
