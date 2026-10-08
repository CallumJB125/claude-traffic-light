'use strict';
// Policy packs, hook side. A repo's .plexiform/policy.json (or, without one,
// the person's default, policy-default.json in the data folder) says which
// tool calls and prompts an AI session may make there. set-status.js asks
// decide() on every PreToolUse and UserPromptSubmit.
//
// Advisory and local: nothing here leaves the Mac, and a policy can only make
// Claude Code refuse a call or a prompt. It fails SAFE: a missing, oversized,
// unreadable or malformed file is ignored with a warning, an unknown field is
// ignored, and any error allows the call, so a policy can never break a session.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_FILE = path.join('.plexiform', 'policy.json');
const DEFAULT_FILE = 'policy-default.json';
const SPEND_FILE = 'policy-spend.json';
const BLOCKS_DIR = 'policy-blocks';
const MAX_BYTES = 64 * 1024;
const MAX_WALK = 40;
const MAX_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_PATTERNS = 200;
const PROMPT_ACTIONS = ['deny', 'warn', 'off'];
// Asking the person, and leaving plan mode, are never refused.
const NEVER_GATED = new Set(['AskUserQuestion', 'ExitPlanMode']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim() && s.length <= 500).map((s) => s.trim()).slice(0, MAX_PATTERNS) : []);

// ── Reading a policy ────────────────────────────────────────────────────────

/** → {policy, warnings[]}: only the fields that are well formed; null policy when the file must be ignored. */
function normalize(raw) {
  if (!isObj(raw)) return { policy: null, warnings: ['is not a JSON object'] };
  if (raw.version !== 1) return { policy: null, warnings: [`has version ${JSON.stringify(raw.version)}; only version 1 is understood`] };
  const warnings = [];
  const p = { version: 1, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Custom policy' };
  if (typeof raw.pack === 'string') p.pack = raw.pack.slice(0, 40);
  if (raw.tools !== undefined) {
    if (!isObj(raw.tools)) warnings.push('"tools" is not an object');
    else p.tools = { allow: strings(raw.tools.allow), deny: strings(raw.tools.deny) };
  }
  for (const k of ['readOnly', 'denyRmOutsideRepo']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'boolean') warnings.push(`"${k}" is not true or false`);
    else p[k] = raw[k];
  }
  if (raw.network !== undefined) {
    if (typeof raw.network !== 'boolean') warnings.push('"network" is not true or false');
    else p.network = raw.network;
  }
  if (raw.protectedPaths !== undefined) {
    if (!Array.isArray(raw.protectedPaths)) warnings.push('"protectedPaths" is not a list');
    else p.protectedPaths = strings(raw.protectedPaths);
  }
  if (raw.prompts !== undefined) {
    if (!isObj(raw.prompts)) warnings.push('"prompts" is not an object');
    else {
      p.prompts = {};
      for (const k of ['secrets', 'pii']) {
        const v = raw.prompts[k];
        if (v === undefined) continue;
        if (!PROMPT_ACTIONS.includes(v)) warnings.push(`"prompts.${k}" is not one of ${PROMPT_ACTIONS.join(', ')}`);
        else p.prompts[k] = v;
      }
    }
  }
  if (raw.dailySpendCapUsd !== undefined && raw.dailySpendCapUsd !== null) {
    if (!Number.isFinite(raw.dailySpendCapUsd) || raw.dailySpendCapUsd <= 0) warnings.push('"dailySpendCapUsd" is not a positive number');
    else p.dailySpendCapUsd = raw.dailySpendCapUsd;
  }
  return { policy: p, warnings };
}

/** → {policy, warnings[]}; a file that can't be used gives policy null and says why. */
function readPolicyFile(file, { readFileSync = fs.readFileSync } = {}) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return { policy: null, warnings: e && e.code === 'ENOENT' ? [] : ['could not be read'], missing: !!(e && e.code === 'ENOENT') }; }
  if (typeof text !== 'string' || text.length > MAX_BYTES) return { policy: null, warnings: ['is larger than 64 KB'] };
  let raw;
  try { raw = JSON.parse(text); } catch { return { policy: null, warnings: ['is not valid JSON'] }; }
  return normalize(raw);
}

/** The repo a folder belongs to: the nearest folder up with a policy file or .git, else the folder itself. */
function findRepo(cwd, { existsSync = fs.existsSync } = {}) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (existsSync(path.join(dir, REPO_FILE))) return { root: dir, policyFile: path.join(dir, REPO_FILE) };
    if (existsSync(path.join(dir, '.git'))) return { root: dir, policyFile: null };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { root: path.resolve(cwd), policyFile: null };
}

/**
 * The policy a session in `cwd` is under.
 * → {policy|null, source: 'repo'|'default'|null, file|null, root, warnings[]}
 */
function loadFor({ rootDir, cwd, existsSync, readFileSync }) {
  const repo = findRepo(cwd, { existsSync });
  const warnings = [];
  if (repo.policyFile) {
    const r = readPolicyFile(repo.policyFile, { readFileSync });
    if (r.policy) return { policy: r.policy, source: 'repo', file: repo.policyFile, root: repo.root, warnings: r.warnings.map((w) => `${REPO_FILE} ${w}; that part is ignored.`) };
    if (!r.missing) warnings.push(`${REPO_FILE} ${r.warnings[0] || 'is not usable'}, so it is ignored.`);
  }
  if (rootDir) {
    const file = path.join(rootDir, DEFAULT_FILE);
    const r = readPolicyFile(file, { readFileSync });
    if (r.policy) return { policy: r.policy, source: 'default', file, root: repo.root, warnings: warnings.concat(r.warnings.map((w) => `Your default policy ${w}; that part is ignored.`)) };
    if (!r.missing) warnings.push(`Your default policy ${r.warnings[0] || 'is not usable'}, so it is ignored.`);
  }
  return { policy: null, source: null, file: null, root: repo.root, warnings };
}

// ── Patterns ────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** A glob as a regex. Paths: * stays in one folder, ** crosses them. Commands: * is anything. */
function globRe(glob, { paths = false } = {}) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (paths && glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?'; } else out += '.*';
      } else out += paths ? '[^/]*' : '.*';
    } else if (c === '?') out += paths ? '[^/]' : '.';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`, paths ? '' : 's');
}

/** `Tool` or `Tool(argument glob)`; the tool name may use * (mcp__github__*). */
function parsePattern(p) {
  const m = /^([A-Za-z0-9_*.-]+)(?:\((.*)\))?$/s.exec(p.trim());
  return m ? { tool: m[1], arg: m[2] === undefined ? null : m[2] } : null;
}

/** Whether a protected-path glob covers `abs`: a glob without / matches the name anywhere. */
function pathMatches(glob, abs, root) {
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '/**');
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!g.includes('/')) {
    const re = globRe(g, { paths: true });
    return (inside ? rel.split('/') : [path.basename(abs)]).some((seg) => re.test(seg));
  }
  if (g.startsWith('/') || g.startsWith('~')) return globRe(g.replace(/^~/, os.homedir()), { paths: true }).test(abs);
  if (!inside) return false;
  const re = globRe(g, { paths: true });
  return re.test(rel) || (g.startsWith('**/') ? false : globRe(`**/${g}`, { paths: true }).test(rel));
}

// ── Shell commands ──────────────────────────────────────────────────────────

/** Splits a command line into simple commands (on && || ; | & and newlines, outside quotes), including $(…) and `…` bodies. */
function splitCommands(cmd) {
  const out = [];
  const subs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i += 1; continue; }
      if (c === q) q = null;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i += 1; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|') {
      if (c === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) { cur += c; continue; }
      out.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i += 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) subs.push(...splitCommands(m[1] ?? m[2]));
  return out.concat(subs).map((s) => s.trim().replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '').trim()).filter(Boolean);
}

/** Words of a simple command, quotes removed; leading VAR=value and sudo/env/command wrappers dropped. */
function words(simple) {
  const out = [];
  for (const m of simple.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'\\]|\\.)+)/g)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3].replace(/\\(.)/g, '$1'));
  }
  while (out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) || ['sudo', 'env', 'command', 'nohup', 'time', 'exec'].includes(out[0]))) out.shift();
  return out;
}

const normalized = (simple) => words(simple).join(' ');

/** Files a simple command would write or delete, as given (unresolved). */
function writeTargets(w, raw) {
  const targets = [];
  for (const m of raw.matchAll(/(?:^|[^0-9&>])>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
    const t = m[1].replace(/^["']|["']$/g, '');
    if (t !== '/dev/null' && !t.startsWith('&')) targets.push(t);
  }
  const cmd = path.basename(w[0] || '');
  const args = w.slice(1).filter((a) => !a.startsWith('-'));
  if (['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'touch', 'chmod', 'chown', 'tee'].includes(cmd)) targets.push(...(cmd === 'chmod' || cmd === 'chown' ? args.slice(1) : args));
  if (['mv', 'cp', 'ln', 'install', 'rsync'].includes(cmd)) targets.push(...(cmd === 'mv' ? args : args.slice(-1)));
  if ((cmd === 'sed' || cmd === 'perl') && w.some((a) => /^-[a-zA-Z]*i/.test(a))) targets.push(...args.slice(1));
  if (cmd === 'dd') for (const a of w) if (a.startsWith('of=')) targets.push(a.slice(3));
  return targets;
}

const WRITE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'ln', 'install', 'touch', 'mkdir', 'tee', 'truncate', 'dd', 'chmod', 'chown', 'patch', 'rsync']);
const GIT_WRITES = new Set(['commit', 'push', 'add', 'rm', 'mv', 'reset', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'revert', 'stash', 'tag', 'clean', 'apply', 'am', 'pull', 'init', 'clone', 'worktree', 'update-ref', 'filter-branch', 'gc', 'prune']);
const PKG_WRITES = /^(?:npm|pnpm|yarn|bun|pip3?|gem|cargo|brew|go)$/;
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'http', 'https', 'xh', 'gh', 'aria2c', 'ping', 'dig', 'nslookup']);
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule']);
const PKG_NETWORK = new Set(['install', 'i', 'add', 'update', 'upgrade', 'publish', 'ci', 'fetch', 'download', 'get']);

function gitSub(w) {
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(w[i]) ? 2 : 1;
  return w[i] || '';
}

function readOnlyBreach(w, raw) {
  const cmd = path.basename(w[0] || '');
  if (writeTargets(w, raw).length) return `writing files ("${cmd}")`;
  if (WRITE_COMMANDS.has(cmd)) return `"${cmd}" changes files`;
  if (cmd === 'git' && GIT_WRITES.has(gitSub(w))) return `"git ${gitSub(w)}" changes the repo`;
  if (cmd === 'git' && gitSub(w) === 'branch' && w.some((a) => /^-[dDmM]$|^--(?:delete|move)$/.test(a))) return '"git branch" changes the repo';
  if (cmd === 'find' && w.some((a) => ['-delete', '-exec', '-execdir', '-ok'].includes(a))) return '"find" with -delete or -exec';
  if (PKG_WRITES.test(cmd) && w[1] && /^(?:install|i|add|remove|rm|uninstall|update|upgrade|publish|ci|link|unlink|get)$/.test(w[1])) return `"${cmd} ${w[1]}" changes packages`;
  return null;
}

function networkBreach(w) {
  const cmd = path.basename(w[0] || '');
  if (NETWORK_COMMANDS.has(cmd)) return `"${cmd}" reaches the network`;
  if (cmd === 'git' && GIT_NETWORK.has(gitSub(w))) return `"git ${gitSub(w)}" reaches the network`;
  if (PKG_WRITES.test(cmd) && PKG_NETWORK.has(w[1])) return `"${cmd} ${w[1]}" reaches the network`;
  return null;
}

/** rm/rmdir/unlink/shred targets outside the repo (or not knowable: $VAR, globs at /). */
function rmOutside(w, cwd, root, home) {
  const cmd = path.basename(w[0] || '');
  if (!['rm', 'rmdir', 'unlink', 'shred'].includes(cmd)) return null;
  for (const a of w.slice(1)) {
    if (a.startsWith('-') && a !== '-') continue;
    if (/[$`]/.test(a)) return a;
    const expanded = a === '~' ? home : a.startsWith('~/') ? path.join(home, a.slice(2)) : a;
    const abs = path.resolve(cwd, expanded);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return a;
  }
  return null;
}

// ── Deciding ────────────────────────────────────────────────────────────────

const argOf = (tool, input) => {
  if (!isObj(input)) return '';
  if (tool === 'Bash') return typeof input.command === 'string' ? input.command : '';
  for (const k of ['file_path', 'notebook_path', 'path', 'url', 'query', 'pattern']) if (typeof input[k] === 'string') return input[k];
  return '';
};

function toolMatches(pat, tool) {
  return pat.tool === tool || (pat.tool.includes('*') && globRe(pat.tool).test(tool));
}

/** A Bash pattern covers a command when it covers every simple command in it. */
function patternHits(pat, tool, input, { every }) {
  if (!toolMatches(pat, tool)) return false;
  if (pat.arg === null) return true;
  const re = globRe(pat.arg.trim());
  if (tool !== 'Bash') return re.test(argOf(tool, input));
  const cmds = splitCommands(argOf(tool, input)).map(normalized);
  if (!cmds.length) return false;
  return every ? cmds.every((c) => re.test(c)) : cmds.some((c) => re.test(c));
}

/**
 * → the rule that refuses this tool call, or null. Plain words: it ends up
 * after "Blocked by policy: ".
 */
function checkTool(policy, { tool, input, cwd, root, home = os.homedir() }) {
  if (!policy || typeof tool !== 'string' || NEVER_GATED.has(tool)) return null;
  const deny = (policy.tools?.deny || []).map((s) => [s, parsePattern(s)]).filter(([, p]) => p);
  for (const [, p] of deny) if (patternHits(p, tool, input, { every: false })) return p.arg === null ? `the ${tool} tool is denied` : `${p.tool} "${p.arg}" is denied`;
  const allow = (policy.tools?.allow || []).map(parsePattern).filter(Boolean);
  if (allow.length) {
    const bare = allow.some((p) => p.arg === null && toolMatches(p, tool));
    if (!bare) {
      const scoped = allow.filter((p) => p.arg !== null && toolMatches(p, tool));
      const ok = tool === 'Bash'
        ? splitCommands(argOf(tool, input)).map(normalized).every((c) => scoped.some((p) => globRe(p.arg.trim()).test(c)))
        : scoped.some((p) => globRe(p.arg.trim()).test(argOf(tool, input)));
      if (!scoped.length || !ok) return `${tool}${tool === 'Bash' ? ` (${argOf(tool, input).slice(0, 80)})` : ''} is not on the allowed list`;
    }
  }
  const base = cwd || root;
  // A session must not be able to rewrite the policy it is under.
  const guarded = (policy.protectedPaths || []).concat('.plexiform/**');
  if (policy.readOnly && EDIT_TOOLS.has(tool)) return `read-only: no file edits (${tool})`;
  if (policy.network === false && NETWORK_TOOLS.has(tool)) return `no network tools (${tool})`;
  if (EDIT_TOOLS.has(tool)) {
    const f = argOf(tool, input);
    if (f) {
      const abs = path.resolve(base, f);
      const hit = guarded.find((g) => pathMatches(g, abs, root));
      if (hit) return `${path.relative(root, abs) || f} is a protected path (${hit})`;
    }
  }
  if (tool === 'Bash') {
    const cmd = argOf(tool, input);
    for (const simple of splitCommands(cmd)) {
      const w = words(simple);
      if (!w.length) continue;
      if (policy.denyRmOutsideRepo) {
        const out = rmOutside(w, base, root, home);
        if (out) return `no deleting outside this repo (${out})`;
      }
      if (policy.readOnly) { const why = readOnlyBreach(w, simple); if (why) return `read-only: ${why}`; }
      if (policy.network === false) { const why = networkBreach(w); if (why) return `no network: ${why}`; }
      for (const t of writeTargets(w, simple)) {
        const abs = path.resolve(base, t.replace(/^~(?=\/|$)/, home));
        const hit = guarded.find((g) => pathMatches(g, abs, root));
        if (hit) return `${t} is a protected path (${hit})`;
      }
    }
  }
  return null;
}

// The detectors live in src/ (inside app.asar when packaged, beside hooks/ in a checkout).
function loadDetectors() {
  let Scrub = null;
  let Patterns = null;
  try { Scrub = require('../app.asar/src/scrub.js'); } catch { try { Scrub = require('../src/scrub.js'); } catch { Scrub = null; } }
  try { Patterns = require('../app.asar/src/secret-patterns.js'); } catch { try { Patterns = require('../src/secret-patterns.js'); } catch { Patterns = null; } }
  return Scrub && Patterns ? { maskPii: Scrub.maskPii, findSecrets: Patterns.findSecrets } : null;
}

const PII_TAGS = [['[sa-id]', 'a South African ID number'], ['[iban]', 'an IBAN'], ['[card]', 'a card number'], ['[passport]', 'a passport MRZ line'], ['[ssn]', 'a US Social Security number'], ['[nino]', 'a UK National Insurance number']];
const count = (s, needle) => s.split(needle).length - 1;

/** What a prompt contains that the policy cares about. → {secrets: [kind], pii: [label]} */
function scanPrompt(text, detectors) {
  const out = { secrets: [], pii: [] };
  if (typeof text !== 'string' || !text) return out;
  const t = text.slice(0, 200000);
  for (const h of detectors.findSecrets(t, { classes: ['credential', 'likely'] })) if (!out.secrets.includes(h.kind)) out.secrets.push(h.kind);
  const masked = detectors.maskPii(t);
  for (const [tag, label] of PII_TAGS) if (count(masked, tag) > count(t, tag)) out.pii.push(label);
  return out;
}

/** → {action: 'deny'|'warn', rule} | {action: 'warn', rule, unchecked: true} | null */
function checkPrompt(policy, prompt, { detectors = undefined } = {}) {
  const want = { secrets: policy?.prompts?.secrets || 'off', pii: policy?.prompts?.pii || 'off' };
  if (want.secrets === 'off' && want.pii === 'off') return null;
  const d = detectors === undefined ? loadDetectors() : detectors;
  if (!d) return { action: 'warn', rule: 'the secret and personal-number checks could not load, so this prompt was not checked', unchecked: true };
  const found = scanPrompt(prompt, d);
  const parts = [];
  let action = null;
  if (want.secrets !== 'off' && found.secrets.length) { parts.push(`never put secrets in prompts (found ${found.secrets.join(', ').replace(/_/g, ' ')})`); action = want.secrets; }
  if (want.pii !== 'off' && found.pii.length) { parts.push(`no personal numbers in prompts (found ${found.pii.join(', ')})`); action = action === 'deny' ? 'deny' : want.pii; }
  return parts.length ? { action, rule: parts.join('; ') } : null;
}

/** → the reason the repo's daily cap refuses this call, or null. Stale or missing: allow. */
function readSpendGate(rootDir, root, { now = Date.now(), readFileSync = fs.readFileSync } = {}) {
  try {
    const text = readFileSync(path.join(rootDir, SPEND_FILE), 'utf8');
    if (typeof text !== 'string' || text.length > MAX_BYTES) return null;
    const g = JSON.parse(text);
    if (!isObj(g) || g.v !== 1 || !Number.isFinite(g.at) || !isObj(g.repos)) return null;
    const ttl = Number.isFinite(g.ttlMs) ? Math.min(Math.max(g.ttlMs, 0), MAX_TTL_MS) : 0;
    if (g.at > now + CLOCK_SKEW_MS || now - g.at > ttl) return null;
    const r = Object.prototype.hasOwnProperty.call(g.repos, root) ? g.repos[root] : null;
    return typeof r === 'string' && r.trim() ? r.trim().slice(0, 200) : null;
  } catch { return null; }
}

const where = (loaded) => (loaded.source === 'repo' ? `"${loaded.policy.name}" in ${REPO_FILE}` : `your default policy "${loaded.policy.name}"`);
const HOW_TO_CHANGE = 'Change it in Plexiform → Settings → Privacy and data → Policies.';

/** The plain explanation shown for a refused call or prompt. */
function denyMessage(rule, loaded) {
  return `Blocked by policy: ${rule}. (${where(loaded)}; ${HOW_TO_CHANGE})`;
}

const safeId = (id) => (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) ? id.replace(/:/g, '_') : null);

/** Leaves the latest refusal where the Running now page can show it. Best effort. */
function recordBlock(rootDir, sessionId, entry, { now = Date.now() } = {}) {
  const id = safeId(sessionId);
  if (!rootDir || !id) return;
  try {
    const dir = path.join(rootDir, BLOCKS_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: now, ...entry }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* the refusal itself still stands */ }
}

/**
 * → the hook output for this event, or null (allow, nothing to say).
 * {rootDir, signal: 'tool-use'|'prompt-submit', data, now?, home?, detectors?, record?}
 * For a prompt, `block: true` on the result means the prompt is refused.
 */
function decide({ rootDir, signal, data, now = Date.now(), home = os.homedir(), detectors, record = true } = {}) {
  try {
    if (signal !== 'tool-use' && signal !== 'prompt-submit') return null;
    const cwd = typeof data?.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
    const loaded = loadFor({ rootDir, cwd });
    if (!loaded.policy) {
      return signal === 'prompt-submit' && loaded.warnings.length ? { systemMessage: `Plexiform policy: ${loaded.warnings.join(' ')}` } : null;
    }
    const note = (rule, extra = {}) => record && recordBlock(rootDir, data?.session_id, { rule, policy: loaded.policy.name, source: loaded.source, ...extra }, { now });
    if (signal === 'tool-use') {
      const tool = typeof data?.tool_name === 'string' ? data.tool_name : null;
      if (!tool || NEVER_GATED.has(tool)) return null;
      let rule = checkTool(loaded.policy, { tool, input: data?.tool_input, cwd, root: loaded.root, home });
      if (!rule && loaded.policy.dailySpendCapUsd) rule = readSpendGate(rootDir, loaded.root, { now });
      if (!rule) return null;
      note(rule, { tool });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMessage(rule, loaded) } };
    }
    const warn = loaded.warnings.length ? `Plexiform policy: ${loaded.warnings.join(' ')}` : null;
    const hit = checkPrompt(loaded.policy, data?.prompt, { detectors });
    if (hit?.action === 'deny') {
      note(hit.rule, { tool: 'prompt' });
      return { decision: 'block', reason: denyMessage(hit.rule, loaded), block: true };
    }
    const lines = [warn, hit ? `Policy warning: ${hit.rule}. (${where(loaded)})` : null].filter(Boolean);
    return lines.length ? { systemMessage: lines.join(' ') } : null;
  } catch { return null; }
}

/** The hook output as Claude Code reads it (decide's own flags dropped). */
function hookOutput(out) {
  if (!out || out.block === undefined) return out || null;
  const rest = { ...out };
  delete rest.block;
  return rest;
}

module.exports = {
  decide, hookOutput, loadFor, findRepo, readPolicyFile, normalize, checkTool, checkPrompt, scanPrompt, readSpendGate,
  recordBlock, denyMessage, splitCommands, words, globRe, parsePattern, pathMatches, loadDetectors,
  REPO_FILE, DEFAULT_FILE, SPEND_FILE, BLOCKS_DIR, MAX_TTL_MS, safeId,
};
