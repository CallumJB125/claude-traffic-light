'use strict';

// `plexiform run` (plan-orchestrator O2, TASKS-CONTRACT.md §14.1): give a task
// to Claude or Codex from the terminal. A thin client of the local Tasks API
// (board/tasks-api/client.js), the same one the app uses. It asks the engine's
// router who should run it, shows that one line, and waits: nothing starts
// until the person presses Enter (or passes --yes in a script). With --follow
// it streams the task's events until it ends.
//
// It never answers an approval for anyone, never sends bypass, and treats the
// task text as data: the text goes into the spec as-is and is never run.

const path = require('path');
const { pathToFileURL } = require('url');

const EXIT = { OK: 0, USAGE: 2, UNREACHABLE: 3, REFUSED: 4, ENDED_BADLY: 5, INTERRUPTED: 130 };
const AIS = ['claude', 'codex', 'gemini'];
const LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const KEY = { c: 'claude', x: 'codex', g: 'gemini' };
const LETTER = { claude: 'c', codex: 'x', gemini: 'g' };
const SURFACES = ['background', 'tmux', 'tab'];
const PERMS = ['plan', 'ask', 'auto-edits', 'auto'];
const END_OK = new Set(['in_review', 'done']);
const END_BAD = new Set(['failed', 'parked']);
const UNREACHABLE = new Set(['SUPERVISOR_UNREACHABLE', 'UNAUTHENTICATED', 'FORBIDDEN', 'TIMEOUT', 'PROTOCOL_UNSUPPORTED', 'ENOENT', 'ECONNREFUSED', 'EACCES']);
const MAX_TEXT = 20000;

const SPEC = {
  flags: ['plan-first', 'in-place', 'follow', 'yes'],
  values: ['in', 'with', 'mode', 'perm', 'budget', 'base', 'title', 'request-id'],
};

class RunUsageError extends Error {}

/** The parsed `run` arguments → a TaskSpec without text/cwd checks the engine does itself. */
function checkArgs(args) {
  const v = args.values;
  if (args.positional.length !== 1) throw new RunUsageError('run takes the task text in quotes, or - to read it from stdin');
  if (v.with && ![...AIS, 'auto'].includes(v.with)) throw new RunUsageError('--with is claude, codex, gemini or auto');
  if (v.mode && !SURFACES.includes(v.mode)) throw new RunUsageError('--mode is background, tmux or tab');
  if (v.perm === 'bypass') throw new RunUsageError('--perm bypass is not offered here; it needs the per-project opt-in in Plexiform');
  if (v.perm && !PERMS.includes(v.perm)) throw new RunUsageError('--perm is plan, ask, auto-edits or auto');
  if (v.budget !== undefined && !(Number(v.budget) > 0 && Number.isFinite(Number(v.budget)))) throw new RunUsageError('--budget is an amount in USD above 0');
  if (v['request-id'] !== undefined && !/^[\w-]{8,128}$/.test(v['request-id'])) throw new RunUsageError('--request-id is 8–128 letters, digits, dashes or underscores');
  if (v.title !== undefined && v.title.length > 120) throw new RunUsageError('--title is at most 120 characters');
}

function tasksHome({ env, home, platform }) {
  if (env.PLEXIFORM_TASKS_HOME) return env.PLEXIFORM_TASKS_HOME;
  if (env.CLAUDE_TRAFFIC_LIGHT_TASKS_HOME) return env.CLAUDE_TRAFFIC_LIGHT_TASKS_HOME;
  // Electron's userData for productName "Plexiform" (src/rename-migration.js), then main.js's tasks folder.
  const appData = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(appData, 'Plexiform', 'tasks');
}

async function connectTasks(ctx) {
  const dir = tasksHome(ctx);
  const api = await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href); // privacy-flow: tasks-local
  const client = await api.connect({ socketPath: path.join(dir, 'tasks.sock'), tokenPath: path.join(dir, 'tasks.token'), client: { name: 'plexiform-cli', version: '1' } });
  client.newRequestId = api.newRequestId;
  return client;
}

const oneLine = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, n);
const codeOf = (e) => (typeof e?.code === 'string' ? e.code : null);

function routeLines(r, spec) {
  const where = spec.permissionLevel ? `permission: ${spec.permissionLevel}` : 'permission: your default';
  if (r.decision === 'ask') {
    return [`? ${r.reason}`, ...r.alternatives.slice(0, 2).map((a) => `  [${LETTER[a.ai]}] ${a.reason}`), `  ${where}`];
  }
  return [`→ ${r.reason}`, `  ${where}`];
}

function eventLines(e, seen) {
  switch (e.type) {
    case 'state':
      if (seen.state === e.state && seen.label === e.label) return [];
      seen.state = e.state; seen.label = e.label;
      return [`· ${oneLine(e.label, 60)}${e.reason ? ` · ${oneLine(e.reason)}` : ''}`];
    case 'transcript':
      if (e.role === 'assistant') return [oneLine(e.text, 64 * 1024).replace(/ {2,}/g, ' ')];
      if (e.role === 'system') return [`  (${oneLine(e.text)})`];
      return [];
    case 'tool':
      if (e.phase === 'start') return [`  ▸ ${oneLine(e.name, 60)}${e.summary ? ` ${oneLine(e.summary, 200)}` : ''}`];
      return e.ok === false ? [`  ✗ ${oneLine(e.name, 60)} failed`] : [];
    case 'diff':
      return e.stat ? [`  Δ ${e.stat.files} file${e.stat.files === 1 ? '' : 's'} +${e.stat.added} −${e.stat.removed}`] : [];
    case 'approval':
      if (e.phase === 'requested') return [`! ${oneLine(e.tool, 60)} needs your approval: ${oneLine(e.inputSummary)}`];
      if (e.phase === 'answered') return [`  ${e.decision === 'allow' ? '✓ approved' : '✗ denied'}${e.answeredBy ? ` by ${oneLine(e.answeredBy, 60)}` : ''}`];
      return ['  (approval expired)'];
    case 'ask':
      return e.phase === 'asked' ? [`? ${oneLine(e.text, 2000)}`, '  Answer it in Plexiform (Tasks).'] : [];
    case 'error':
      return [`! ${oneLine(e.message)}`];
    default:
      return [];
  }
}

/** → exit code. ctx: {cwd, env, home, platform, out, err, tty, prompt(q)→Promise<string|null>, readStdin()→Promise<string>, connectTasks, onInterrupt(fn)} */
async function runTask(args, ctx) {
  const out = (s) => ctx.out(`${s}\n`);
  const fail = (code, msg, extra = {}) => {
    if (args.json) out(JSON.stringify({ ok: false, command: 'run', error: msg, ...extra }));
    ctx.err(`plexiform: ${msg}\n`);
    return code;
  };
  try { checkArgs(args); } catch (e) { return fail(EXIT.USAGE, e.message); }

  const fromStdin = args.positional[0] === '-';
  const text = fromStdin ? String(await ctx.readStdin()).replace(/\n+$/, '') : args.positional[0];
  if (!text.trim()) return fail(EXIT.USAGE, 'the task text is empty');
  if (text.length > MAX_TEXT) return fail(EXIT.USAGE, `the task text is longer than ${MAX_TEXT} characters`);
  const v = args.values;
  const spec = { text, cwd: path.resolve(ctx.cwd, v.in ?? '.'), source: 'cli', ai: v.with ?? 'auto' };
  if (v.mode) spec.surface = v.mode;
  if (v.perm) spec.permissionLevel = v.perm;
  if (args.flags['plan-first']) spec.planFirst = true;
  if (v.budget !== undefined) spec.budgetUsd = Math.round(Number(v.budget) * 100) / 100;
  if (v.base) spec.baseBranch = v.base;
  if (args.flags['in-place']) spec.workInPlace = true;
  if (v.title) spec.title = v.title;
  const interactive = !!ctx.tty && !fromStdin && !args.json && !args.flags.yes;

  let client;
  try { client = await (ctx.connectTasks ?? connectTasks)(ctx); } catch (e) {
    return fail(EXIT.UNREACHABLE, `Plexiform's task helper isn't reachable (${UNREACHABLE.has(codeOf(e)) ? codeOf(e) : 'not running'}). Open Plexiform and try again.`);
  }
  const refused = (e) => (UNREACHABLE.has(codeOf(e))
    ? fail(EXIT.UNREACHABLE, `lost the task helper: ${oneLine(e.message)}`)
    : fail(EXIT.REFUSED, `${oneLine(e.message)}${codeOf(e) ? ` (${codeOf(e)})` : ''}`, { code: codeOf(e), ...(e.details?.choices ? { choices: e.details.choices } : {}) }));
  try {
    let r;
    try { r = await client.route(spec); } catch (e) { return refused(e); }
    if (!args.json) for (const l of routeLines(r, spec)) out(l);

    let ai = spec.ai;
    let expectAi;
    const offered = new Set([...(r.ai ? [r.ai] : []), ...r.alternatives.filter((a) => a.usable).map((a) => a.ai)]);
    if (r.decision === 'ask') {
      if (!interactive) return fail(EXIT.REFUSED, `${r.reason}. Choose with --with ${r.alternatives.slice(0, 2).map((a) => a.ai).join(' or --with ')}.`, { code: 'CONFIRM_REQUIRED', choices: r.alternatives.slice(0, 2) });
      const keys = r.alternatives.slice(0, 2).map((a) => LETTER[a.ai]);
      for (;;) {
        const a = await ctx.prompt(`Pick [${keys.join('/')}], or q to leave it: `);
        const k = a == null ? 'q' : a.trim().toLowerCase();
        if (k === 'q') { out('Not started.'); return EXIT.OK; }
        if (keys.includes(k)) { ai = 'auto'; expectAi = KEY[k]; break; }
      }
    } else if (interactive) {
      const others = [...offered].filter((x) => x !== r.ai).map((x) => `${LETTER[x]} for ${LABEL[x]}`);
      for (;;) {
        const a = await ctx.prompt(`Enter to run${others.length ? `, ${others.join(', ')}` : ''}, q to leave it: `);
        const k = a == null ? 'q' : a.trim().toLowerCase();
        if (k === 'q') { out('Not started.'); return EXIT.OK; }
        if (k === '') { if (spec.ai === 'auto') expectAi = r.ai; break; }
        if (KEY[k] && offered.has(KEY[k])) { ai = KEY[k]; break; }
      }
    } else if (!args.flags.yes) {
      return fail(EXIT.USAGE, 'not started: this is not a terminal, so nothing was confirmed. Pass --yes to start it.', { route: r });
    } else if (spec.ai === 'auto') expectAi = r.ai;

    const requestId = v['request-id'] ?? client.newRequestId?.() ?? require('crypto').randomUUID();
    let created;
    try { created = await client.createTask({ ...spec, ai, ...(expectAi ? { expectAi } : {}) }, { requestId }); } catch (e) { return refused(e); }
    const t = await client.getTask(created.id);
    if (args.json) out(JSON.stringify({ ok: true, command: 'run', id: created.id, duplicate: created.duplicate, requestId, ai: t.ai.id, reason: t.ai.reason, permissionLevel: t.permissionLevel, state: t.state }));
    else out(`${created.duplicate ? 'Already started' : 'Started'} ${created.id} · ${oneLine(t.ai.reason ?? LABEL[t.ai.id])} · ${t.permissionLevel}`);
    if (!args.flags.follow) return EXIT.OK;
    return await follow(client, t, args, ctx, interactive);
  } finally {
    try { client.close(); } catch { /* already closed */ }
  }
}

function follow(client, t, args, ctx, interactive) {
  const out = (s) => ctx.out(`${s}\n`);
  const seen = { state: null, label: null };
  const asked = new Set();
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, line) => {
      if (done) return;
      done = true;
      if (line && !args.json) out(line);
      resolve(code);
    };
    const end = (state, label, reason) => {
      if (END_OK.has(state)) finish(EXIT.OK, `Done: ${oneLine(label, 60)}${reason ? ` · ${oneLine(reason)}` : ''}`);
      else if (END_BAD.has(state)) finish(EXIT.ENDED_BADLY, `Ended: ${oneLine(label, 60)}${reason ? ` · ${oneLine(reason)}` : ''}`);
    };
    const answer = async (e) => {
      if (asked.has(e.approvalId)) return;
      asked.add(e.approvalId);
      if (!interactive) { if (!args.json) out('  Answer it in Plexiform (Tasks).'); return; }
      const a = await ctx.prompt('Approve once? a = approve, d = deny, Enter = answer it in Plexiform: ');
      const k = a == null ? '' : a.trim().toLowerCase();
      if (done || (k !== 'a' && k !== 'd')) return;
      try {
        await client.act(t.id, k === 'a' ? 'approve' : 'deny', k === 'a' ? { approvalId: e.approvalId, scope: 'once' } : { approvalId: e.approvalId });
      } catch (err) { if (!args.json) out(`  ! ${oneLine(err.message)}`); }
    };
    const handle = (e) => {
      if (done) return;
      if (args.json) out(JSON.stringify(e));
      else for (const l of eventLines(e, seen)) out(l);
      if (e.type === 'approval' && e.phase === 'requested') answer(e);
      if (e.type === 'state') end(e.state, e.label, e.reason);
    };
    ctx.onInterrupt?.(() => finish(EXIT.INTERRUPTED, `Stopped following. ${t.id} keeps running in Plexiform.`));
    client.on('close', () => finish(EXIT.UNREACHABLE, `Lost the task helper. ${t.id} keeps running in Plexiform.`));
    if (!args.json) for (const l of eventLines({ type: 'state', state: t.state, label: t.label, reason: t.reason }, seen)) out(l);
    end(t.state, t.label, t.reason);
    if (done) return;
    client.subscribe(t.id, { fromSeq: t.lastSeq + 1 }, handle).catch((e) => finish(EXIT.UNREACHABLE, `Couldn't follow ${t.id}: ${oneLine(e.message)}`));
  });
}

function readAllStdin(stdin = process.stdin) {
  return new Promise((resolve, reject) => {
    let s = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => { s += c; if (s.length > MAX_TEXT * 4) { stdin.destroy(); resolve(s); } });
    stdin.on('end', () => resolve(s));
    stdin.on('error', reject);
  });
}

/** One line from the terminal, or null on end of input. */
function terminalPrompt({ input = process.stdin, output = process.stderr } = {}) {
  const readline = require('readline');
  let rl = null;
  const lines = [];
  const waiting = [];
  let ended = false;
  const open = () => {
    if (rl) return;
    rl = readline.createInterface({ input, output, terminal: !!input.isTTY });
    rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
    rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(null); });
  };
  const prompt = (q) => {
    open();
    output.write(q);
    if (lines.length) return Promise.resolve(lines.shift());
    if (ended) return Promise.resolve(null);
    return new Promise((res) => waiting.push(res));
  };
  prompt.close = () => { if (rl) rl.close(); };
  return prompt;
}

module.exports = { runTask, connectTasks, tasksHome, routeLines, eventLines, readAllStdin, terminalPrompt, checkArgs, RunUsageError, SPEC, EXIT };
