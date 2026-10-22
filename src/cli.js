'use strict';

// The `plexiform` command (bin/plexiform.js). Everything it shows comes from
// the same read-only functions the MCP server uses (mcp-server.js): the data
// folder on disk, plus the running app's loopback GET /status when it is up.
// It writes nothing except a handover copy the person asks for with --out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Mcp = require('../mcp-server.js');
const Rules = require('../rules.js');
const Tap = require('../hooks/handover-tap.js');
const GhosttyDock = require('./ghostty-dock.js');

const EXIT = { OK: 0, NOT_RUNNING: 1, ERROR: 2 };
const DEFAULT_PORT = 47172;

const COMMANDS = {
  status: { flags: ['short'], about: 'traffic-light state and what needs you' },
  sessions: { flags: ['all'], about: 'running sessions (--all includes the ones the widget ignores)' },
  spend: { flags: ['today', 'week', 'short'], about: 'spend today and this week (--today or --week for one)' },
  handover: { flags: ['force'], values: ['out'], about: 'print a session\'s handover doc, or write it with --out <file>' },
  waiting: { flags: ['short'], about: 'permission prompts, plan approvals and questions waiting on you' },
  doctor: { flags: [], about: 'is the app running, is the hook connected' },
  help: { flags: [], about: 'this help' },
};

const USAGE = `Usage: plexiform <command> [options]

Commands:
${Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(10)}${c.about}`).join('\n')}

Options:
  --json     machine-readable output
  --short    one line (status, waiting, spend)

Exit codes: 0 ok, 1 Plexiform is not running (status, sessions, waiting and
doctor still answer from the data folder on disk and say so), 2 error.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { command: null, json: false, flags: {}, values: {}, positional: [] };
  const rest = [];
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') args.flags.help = true;
    else rest.push(a);
  }
  if (!rest.length) { args.command = 'help'; return args; }
  args.command = rest.shift();
  const spec = COMMANDS[args.command];
  if (!spec) throw new UsageError(`unknown command "${args.command}"`);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { args.positional.push(a); continue; }
    if ((spec.values || []).includes(m[1])) {
      const v = m[2] !== undefined ? m[2] : rest[++i];
      if (v === undefined || v === '') throw new UsageError(`--${m[1]} needs a value`);
      args.values[m[1]] = v;
    } else if (spec.flags.includes(m[1]) && m[2] === undefined) args.flags[m[1]] = true;
    else throw new UsageError(`unknown option ${a} for ${args.command}`);
  }
  if (args.flags.today && args.flags.week) throw new UsageError('use --today or --week, not both');
  if (args.command === 'handover' && args.positional.length > 1) throw new UsageError('handover takes one session id');
  if (args.command !== 'handover' && args.positional.length) throw new UsageError(`unexpected argument "${args.positional[0]}"`);
  if (args.flags.help) args.command = 'help';
  return args;
}

function portOf(root, env) {
  try { const p = Number(fs.readFileSync(path.join(root, 'port'), 'utf8').trim()); if (p > 0 && p < 65536) return p; } catch { /* app not running */ }
  return Number(env.CLAUDE_TRAFFIC_LIGHT_PORT) || DEFAULT_PORT;
}

function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const tilde = (p, home) => (p && home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p);

function slimSession(s) {
  return {
    sessionId: s.sessionId,
    project: Rules.folderOf(s.cwd) || null,
    cwd: s.cwd,
    source: s.source,
    signal: s.presented || s.signal,
    askKind: s.askKind || null,
    tool: s.tool,
    updatedAt: s.updatedAt,
    ageMs: s.ageMs,
  };
}

const NEEDS = {
  'permission-ask': (s) => (s.askKind === 'question' ? 'asking you a question' : s.askKind === 'plan' ? 'waiting for plan approval' : 'waiting for permission'),
  'limit-hit': () => 'hit a usage limit',
  'idle-nudge': () => 'idle since its turn',
  stop: () => 'finished its turn',
  'turn-failed': () => 'turn failed',
};
// Home's "Needs you" card and the widget's waiting list: permission prompts,
// plan approvals and questions still open. A finished turn is ready for
// review, not waiting on you.
const READY_FOR_REVIEW = new Set(['stop', 'idle-nudge', 'turn-failed']);
const needLabel = (s) => (NEEDS[s.signal] ? NEEDS[s.signal](s) : s.signal);
const sessionLine = (s) => `  ${(s.project || '(no folder)').padEnd(22)} ${needLabel(s).padEnd(24)} ${String(s.source || '').padEnd(8)} ${String(s.sessionId || '').slice(0, 8)}  ${ago(s.ageMs)} ago`;

function appInfo(live, port) {
  return live ? { running: true, port } : { running: false, port };
}

function notRunningNote(root, home) {
  const exists = fs.existsSync(root);
  return exists
    ? `Plexiform is not running: read from ${tilde(root, home)} on disk.`
    : `Plexiform is not running, and there is no data folder at ${tilde(root, home)}.`;
}

async function liveSessions(ctx) {
  return Mcp.buddySessions({ root: ctx.root, now: ctx.now }).sessions;
}

function waitingOn(ctx, live) {
  const pending = Mcp.buddyPendingRequests({ root: ctx.root, now: ctx.now });
  const all = live.filter((s) => s.live).map(slimSession);
  const sessions = all.filter((s) => s.signal === 'permission-ask');
  const requests = pending.requests.filter((r) => !r.answered).map((r) => ({ id: r.id, sessionId: r.sessionId, project: Rules.folderOf(r.cwd) || null, cwd: r.cwd, tool: r.tool, summary: r.summary, ageMs: r.ageMs, hookWaitsMsMore: r.hookWaitsMsMore }));
  const asking = new Set(sessions.map((s) => s.sessionId));
  const count = sessions.length + requests.filter((r) => !asking.has(r.sessionId)).length;
  return { count, sessions, requests, readyForReview: all.filter((s) => READY_FOR_REVIEW.has(s.signal)).length, askFromWidget: pending.askFromWidget };
}

async function cmdStatus(args, ctx) {
  const live = await ctx.fetchLive(ctx.port);
  const st = await Mcp.buddyStatus({ root: ctx.root, now: ctx.now, live });
  const w = waitingOn(ctx, await liveSessions(ctx));
  const look = st.app.running ? st.app.look : st.look;
  const data = {
    light: look ? look.lamp : 'off',
    rule: st.lampOwner ? st.lampOwner.rule : null,
    reason: st.reason,
    source: st.app.running ? 'app' : 'disk',
    sessionCount: st.sessionCount,
    agentCount: st.agentCount,
    currentTool: st.currentTool,
    waiting: { count: w.count, sessions: w.sessions, requests: w.requests },
    readyForReview: w.readyForReview,
    spend: st.spend,
  };
  const human = () => {
    const head = `${ctx.paint(data.light)} ${data.light}${data.rule ? ` · ${data.rule}` : ''}`;
    if (args.flags.short) {
      const bits = [head, `${data.sessionCount} session${data.sessionCount === 1 ? '' : 's'}`];
      if (w.count) bits.push(`${w.count} need${w.count === 1 ? 's' : ''} you`);
      if (w.readyForReview) bits.push(`${w.readyForReview} ready for review`);
      if (!live) bits.push('app not running');
      return [bits.join(' · ')];
    }
    const lines = [head, `${data.sessionCount} session${data.sessionCount === 1 ? '' : 's'}, ${data.agentCount} agent${data.agentCount === 1 ? '' : 's'}${data.currentTool ? ` · now: ${data.currentTool}` : ''}`];
    lines.push(...waitingLines(w));
    if (w.readyForReview) lines.push(`${w.readyForReview} session${w.readyForReview === 1 ? '' : 's'} finished ${w.readyForReview === 1 ? 'its turn' : 'their turns'} without needing anything: ready for review.`);
    if (!live) lines.push(notRunningNote(ctx.root, ctx.home));
    return lines;
  };
  return { live, data, human };
}

async function cmdSessions(args, ctx) {
  const live = await ctx.fetchLive(ctx.port);
  const all = await liveSessions(ctx);
  const rows = all.filter((s) => args.flags.all || s.live).map((s) => (s.sessionId === undefined
    ? { file: s.file, live: false, dropped: s.dropped }
    : { ...slimSession(s), live: s.live, ...(s.dropped ? { dropped: s.dropped } : {}), agents: (s.agents || []).length }));
  const data = { source: live ? 'app' : 'disk', sessions: rows };
  const human = () => {
    const lines = rows.length ? rows.map((s) => (s.sessionId === undefined
      ? `  ${s.file}  ignored: ${s.dropped}`
      : `${sessionLine(s)}${s.live ? '' : `  (ignored: ${s.dropped})`}`)) : ['No running sessions.'];
    if (!live) lines.push(notRunningNote(ctx.root, ctx.home));
    return lines;
  };
  return { live, data, human };
}

function waitingLines(w) {
  const lines = [];
  if (w.sessions.length) lines.push('Needs you:', ...w.sessions.map(sessionLine));
  if (w.requests.length) lines.push('Permission requests:', ...w.requests.map((r) => `  ${(r.project || '(no folder)').padEnd(22)} ${String(r.tool || '').padEnd(10)} ${r.summary || ''}  (${ago(r.ageMs)} ago)`));
  if (!w.count) lines.push('Nothing needs you.');
  return lines;
}

async function cmdWaiting(args, ctx) {
  const live = await ctx.fetchLive(ctx.port);
  const w = waitingOn(ctx, await liveSessions(ctx));
  const data = { source: live ? 'app' : 'disk', count: w.count, sessions: w.sessions, requests: w.requests, readyForReview: w.readyForReview, askFromWidget: w.askFromWidget };
  const human = () => {
    if (args.flags.short) return [`${w.count ? `${w.count} need${w.count === 1 ? 's' : ''} you` : 'Nothing needs you'}${live ? '' : ' · app not running'}`];
    const lines = waitingLines(w);
    if (!live) lines.push(notRunningNote(ctx.root, ctx.home));
    return lines;
  };
  return { live, data, human };
}

async function cmdSpend(args, ctx) {
  const Spend = require('../spend.js');
  const s = await Mcp.buddySpend({ root: ctx.root, now: ctx.now, ...(ctx.projectsDir ? { projectsDir: ctx.projectsDir } : {}) });
  const pick = (p) => ({ spent: p.spent, budget: p.budget || null, share: p.budget ? p.share : null, level: p.level || null, unpriced: p.unpriced || 0 });
  const data = { mode: s.mode, unit: s.unit, source: 'transcripts' };
  if (!args.flags.week) data.today = pick(s.today);
  if (!args.flags.today) data.week = { ...pick(s.week), startsOn: s.week.startsOn };
  data.runaway = s.runaway;
  if (s.mode === 'subscription') data.note = 'API-price equivalent, not a bill';
  const line = (label, p) => `${label}: ${Spend.money(p.spent)}${p.budget ? ` of ${Spend.money(p.budget)} (${Math.round(p.share * 100)}%)` : ''}${p.level ? ` · ${p.level}` : ''}`;
  const human = () => {
    const parts = [];
    if (data.today) parts.push(line('Today', data.today));
    if (data.week) parts.push(line('This week', data.week));
    if (args.flags.short) return [parts.join(' · ')];
    const lines = [...parts];
    for (const r of s.runaway) lines.push(`Runaway: ${r.project || r.sessionId} ${r.burn}`);
    if (data.note) lines.push(`(${data.note})`);
    return lines;
  };
  return { data, human };
}

function handoverDocs(root) {
  const dir = Tap.dirOf(root);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  return names.map((f) => {
    const file = path.join(dir, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* gone */ }
    return { key: f.slice(0, -3), file, mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function cmdHandover(args, ctx) {
  const docs = handoverDocs(ctx.root);
  const q = args.positional[0];
  if (!q) {
    const data = { handovers: docs.map((d) => ({ key: d.key, path: d.file, updatedAt: new Date(d.mtimeMs).toISOString() })) };
    return { data, human: () => (docs.length ? docs.slice(0, 20).map((d) => `  ${d.key}  ${ago(ctx.now - d.mtimeMs)} ago`) : ['No handovers yet.']) };
  }
  if (!/^[\w.-]{1,200}$/.test(q)) throw new UsageError('a session id is letters, digits, dot, dash and underscore');
  const hits = docs.filter((d) => d.key === q || d.key.includes(`-${q}`));
  if (!hits.length) throw new Error(`no handover for "${q}" in ${tilde(Tap.dirOf(ctx.root), ctx.home)} (run plexiform handover to list them)`);
  if (hits.length > 1 && !hits.some((d) => d.key === q)) throw new Error(`"${q}" matches ${hits.length} handovers: ${hits.slice(0, 5).map((d) => d.key).join(', ')}`);
  const doc = hits.find((d) => d.key === q) || hits[0];
  const markdown = fs.readFileSync(doc.file, 'utf8');
  if (args.values.out) {
    const out = path.resolve(ctx.cwd, args.values.out);
    fs.writeFileSync(out, markdown, { flag: args.flags.force ? 'w' : 'wx' });
    return { data: { key: doc.key, path: doc.file, written: out }, human: () => [`Wrote ${tilde(out, ctx.home)}`] };
  }
  return { data: { key: doc.key, path: doc.file, markdown }, human: () => [markdown.replace(/\n$/, '')] };
}

async function cmdDoctor(args, ctx) {
  const live = await ctx.fetchLive(ctx.port);
  const health = await ctx.health({ root: ctx.root, live, home: ctx.home });
  const hook = health.checks.find((c) => c.id === 'last-hook') || null;
  const data = {
    app: appInfo(live, ctx.port),
    dataDir: ctx.root,
    dataDirExists: fs.existsSync(ctx.root),
    hook: hook ? { status: hook.status, detail: hook.detail } : null,
    healthy: health.ok,
    problems: health.problems,
    checks: health.checks.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail, ...(c.next ? { next: c.next } : {}) })),
  };
  // Read-only: whether Ghostty Dock is there and trusted. Nothing is sent to it.
  if (ctx.platform === 'darwin') {
    let config = null;
    try { config = JSON.parse(fs.readFileSync(path.join(ctx.root, 'config.json'), 'utf8')); } catch { /* defaults */ }
    const row = GhosttyDock.healthRow(GhosttyDock.detect({ home: ctx.home }), GhosttyDock.modeOf(config));
    data.checks.push({ id: 'ghostty-dock', label: 'Ghostty Dock', ...row });
  }
  const human = () => {
    const lines = [
      `App:   ${live ? `running (port ${ctx.port})` : 'not running'}`,
      `Hook:  ${hook ? `${hook.status} · ${hook.detail}` : 'unknown'}`,
      `Data:  ${tilde(ctx.root, ctx.home)}${data.dataDirExists ? '' : ' (missing)'}`,
    ];
    const dock = data.checks.find((c) => c.id === 'ghostty-dock');
    if (dock) lines.push(`Ghostty Dock: ${dock.detail.split('. ')[0].replace(/\.$/, '')}`);
    const bad = data.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    if (bad.length) lines.push('', ...bad.map((c) => `${c.status.toUpperCase()}  ${c.label}: ${c.detail}${c.next ? `\n      ${c.next}` : ''}`));
    else lines.push('', 'All checks passed.');
    return lines;
  };
  return { live, data, human };
}

const RUN = { status: cmdStatus, sessions: cmdSessions, waiting: cmdWaiting, spend: cmdSpend, handover: cmdHandover, doctor: cmdDoctor };

const LAMP_COLOUR = { green: 32, amber: 33, red: 31 };
function painter(color) {
  return (lamp) => {
    const dot = lamp === 'off' ? 'o' : '●';
    return color && LAMP_COLOUR[lamp] ? `\x1b[${LAMP_COLOUR[lamp]}m${dot}\x1b[0m` : dot;
  };
}

async function run({
  argv = [], env = process.env, home = os.homedir(), cwd = process.cwd(), now = Date.now(),
  out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), color = false,
  fetchLive = (port) => Mcp.fetchLive(port), health = (o) => Mcp.buddyHealth(o), projectsDir = null, platform = process.platform,
} = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    err(`plexiform: ${e.message}\n\n${USAGE}\n`);
    return EXIT.ERROR;
  }
  if (args.command === 'help') { out(`${USAGE}\n`); return EXIT.OK; }
  const root = env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(home, '.claude-traffic-light');
  const ctx = { root, home, cwd, now, port: portOf(root, env), fetchLive, health, projectsDir, paint: painter(color), platform };
  try {
    const r = await RUN[args.command](args, ctx);
    const asked = r.live !== undefined;
    const down = asked && !r.live;
    if (args.json) out(`${JSON.stringify({ ok: true, command: args.command, ...(asked ? { app: appInfo(r.live, ctx.port) } : {}), ...r.data, ...(down ? { note: notRunningNote(root, home) } : {}) }, null, 2)}\n`);
    else out(`${r.human().join('\n')}\n`);
    return down ? EXIT.NOT_RUNNING : EXIT.OK;
  } catch (e) {
    if (args.json) out(`${JSON.stringify({ ok: false, command: args.command, error: e.message })}\n`);
    err(`plexiform: ${e.message}\n`);
    return EXIT.ERROR;
  }
}

function main() {
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  run({ argv: process.argv.slice(2), color }).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`plexiform: ${e.stack || e}\n`); process.exitCode = EXIT.ERROR; });
}

module.exports = { run, main, parseArgs, portOf, ago, EXIT, COMMANDS, USAGE, UsageError };
