// Things a phone can never approve: the desktop answers "approve at your
// desk" instead. Checked on the desktop only, against the pending request's
// own tool input — the input whose hash the signed decision was verified
// against — and the repo labels the desktop (never the hub or phone) assigns.
//
// A rule is one of:
//   { id, reason, tool?: RegExp|string, input?: RegExp|string, labels?: string[] }
//       tool   matches the tool name (default: any tool)
//       input  matches any string value inside the input, or its canonical JSON
//       labels matches if the repo carries any of these labels
//     All given parts must match.
//   { id, reason, builtin: 'git-force-push', protectedBranches?: string[] }
//
// This is a safety net over free text, not a sandbox: a determined command
// can be written to dodge a regex (see THREAT_MODEL.md, residual risks).
import { canonicalize } from './canonical.js';

export const DESK_MESSAGE = 'approve at your desk';

const SHELL_TOOLS = /^(Bash|BashOutput|shell|run_shell_command|exec_command|execute_command|terminal|run_terminal_cmd|local_shell)$/i;
const FILE_WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|write_file|edit_file|replace|apply_patch|str_replace_editor|create_file)$/i;

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop', 'dev', 'production', 'prod', 'staging', 'release/*', 'releases/*', 'hotfix/*'];

// Separators between commands are ; & | newline; a flag of rm/chmod must sit
// in the same command. `[^;&|\n]*` keeps a match inside one command.
const C = '[^;&|\\n]*';

export const DEFAULT_RULES = [
  { id: 'rm-recursive', tool: SHELL_TOOLS, input: new RegExp(`\\brm\\b${C}\\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`), reason: 'recursive delete' },
  { id: 'find-delete', tool: SHELL_TOOLS, input: new RegExp(`\\bfind\\b${C}\\s(-delete\\b|-exec\\s+(sudo\\s+)?(rm|shred)\\b)`), reason: 'bulk delete via find' },
  { id: 'shred-wipe', tool: SHELL_TOOLS, input: /\b(shred|wipefs|srm)\b/, reason: 'secure wipe' },
  { id: 'mkfs', tool: SHELL_TOOLS, input: /\b(mkfs(\.\w+)?|mke2fs|newfs(_\w+)?|diskutil\s+(erase\w*|partitionDisk|zeroDisk|randomDisk|secureErase)|fdisk|sfdisk|parted)\b/, reason: 'formats or repartitions a disk' },
  { id: 'dd', tool: SHELL_TOOLS, input: new RegExp(`\\bdd\\b${C}\\bof=`), reason: 'raw disk write (dd)' },
  { id: 'raw-device-write', tool: SHELL_TOOLS, input: />\s*\/dev\/(sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd)/, reason: 'writes to a raw device' },
  { id: 'chmod-chown-broad', tool: SHELL_TOOLS, input: new RegExp(`\\b(chmod|chown|chgrp)\\b${C}(\\s-[a-zA-Z]*R\\b|\\s--recursive\\b|\\s[0-7]?777\\b|\\s[augo]*\\+[rwx]*w[rwx]*\\s+/(\\s|$))`), reason: 'recursive or world-writable permission change' },
  { id: 'pipe-to-shell', tool: SHELL_TOOLS, input: /\|\s*(sudo\s+(-\S+\s+)*)?(env\s+)?(ba|z|da|k|c|tc|fi)?sh\b|\|\s*(sudo\s+)?(python\d?(\.\d+)?|node|perl|ruby|php)\b(\s+-)?\s*($|[;&|])/m, reason: 'pipes content into an interpreter (curl | sh)' },
  { id: 'shell-from-download', tool: SHELL_TOOLS, input: /\b(ba|z|da|k|fi)?sh\b[^\n]*(<\(|\$\(|`)\s*(curl|wget|fetch)\b|\b(eval|source|\.)\s+[^\n]*(<\(|\$\(|`)\s*(curl|wget|fetch)\b/, reason: 'runs a downloaded script' },
  { id: 'decode-exec', tool: SHELL_TOOLS, input: /\bbase64\b[^\n]*(-d|--decode|-D)\b[^\n]*\|\s*(ba|z|da|k)?sh\b|(^|[;&|(`])\s*eval\s/m, reason: 'eval / decoded-script execution' },
  { id: 'fork-bomb', tool: SHELL_TOOLS, input: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, reason: 'fork bomb' },
  { id: 'sudo', tool: SHELL_TOOLS, input: /(^|[;&|(`\s])(sudo|doas|su)\s/m, reason: 'runs as another user (sudo)' },
  { id: 'kill-all', tool: SHELL_TOOLS, input: /\b(killall|pkill)\b|\bkill\s+(-\S+\s+)*-1\b|\b(shutdown|reboot|halt|poweroff)\b|\blaunchctl\s+(bootout|unload|remove)\b/, reason: 'kills processes or shuts down' },
  { id: 'git-destructive', tool: SHELL_TOOLS, input: /\bgit\b[^;&|\n]*\s(reset\s+--hard|clean\s+-[a-zA-Z]*f|filter-branch|filter-repo|update-ref\s+-d|reflog\s+(expire|delete)|branch\s+-D|checkout\s+--\s+\.|restore\s+(--\S+\s+)*\.(\s|$))/, reason: 'destructive git operation' },
  { id: 'git-force-push', builtin: 'git-force-push', tool: SHELL_TOOLS, reason: 'force push or delete of a protected branch' },
  { id: 'credential-paths', tool: /.*/, input: /(^|[\s"'=:/~])(\.ssh|\.aws|\.gnupg|\.kube|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.claude|\.claude\.json|\.claude-traffic-light|\.board|Library\/Keychains)(\/|\b|$)/, reason: 'touches credentials or agent configuration' },
  { id: 'shell-startup-and-hooks', tool: FILE_WRITE_TOOLS, input: /(^|\/)(\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile|envrc)|\.git\/(hooks|config)(\/|$)|\.husky\/|LaunchAgents\/|LaunchDaemons\/|crontab|\.github\/workflows\/)/, reason: 'writes a file that later runs code' },
  { id: 'prod-repo', labels: ['prod', 'production'], reason: 'production repository' },
];

// ── git push parsing ────────────────────────────────────────────────────────
// Split into commands on ; && || | & and newlines, then into words with
// simple quote handling. Unknown shapes err towards "force".
function commands(text) {
  return text.split(/;|&&|\|\||\||&|\n/).map((c) => c.trim()).filter(Boolean);
}

function words(cmd) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function globMatch(pattern, name) {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

// Returns a reason string if a `git push` in `text` is a force push, delete
// or mirror that could hit a protected branch; else null.
export function gitForcePushViolation(text, protectedBranches = DEFAULT_PROTECTED_BRANCHES) {
  for (const cmd of commands(text)) {
    const w = words(cmd);
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++; // env assignments
    if (w[i] === 'sudo' || w[i] === 'command' || w[i] === 'exec') i++;
    if (!/(^|\/)git$/.test(w[i] || '')) continue;
    i++;
    // git's own options before the subcommand (-C dir, -c k=v, --git-dir=…)
    while (i < w.length && w[i].startsWith('-')) { if (w[i] === '-C' || w[i] === '-c') i++; i++; }
    if (w[i] !== 'push') continue;
    const args = w.slice(i + 1);
    let force = false, del = false, everything = false;
    const positional = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--') { positional.push(...args.slice(k + 1)); break; }
      if (/^--(force|force-with-lease|force-if-includes)(=|$)/.test(a)) force = true;
      else if (a === '--delete') del = true;
      else if (a === '--mirror' || a === '--all' || a === '--branches' || a === '--prune') everything = true;
      else if (/^--(repo|receive-pack|exec|push-option|signed|recurse-submodules)$/.test(a) || a === '-o') k++;
      else if (/^-[a-zA-Z]+$/.test(a)) { if (a.includes('f')) force = true; if (a.includes('d')) del = true; }
      else if (!a.startsWith('-')) positional.push(a);
    }
    const refspecs = positional.slice(1);
    const plusRefspec = refspecs.some((r) => r.startsWith('+'));
    const deleteRefspec = refspecs.some((r) => /^:/.test(r));
    if (!(force || del || plusRefspec || deleteRefspec || everything)) continue;
    if (everything) return 'pushes every branch with force/prune/mirror';
    if (refspecs.length === 0) return 'force push without an explicit branch';
    for (const r of refspecs) {
      const risky = force || del || r.startsWith('+') || r.startsWith(':');
      if (!risky) continue;
      const dst = r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
      if (!dst || dst === 'HEAD' || dst.includes('*') || dst.startsWith('@')) return `force push to ${dst || 'an unnamed ref'}`;
      if (protectedBranches.some((p) => globMatch(p, dst))) return `force push to protected branch ${dst}`;
    }
  }
  return null;
}

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

// Regexes are only safe to run repeatedly if they're not global/sticky.
const test = (re, s) => { re.lastIndex = 0; return re.test(s); };

export function compileRules(rules = DEFAULT_RULES) {
  return rules.map((r) => ({
    ...r,
    tool: toRegExp(r.tool),
    input: toRegExp(r.input),
    labels: Array.isArray(r.labels) ? r.labels.map((l) => String(l).toLowerCase()) : null,
  }));
}

// → { blocked: true, ruleId, reason, message } or { blocked: false }
// Larger inputs aren't scanned (regex cost, and nobody reviews 64 KB on a
// phone): they are desk-only.
export const MAX_REMOTE_INPUT_CHARS = 65536;

export function evaluateDenyList(compiled, { toolName, toolInput, repoLabels = [] }) {
  const labels = new Set((repoLabels || []).map((l) => String(l).toLowerCase()));
  const canonical = canonicalize(toolInput ?? {});
  if (canonical.length > MAX_REMOTE_INPUT_CHARS) return { blocked: true, ruleId: 'input-too-large', reason: 'input too large to review remotely', message: DESK_MESSAGE };
  const texts = stringsIn(toolInput ?? {});
  texts.push(canonical);
  for (const r of compiled) {
    if (r.tool && !test(r.tool, String(toolName ?? ''))) continue;
    if (r.labels && !r.labels.some((l) => labels.has(l))) continue;
    if (r.builtin === 'git-force-push') {
      const why = texts.map((t) => gitForcePushViolation(t, r.protectedBranches)).find(Boolean);
      if (!why) continue;
      return { blocked: true, ruleId: r.id, reason: `${r.reason}: ${why}`, message: DESK_MESSAGE };
    }
    if (r.input && !texts.some((t) => test(r.input, t))) continue;
    if (!r.input && !r.labels && !r.tool) continue; // an empty rule matches nothing
    return { blocked: true, ruleId: r.id, reason: r.reason, message: DESK_MESSAGE };
  }
  return { blocked: false };
}
