// Auto-answer rules (P3+): "allow Bash `npm test *`", "allow Read under
// ~/Development/**", "deny WebFetch". Stored in config.json as
// `autoAnswer: { v: 1, rules: [...] }` (the shape is proposed to the hook
// core's owner; nothing evaluates these yet, see docs/waiting-inputs.md).
//
// Two jobs, both main-side:
//   refusal(rule)          why an allow rule may NOT be saved: it could ever
//                          match the deny-list or a destructive command, or it
//                          is too broad to reason about. Deny rules are always fine.
//   matchRule(rules, req)  the reference evaluator for the hook side: deny
//                          rules first; an allow only when the ACTUAL request
//                          also passes the deny-list and destructive checks.
// The deny-list is the phone path's (remote/src/denylist.js), so there is one
// list of dangerous shapes.
'use strict';

const os = require('os');
const path = require('path');
const { shellFinding, evaluateDenyList, compileRules, DEFAULT_RULES, CREDENTIAL_PATHS, RUNS_CODE_LATER } = require('../remote/src/denylist.js');
const { parseShell } = require('../remote/src/shell.js');
const { broadRule } = require('../hooks/pending-input.js');

const MAX_RULES = 100;
const SHELL_TOOLS = new Set(['Bash']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const TOOL_NAME = /^[A-Za-z][\w-]*$/;
const MCP_DESTRUCTIVE = /(delete|remove|drop|destroy|purge|wipe|reset|force|kill|revoke|transfer|merge|publish|deploy)/i;
const DENY_LIST = compileRules(DEFAULT_RULES);

// Commands that lose work, reach the network or change who can do what,
// beyond the deny-list's own shapes: always a person's call.
const DESTRUCTIVE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'dd', 'truncate', 'mv', 'kill', 'killall', 'pkill', 'chmod', 'chown', 'chgrp', 'sudo', 'su', 'doas', 'crontab', 'launchctl', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'socat', 'osascript', 'security', 'defaults', 'diskutil', 'open']);
const RISKY_SUBS = {
  git: new Set(['push', 'reset', 'clean', 'checkout', 'restore', 'rebase', 'branch', 'stash', 'rm', 'filter-branch', 'filter-repo', 'update-ref', 'reflog', 'gc', 'prune', 'worktree', 'switch', 'tag', 'remote', 'config', 'submodule', 'am', 'apply', 'cherry-pick', 'revert', 'merge', 'pull', 'fetch', 'clone', 'commit', 'init']),
  npm: new Set(['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'login', 'adduser', 'exec', 'x', 'install', 'i', 'ci', 'uninstall', 'update', 'link']),
  pnpm: new Set(['publish', 'dlx', 'exec', 'install', 'add', 'remove', 'update', 'link']),
  yarn: new Set(['publish', 'dlx', 'exec', 'add', 'remove', 'install', 'upgrade', 'link']),
  npx: null, bunx: null, pipx: null,
  docker: new Set(['rm', 'rmi', 'system', 'volume', 'network', 'kill', 'stop', 'push', 'login', 'run', 'exec', 'compose']),
  kubectl: new Set(['delete', 'apply', 'replace', 'patch', 'scale', 'drain', 'cordon', 'exec', 'edit', 'rollout']),
  terraform: new Set(['apply', 'destroy', 'import', 'state', 'taint']),
  gh: new Set(['repo', 'release', 'secret', 'auth', 'api', 'pr', 'workflow', 'gist', 'ssh-key', 'gpg-key']),
  brew: new Set(['install', 'uninstall', 'remove', 'upgrade', 'tap', 'untap', 'cleanup']),
  pip: new Set(['install', 'uninstall']), pip3: new Set(['install', 'uninstall']),
  cargo: new Set(['publish', 'install', 'uninstall', 'yank', 'login']),
};

// The subset of RISKY_SUBS that loses work or publishes: what makes Enter
// refuse to allow a live request (a rule refuses the wider set).
const DANGER_SUBS = {
  git: new Set(['push', 'reset', 'clean', 'checkout', 'restore', 'rebase', 'branch', 'stash', 'rm', 'filter-branch', 'filter-repo', 'update-ref', 'reflog', 'gc', 'prune']),
  npm: new Set(['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token']),
  pnpm: new Set(['publish']), yarn: new Set(['publish']), cargo: new Set(['publish', 'yank']),
  npx: null, bunx: null, pipx: null,
  docker: new Set(['rm', 'rmi', 'system', 'volume', 'kill', 'push']),
  kubectl: new Set(['delete', 'apply', 'replace', 'patch', 'scale', 'drain']),
  terraform: new Set(['apply', 'destroy', 'import', 'state', 'taint']),
  gh: new Set(['repo', 'release', 'secret', 'auth', 'api', 'ssh-key', 'gpg-key']),
};

// Why a command (its words, program first) is destructive, or null. A
// wildcard or missing subcommand counts as the worst one it could be.
function destructiveReason(words, subsTable) {
  const cmd = words[0];
  if (DESTRUCTIVE_CMDS.has(cmd)) return `${cmd} can delete or overwrite work, reach the network or change permissions`;
  if (!(cmd in subsTable)) return null;
  const subs = subsTable[cmd];
  if (!subs) return `${cmd} downloads and runs packages`;
  const sub = words.slice(1).find((w) => !w.startsWith('-'));
  if (!sub || isWild(sub)) return `“${words.slice(0, 2).join(' ')}” could be ${cmd} ${[...subs][0]}; name the ${cmd} subcommand`;
  if (subs.has(sub)) return `${cmd} ${sub} changes things outside the project or can’t be undone`;
  return null;
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const isWild = (s) => /[*?[\]{}]/.test(s);

function normalizeRule(r) {
  const x = r && typeof r === 'object' ? r : {};
  const tools = [...new Set((Array.isArray(x.tools) ? x.tools : typeof x.tool === 'string' ? [x.tool] : []).map((t) => str(t, 200)).filter(Boolean))].slice(0, 8);
  return {
    id: str(x.id, 60) || `ar_${Math.random().toString(36).slice(2, 10)}`,
    enabled: x.enabled !== false,
    action: x.action === 'deny' ? 'deny' : 'allow',
    tools,
    command: str(x.command, 500) || null,
    path: str(x.path, 500) || null,
    cwd: str(x.cwd, 500) || null,
    note: str(x.note, 200),
    createdAt: str(x.createdAt, 40) || null,
  };
}

const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
// The fixed part of a glob, before its first wildcard, as a directory.
function staticDir(glob, home) {
  const g = expandHome(glob, home);
  const i = g.search(/[*?[\]{}]/);
  const head = i < 0 ? g : g.slice(0, i);
  return i < 0 ? path.dirname(path.resolve(head)) : path.resolve(head.slice(0, head.lastIndexOf('/') + 1) || '/');
}
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function pathRefusal(glob, tools, home) {
  if (!glob) return 'Give a path, e.g. ~/Development/my-app/**';
  if (!(glob.startsWith('/') || glob.startsWith('~/'))) return 'The path must start with / or ~/ so it can’t mean different folders in different projects.';
  if (glob.split('/').includes('..')) return 'The path can’t contain “..”.';
  if (/[\p{Cc}\p{Cf}]/u.test(glob)) return 'The path contains invisible characters.';
  const dir = staticDir(glob, home);
  if (within(home, dir)) return 'Too broad: that covers your whole home folder (and your keys and settings in it). Pick a project folder.';
  if (CREDENTIAL_PATHS.test(expandHome(glob, home))) return 'That path holds credentials or agent settings: always ask a person.';
  if ([...tools].some((t) => WRITE_TOOLS.has(t)) && RUNS_CODE_LATER.test(expandHome(glob, home))) return 'Writing there sets up code that runs later (shell profiles, git hooks, CI, package.json): always ask a person.';
  if (/(^|\/)\.[^/*]*\*|\/\.\*/.test(glob)) return 'A wildcard over hidden files could reach keys and config: name the folder instead.';
  return null;
}

// Why a command pattern could match something that must always go to a person.
function commandRefusal(pattern) {
  if (!pattern) return 'Give a command, e.g. npm test or npm run lint *';
  if (/[\p{Cc}\p{Cf}]/u.test(pattern)) return 'The command contains invisible characters.';
  if (/[;&|<>`$()\\\n]/.test(pattern)) return 'Only a single plain command: no ; && | > $( ) or backslashes. Each part would need its own rule.';
  const words = pattern.split(/\s+/).filter(Boolean);
  if (!words.length || words.every((w) => /^[*?]+$/.test(w))) return 'Too broad: that matches every command.';
  const cmd = words[0];
  if (isWild(cmd) || cmd.includes('/') || cmd.includes('=')) return 'Start with the program’s plain name (no wildcards, paths or VAR=value).';
  if (broadRule({ toolName: 'Bash', ruleContent: pattern })) return `${cmd} runs any code it is given: always ask a person.`;
  const why = destructiveReason(words, RISKY_SUBS);
  if (why) return `${why}: always ask a person.`;
  if (CREDENTIAL_PATHS.test(pattern) || RUNS_CODE_LATER.test(pattern)) return 'That command names credentials, agent settings or files that run code later: always ask a person.';
  const f = shellFinding(pattern.replace(/[*?]/g, ''));
  if (f) return `On the deny-list (${f.reason}): always ask a person.`;
  return null;
}

// null when the rule may be saved, else the reason, in words for the UI.
function refusal(rule, { home = os.homedir() } = {}) {
  const r = normalizeRule(rule);
  if (!r.tools.length) return 'Pick at least one tool.';
  for (const t of r.tools) {
    if (!(TOOL_NAME.test(t) || MCP_TOOL.test(t))) return `“${t}” isn’t a tool name (no wildcards).`;
  }
  if (r.cwd && !(r.cwd.startsWith('/') || r.cwd.startsWith('~/'))) return 'The project folder must start with / or ~/.';
  if (r.action === 'deny') return null;
  const shell = r.tools.filter((t) => SHELL_TOOLS.has(t));
  const file = r.tools.filter((t) => FILE_TOOLS.has(t));
  const mcp = r.tools.filter((t) => MCP_TOOL.test(t));
  const other = r.tools.filter((t) => !SHELL_TOOLS.has(t) && !FILE_TOOLS.has(t) && !MCP_TOOL.test(t));
  if (other.length) return `${other[0]} can’t be auto-allowed: only Bash, the file tools and named MCP tools.`;
  if ([shell, file, mcp].filter((g) => g.length).length > 1) return 'Make one rule per kind of tool: Bash, file tools and MCP tools match on different things.';
  if (shell.length) {
    if (r.path) return 'A Bash rule matches on the command, not a path.';
    return commandRefusal(r.command);
  }
  if (file.length) {
    if (r.command) return 'A file rule matches on the path, not a command.';
    return pathRefusal(r.path, new Set(file), home);
  }
  const bad = mcp.find((t) => MCP_DESTRUCTIVE.test(t.split('__')[2]));
  if (bad) return `${bad} sounds like it deletes, publishes or changes access: always ask a person.`;
  if (r.command || r.path) return 'An MCP rule matches the tool name only.';
  return null;
}

// Keeps the rules that may be saved (bounded); the refused ones come back
// with their reasons so a UI can say why.
function sanitize(rules, opts) {
  const kept = [];
  const refused = [];
  for (const raw of (Array.isArray(rules) ? rules : []).slice(0, MAX_RULES)) {
    const r = normalizeRule(raw);
    const why = refusal(r, opts);
    if (why) refused.push({ rule: r, reason: why }); else kept.push(r);
  }
  return { rules: kept, refused };
}

// ── matching (reference for the hook side; not wired in) ─────────────────
function globRe(glob, home) {
  const g = expandHome(glob, home);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function wordMatch(pat, word) {
  if (!isWild(pat)) return pat === word;
  return new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^\\s]*')}$`).test(word);
}

// A trailing lone * matches any remaining arguments (none included).
function commandMatch(pattern, words) {
  const p = pattern.split(/\s+/).filter(Boolean);
  const rest = p[p.length - 1] === '*';
  const fixed = rest ? p.slice(0, -1) : p;
  if (rest ? words.length < fixed.length : words.length !== fixed.length) return false;
  return fixed.every((w, i) => wordMatch(w, words[i]));
}

// The one plain command a Bash request runs, or null when it is anything else
// (several commands, pipes, redirects, expansions, VAR=… prefixes, sudo…).
function simpleCommand(command) {
  if (typeof command !== 'string' || command.length > 2000 || /[\n\r]/.test(command)) return null;
  const { cmds, hazards } = parseShell(command);
  if (cmds.length !== 1 || hazards.size) return null;
  const c = cmds[0];
  if (c.piped || c.redirects.length || c.elevated || c.wrapped) return null;
  return c.words;
}

// Why an ACTUAL request must go to a person whatever the rules say, or null.
function mustAsk(req, home) {
  const input = req?.toolInput && typeof req.toolInput === 'object' ? req.toolInput : {};
  const deny = evaluateDenyList(DENY_LIST, { toolName: req?.tool, toolInput: input });
  if (deny.blocked) return deny.reason;
  if (SHELL_TOOLS.has(req?.tool)) {
    const words = simpleCommand(input.command);
    if (!words) return 'not a single plain command';
    const why = commandRefusal(words.join(' '));
    if (why) return why;
  }
  return null;
}

function targetPath(req, realpath) {
  const input = req?.toolInput || {};
  const p = [input.file_path, input.notebook_path, input.path].find((v) => typeof v === 'string' && v) || req?.cwd;
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  // Symlinks resolved: a link inside an allowed folder can point anywhere.
  try { return realpath ? realpath(path.resolve(p)) : path.resolve(p); } catch { return path.resolve(p); }
}

function ruleMatches(r, req, { home, realpath }) {
  if (!r.enabled || !r.tools.includes(req.tool)) return false;
  if (r.cwd && !(typeof req.cwd === 'string' && globRe(r.cwd, home).test(path.resolve(req.cwd)))) return false;
  if (SHELL_TOOLS.has(req.tool) && r.command) {
    const words = simpleCommand(req.toolInput?.command);
    return !!words && commandMatch(r.command, words);
  }
  if (FILE_TOOLS.has(req.tool) && r.path) {
    const p = targetPath(req, realpath);
    return !!p && globRe(r.path, home).test(p);
  }
  return !r.command && !r.path;
}

// → { action: 'allow'|'deny', ruleId } or null (a person decides).
// Only permission requests; plans, questions and forms are never auto-answered.
function matchRule(rules, req, { home = os.homedir(), realpath = null } = {}) {
  if (!req || (req.kind && req.kind !== 'permission') || typeof req.tool !== 'string') return null;
  const list = (Array.isArray(rules) ? rules : []).map(normalizeRule);
  const deny = list.find((r) => r.action === 'deny' && ruleMatches(r, req, { home, realpath }));
  if (deny) return { action: 'deny', ruleId: deny.id };
  if (mustAsk(req, home)) return null;
  const allow = list.find((r) => r.action === 'allow' && !refusal(r, { home }) && ruleMatches(r, req, { home, realpath }));
  return allow ? { action: 'allow', ruleId: allow.id } : null;
}

// What the widget flags on a permission request: why Enter must not allow
// it (it still can be allowed with a deliberate click).
function danger(req) {
  if (!req || typeof req.tool !== 'string') return null;
  const input = req.toolInput && typeof req.toolInput === 'object' ? req.toolInput : {};
  const deny = evaluateDenyList(DENY_LIST, { toolName: req.tool, toolInput: input });
  if (deny.blocked) return deny.reason;
  if (SHELL_TOOLS.has(req.tool) && typeof input.command === 'string') {
    const { cmds, hazards } = parseShell(input.command.slice(0, 8192));
    if (hazards.has('substitution') || hazards.has('process-substitution')) return 'runs a nested command';
    for (const c of cmds) {
      const why = c.elevated ? 'runs as another user (sudo)' : destructiveReason([c.cmd, ...c.args], DANGER_SUBS);
      if (why) return why;
    }
  }
  return null;
}

module.exports = { MAX_RULES, SHELL_TOOLS, FILE_TOOLS, normalizeRule, refusal, sanitize, matchRule, mustAsk, danger, simpleCommand, commandMatch, globRe };
