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

// ── Learning: what each project's switch-ups say about it ─────────────────
// history.json carries, per project, the last LEARN_DAYS of main-thread
// sessions and, for each one you switched up in, how far in that happened.
// Turns are assistant messages, so every tool round-trip counts: turn 5 is
// still roughly your first prompt or two.
const LEARN_DAYS = 14;
const LEARN_EARLY_TURN = 5;
const LEARN_LATE_TURN = 20;
// The share of sessions that must switch up before the project is treated
// as quality-first. The earlier the switch-up, the less of the session the
// cheap model handled, so the fewer it takes: a switch-up at turn 2 is a
// cheap start wasted, one at turn 30 is a cheap session that needed one
// hard turn — cheaper than Opus throughout until half of them do it.
const LEARN_RATE_EARLY = 0.15;
const LEARN_RATE = 0.30;
const LEARN_RATE_LATE = 0.50;
// This many sessions without a single switch-up earns Haiku for short -p
// prompts even under balanced.
const LEARN_CLEAN_SESSIONS = 20;

function medianOf(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// `learn`: { sessions, escalations: [{ turn, minutes }] } over LEARN_DAYS,
// counting only sessions that started on Sonnet or Haiku (cheap-start).
// → { tier: 'quality'|'cheap'|'neutral', label, rate, sessions, escalations,
// medianTurn, medianMinutes, timing }. `label` (null when there's nothing to
// say) is what decide() puts in its reason and the Projects table shows.
function learnProjectTier(learn) {
  const sessions = Math.max(0, Number(learn && learn.sessions) || 0);
  const escs = Array.isArray(learn && learn.escalations) ? learn.escalations.filter((e) => e && Number(e.turn) > 0) : [];
  const n = Math.min(escs.length, sessions);
  const out = { tier: 'neutral', label: null, rate: 0, sessions, escalations: n, medianTurn: null, medianMinutes: null, timing: null };
  if (!sessions) return out;
  if (!n) {
    if (sessions >= LEARN_CLEAN_SESSIONS) return { ...out, tier: 'cheap', label: `learned: cheap (no switch-ups in ${plural(sessions, 'cheap-start session')})` };
    return out;
  }
  const rate = n / sessions;
  const medianTurn = medianOf(escs.map((e) => Number(e.turn)));
  const mins = escs.map((e) => Number(e.minutes)).filter((m) => Number.isFinite(m) && m >= 0);
  const timing = medianTurn <= LEARN_EARLY_TURN ? 'early' : medianTurn >= LEARN_LATE_TURN ? 'late' : 'mid';
  const threshold = { early: LEARN_RATE_EARLY, mid: LEARN_RATE, late: LEARN_RATE_LATE }[timing];
  const pct = `${Math.round(rate * 100)}%`;
  const when = `usually by turn ${Math.round(medianTurn)}${mins.length ? `, ~${Math.round(medianOf(mins))} min in` : ''}`;
  const base = { ...out, rate, medianTurn, medianMinutes: mins.length ? medianOf(mins) : null, timing };
  if (rate >= threshold) return { ...base, tier: 'quality', label: `learned: quality (${pct} escalation rate, ${plural(sessions, 'cheap-start session')}; ${when})` };
  const how = timing === 'late' ? 'late — the cheap model did most of the work' : timing === 'early' ? 'rarely' : 'occasionally';
  return { ...base, label: `learned: cheap is fine (${n} of ${plural(sessions, 'cheap-start session')} switched up, ${how}; ${when})` };
}

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

  const h = lookup(history && history.projects, key) || null;
  // A history.json from before learning has no `learn`: the old rule — any
  // switch-up in the last 7 days means Opus — still applies to it.
  const learned = h && h.learn ? learnProjectTier(h.learn) : null;
  const tier = learned ? learned.tier : 'neutral';
  const why = (reason) => (learned && learned.label ? `${reason}; ${learned.label}` : reason);

  if (a.print && isShort(a.prompt)) {
    const short = 'short one-shot prompt (-p)';
    if (policy === 'quality' || tier === 'quality') return res('sonnet', policy === 'quality' ? short : why(short));
    if (policy === 'frugal') return res('haiku', short);
    return tier === 'cheap' ? res('haiku', why(short)) : res('sonnet', short);
  }

  const escalatedAt = !learned && h && h.lastEscalationAt && now - h.lastEscalationAt < LEARN_MS ? h.lastEscalationAt : null;
  if (policy === 'quality') return res('opus', 'quality-first policy');
  if (tier === 'quality') return res('opus', learned.label);
  if (escalatedAt) return res('opus', `you switched up to a pricier model in ${key} on ${dateOf(escalatedAt)}`);
  if (policy === 'frugal') return res('sonnet', why('frugal policy'));
  const n = Number(config.routerLightTurns) > 0 ? Number(config.routerLightTurns) : LIGHT_TURNS;
  if (!h || !h.sessions) return res('opus', why(`no history for ${key || 'this folder'} in 7d`));
  const light = `light project (median ${Math.round(h.medianTurns)} turns over ${plural(h.sessions, 'session')})`;
  if (h.medianTurns < n) return res('sonnet', learned && learned.label ? why(light) : `${light}, no escalations in ${learned ? LEARN_DAYS : 7}d`);
  return res('opus', why(`heavy project (median ${Math.round(h.medianTurns)} turns)`));
}

// ── Sessions that are already open ─────────────────────────────────────────
// Cheapest first. The router never switches a running session itself; it
// only says when the pick for it now is cheaper than what it runs on.
const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

// 'claude-sonnet-4-5-20250929' → 'sonnet'; anything else → null.
function family(model) {
  const m = String(model || '').toLowerCase();
  return Object.keys(RANK).find((k) => m.includes(k)) || null;
}

// → { model, reason } when decide() would start this session on a cheaper
// model than `current`, else null.
function advise({ current, cwd = '', route = null, escalated = false, history = null, config = {}, now = Date.now() } = {}) {
  const cur = family(current);
  if (!cur || escalated) return null;
  // You moved this session up from the router's pick: that choice stands.
  if (route && RANK[route.model] && RANK[cur] > RANK[route.model]) return null;
  const pick = decide({ cwd, args: [], env: {}, history, config, now });
  if (!pick.model || RANK[pick.model] >= RANK[cur]) return null;
  return { model: pick.model, reason: pick.reason };
}

// The session's model moved down: you took the advice (or /model'd anyway).
function switchedDown(prev, next) {
  const a = family(prev);
  const b = family(next);
  return !!a && !!b && RANK[b] < RANK[a];
}

// The Router's status line. `sessions`: the open Claude Code sessions, each
// { delegating, advice: { model } | null }.
function summaryLine({ launcher = false, delegation = false, sessions = [] } = {}) {
  if (!launcher && !delegation) return 'Off — claude starts on its usual model and reads files whole';
  const n = sessions.length;
  const parts = [];
  if (delegation) {
    const d = sessions.filter((s) => s.delegating).length;
    if (d) parts.push(`${d} delegating now`);
    if (n - d) parts.push(`${n - d} from ${n - d === 1 ? 'its' : 'their'} next tool call`);
  }
  const advised = {};
  for (const s of sessions) if (s.advice && NAMES[s.advice.model]) advised[s.advice.model] = (advised[s.advice.model] || 0) + 1;
  for (const [m, c] of Object.entries(advised)) parts.push(`${c} advised to switch to ${NAMES[m]}`);
  const open = n ? `${n} open session${n === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}` : 'no open sessions';
  return ['On', open, launcher ? 'new sessions pick their model automatically' : 'new sessions start on their usual model'].join(' · ');
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

module.exports = { MODELS, POLICIES, LEARN_MS, LIGHT_TURNS, SHORT_PROMPT, RANK, LEARN_DAYS, LEARN_EARLY_TURN, LEARN_LATE_TURN, LEARN_RATE_EARLY, LEARN_RATE, LEARN_RATE_LATE, LEARN_CLEAN_SESSIONS, learnProjectTier, projectKey, parseArgs, decide, family, advise, switchedDown, summaryLine, summariseArgs, appendDecision, readDecisions, cli };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
