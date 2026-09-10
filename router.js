#!/usr/bin/env node
// The launcher's brain: picks the model for a new Claude Code session, once,
// before it starts. Never mid-session — each model keeps its own prompt
// cache, so switching halfway would pay to rebuild it.
//
//   node router.js decide [--sh] [--home <dir>] [--config <file>] --cwd <dir> -- <claude args…>
//
// prints {model, reason, policy} (or `model|reason` with --sh, for the shim)
// and appends the decision to <home>/router/decisions.jsonl. It reads only
// config.json and the small history.json the app refreshes; it must never
// scan transcripts itself, because it runs in front of every `claude`.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODELS = ['opus', 'sonnet', 'haiku'];
const POLICIES = ['frugal', 'balanced', 'quality'];
const DAY_MS = 86400000;
// After you switch a session up to a pricier model in a project, the router
// stops picking the cheap one there for this long.
const LEARN_MS = 7 * DAY_MS;
// Balanced calls a project light when its median session is under this many
// main-thread turns (assistant messages, so each tool round-trip counts).
const LIGHT_TURNS = 40;
const SHORT_PROMPT = 400;
const NAMES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

// Folder name, the same convention as the rules' project scope.
function projectKey(cwd) {
  return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// Flags that take a value, so the value isn't mistaken for the prompt.
const VALUE_FLAGS = new Set(['--model', '-m', '--resume', '-r', '--session-id', '--settings', '--permission-mode', '--output-format', '--input-format', '--mcp-config', '--append-system-prompt', '--system-prompt', '--fallback-model', '--max-turns', '--agent', '--agents', '--setting-sources', '--from-pr']);
// Continuing an existing conversation: it already has a model and a cache.
const RESUME_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--from-pr']);
const INFO_FLAGS = new Set(['--version', '-v', '--help', '-h']);
const SUBCOMMANDS = new Set(['mcp', 'config', 'update', 'doctor', 'install', 'migrate-installer', 'setup-token', 'plugin', 'plugins', 'agents', 'api-key', 'auth', 'login', 'logout']);

function parseArgs(args = []) {
  const out = { model: false, print: false, resume: false, info: false, subcommand: null, prompt: null };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    const flag = a.split('=')[0];
    if (flag === '--model' || flag === '-m') out.model = true;
    if (a === '-p' || a === '--print') out.print = true;
    if (RESUME_FLAGS.has(flag)) out.resume = true;
    if (INFO_FLAGS.has(a)) out.info = true;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a) && !a.includes('=')) i += 1;
      continue;
    }
    if (i === 0 && SUBCOMMANDS.has(a)) out.subcommand = a;
    positional.push(a);
  }
  // Variadic flags (--add-dir a b) leave short values behind; the prompt is
  // the longest positional.
  out.prompt = positional.length ? positional.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  return out;
}

const isShort = (prompt) => typeof prompt === 'string' && prompt.length < SHORT_PROMPT && !prompt.includes('```');

function lookup(map, key) {
  if (!map || typeof map !== 'object' || !key) return undefined;
  if (key in map) return map[key];
  const k = Object.keys(map).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : map[k];
}

const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// → { model: 'opus'|'sonnet'|'haiku'|null, reason, policy }. null means
// "don't touch": claude runs exactly as typed.
function decide({ cwd = '', args = [], env = {}, history = null, config = {}, now = Date.now() } = {}) {
  const policy = POLICIES.includes(config.routerPolicy) ? config.routerPolicy : 'balanced';
  const res = (model, reason) => ({ model, reason, policy });
  const a = parseArgs(args);
  const off = String(env.CLAUDE_TRAFFIC_LIGHT_ROUTER || '').toLowerCase();
  if (['off', '0', 'false', 'no'].includes(off)) return res(null, 'CLAUDE_TRAFFIC_LIGHT_ROUTER=off');
  if (a.model) return res(null, 'you picked the model (--model)');
  if (env.ANTHROPIC_MODEL) return res(null, 'you picked the model (ANTHROPIC_MODEL)');
  if (a.resume) return res(null, 'resuming a session keeps its model');
  if (a.info || a.subcommand) return res(null, 'not a session');

  const key = projectKey(cwd);
  const override = lookup(config.routerProjects, key);
  if (MODELS.includes(override)) return res(override, `${key} is set to ${NAMES[override]}`);

  if (a.print && isShort(a.prompt)) {
    return policy === 'frugal' ? res('haiku', 'short one-shot prompt (-p)') : res('sonnet', 'short one-shot prompt (-p)');
  }

  const h = lookup(history && history.projects, key) || null;
  const escalatedAt = h && h.lastEscalationAt && now - h.lastEscalationAt < LEARN_MS ? h.lastEscalationAt : null;
  if (policy === 'quality') return res('opus', 'quality-first policy');
  if (escalatedAt) return res('opus', `you switched up to a pricier model in ${key} on ${dateOf(escalatedAt)}`);
  if (policy === 'frugal') return res('sonnet', 'frugal policy');
  const n = Number(config.routerLightTurns) > 0 ? Number(config.routerLightTurns) : LIGHT_TURNS;
  if (!h || !h.sessions) return res('opus', `no history for ${key || 'this folder'} in 7d`);
  if (h.medianTurns < n) return res('sonnet', `light project (median ${Math.round(h.medianTurns)} turns over ${h.sessions} session${h.sessions === 1 ? '' : 's'}), no escalations in 7d`);
  return res('opus', `heavy project (median ${Math.round(h.medianTurns)} turns)`);
}

// What decisions.jsonl keeps of the command line: every flag, but at most
// 80 characters of anything that could be prompt text.
function summariseArgs(args = []) {
  let budget = 80;
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a.startsWith('-')) {
      out.push(a.split('=')[0]);
      if (VALUE_FLAGS.has(a) && i + 1 < args.length && !/prompt/.test(a)) { out.push(String(args[i + 1]).slice(0, 40)); i += 1; }
      else if (/prompt/.test(a)) i += 1;
      continue;
    }
    if (budget <= 0) { out.push('…'); break; }
    const cut = a.slice(0, budget);
    budget -= cut.length;
    out.push(JSON.stringify(cut.length < a.length ? `${cut}…` : cut));
  }
  return out.join(' ');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const MAX_LOG_BYTES = 512 * 1024;
function appendDecision(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, `${lines.slice(-500).join('\n')}\n`);
    }
  } catch { /* no log yet */ }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function readDecisions(file, n = 20) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n').filter(Boolean).slice(-n)) {
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out.reverse();
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'decide') { process.stderr.write('usage: router.js decide [--sh] [--home dir] [--config file] --cwd dir -- <claude args>\n'); return 2; }
  const sep = rest.indexOf('--');
  const opts = sep < 0 ? rest : rest.slice(0, sep);
  const args = sep < 0 ? [] : rest.slice(sep + 1);
  const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : null; };
  const home = opt('--home') || process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
  const cwd = opt('--cwd') || process.cwd();
  const config = readJson(opt('--config') || path.join(home, 'config.json')) || {};
  const history = readJson(path.join(home, 'router', 'history.json'));
  const d = decide({ cwd, args, env: process.env, history, config });
  try {
    appendDecision(path.join(home, 'router', 'decisions.jsonl'), { at: new Date().toISOString(), cwd, model: d.model, reason: d.reason, policy: d.policy, args_summary: summariseArgs(args) });
  } catch { /* the log must never stop claude starting */ }
  const reason = String(d.reason).replace(/[\r\n|]/g, ' ');
  process.stdout.write(opts.includes('--sh') ? `${d.model || ''}|${reason}\n` : `${JSON.stringify(d)}\n`);
  return 0;
}

module.exports = { MODELS, POLICIES, LEARN_MS, LIGHT_TURNS, SHORT_PROMPT, projectKey, parseArgs, decide, summariseArgs, appendDecision, readDecisions, cli };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
