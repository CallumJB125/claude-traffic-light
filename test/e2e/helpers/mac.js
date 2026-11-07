'use strict';
// One person's Mac for the solo/team scenario suite, wired the way main.js wires it, minus Electron:
//   AI session's MCP child → mcp-server.js busCall → the real signal server /bus → src/agent-awareness.js relay
//   → src/agent-bus-main.js relay → src/tasks-service.js (parentPort ops through busMain, the rest over tasks.sock)
//   → the real Tasks engine (board/tasks-engine) with its real dispatcher, bus.db, provider health and notes.
// Cards: src/work-capture.js fed with the session rows and the engine's own work rows (onWork → recordsFor), sending
// to a real My board hub (board/hub in local mode, in-process) and, for a team, to a real accounts hub over HTTP.
// Who is calling comes from the fake process table behind ps/lsof/codesign (test/helpers/bind-world.js). The AI CLIs
// are stub scripts named claude, codex and gemini in a bin dir put first on the engine's PATH; they run the repo's
// subscription-free fixtures. HOME for every part is a temp dir; nothing touches the real ~ or /Applications.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { world, HOST } = require('../../helpers/bind-world.js');
const M = require('../../../mcp-server.js');
const WorkCapture = require('../../../src/work-capture.js');
const { recordsFor } = require('../../../src/wrapped-work.js');
const { createTasksService } = require('../../../src/tasks-service.js');
const AgentBusMain = require('../../../src/agent-bus-main.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const BOARD = path.join(ROOT, 'board');
const imp = (rel) => import(pathToFileURL(path.join(BOARD, rel)).href);
const FAKE_CLAUDE = path.join(BOARD, 'runner', 'test', 'fixtures', 'fake-claude.js');
const FAKE_CODEX = path.join(BOARD, 'runner', 'test', 'fixtures', 'fake-codex.js');
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const until = async (fn, { ms = 15000, label = 'condition' } = {}) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The stub CLIs on PATH. Each reads a scenario file the test can rewrite between hand-offs.
function stubBin(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const files = { claudeScenario: path.join(bin, 'claude-scenario.json'), codexScenario: path.join(bin, 'codex-scenario.json'), codexLog: path.join(bin, 'codex.log') };
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_CLAUDE)} ${quote(files.claudeScenario)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${quote(files.codexScenario)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${quote(files.codexLog)}\nexec ${quote(process.execPath)} ${quote(FAKE_CODEX)} "$@"\n`, { mode: 0o755 });
  // Gemini is never started by the bus (no OS sandbox); a stub so a launch would be visible, never real.
  fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\necho "fake gemini 0.0.0"\nexit 0\n', { mode: 0o755 });
  const set = (file) => (s) => fs.writeFileSync(file, JSON.stringify(s));
  const out = { dir: bin, setClaude: set(files.claudeScenario), setCodex: set(files.codexScenario),
    codexLog: () => { try { return fs.readFileSync(files.codexLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
  out.setClaude({ steps: [{ assistant: 'Working on it.' }, { result: 'success', text: 'Claude finished the hand-off.' }] });
  out.setCodex({ delayMs: 200, text: 'Codex finished the hand-off.' });
  return out;
}

// A real My board: the board hub in local mode, in-process (buddy-window/hub-process.js runs the same entry as a
// utilityProcess). captureWork is hub-process.js captureWork, request for request.
async function startMyBoard(dir) {
  const { loadConfig } = await imp('hub/config.js');
  const { createApp } = await imp('hub/app.js');
  const { createLogger } = await imp('hub/log.js');
  const dataDir = path.join(dir, 'my-board');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const app = createApp(loadConfig({ BOARD_AUTH: 'local', BOARD_DATA_DIR: dataDir, BOARD_PORT: '0', BOARD_BIND: '127.0.0.1', BOARD_LOG_LEVEL: 'error', HOME: dir }), { log: createLogger({ level: 'error' }) });
  const addr = await app.listen();
  const url = `http://127.0.0.1:${addr.port}`;
  const headers = { Accept: 'application/json', Cookie: `board_local=${app.hub.localSecret}`, Origin: url };
  const wire = [];
  return {
    url, wire, app,
    async captureWork(body) {
      wire.push(JSON.parse(JSON.stringify(body)));
      const me = await fetch(`${url}/api/me`, { headers });
      const identity = me.ok ? await me.json() : null;
      const board = identity?.boards?.find((b) => !b.archived_at && b.name === 'My board') ?? identity?.boards?.find((b) => !b.archived_at);
      if (!board) return { ok: false };
      const result = await fetch(`${url}/api/boards/${board.id}/work-capture`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const value = await result.json().catch(() => null);
      return result.ok ? { ok: true, ...value } : { ok: false };
    },
    // Every card on My board with its capture state (straight from the hub's own database).
    cards: () => app.hub.db.all('SELECT c.id, c.title FROM cards c ORDER BY c.rowid'),
    dbText: () => JSON.stringify(app.hub.db.all('SELECT * FROM cards')),
    close: () => app.close({ graceMs: 200 }),
  };
}

// Main's view of the team hubs for one person (buddy-window/index.js getRoutes/sendTeam, request for request): the
// person's routes from GET /api/work-capture/routes, and a team card through POST /api/boards/:board/work-capture.
function teamLink(hub, person) {
  const wire = [];
  return {
    wire,
    async getRoutes() {
      if (!hub || !person) return { routes: [], complete: true };
      let r;
      try { r = await hub.call(person.token, 'GET', '/api/work-capture/routes'); } catch { return { routes: [], complete: false }; }
      if (r.status !== 200 || !r.complete || r.truncated || !Array.isArray(r.routes)) return { routes: [], complete: false };
      return { routes: r.routes.map((route) => ({ ...route, hub: hub.origin, user_id: person.userId, share_summaries: false })), complete: true };
    },
    async sendTeam(destination, body) {
      const report = { ...body };
      delete report.summary; // share_summaries is off unless the person turns it on
      wire.push({ board_id: destination.board_id, team_id: destination.team_id, body: JSON.parse(JSON.stringify(report)) });
      if (!hub || !person) return { ok: false };
      try {
        const r = await hub.call(person.token, 'POST', `/api/boards/${destination.board_id}/work-capture`, report, destination.team_id);
        return r.status === 200 ? { ok: true, ...r } : { ok: false };
      } catch { return { ok: false }; }
    },
  };
}

// opts: { t, hub?, person?, remotes?: {repoA, repoB, repoC} (git remote URLs), config? }
async function startMac(t, { hub = null, person = null, remotes = {}, config = {} } = {}) {
  const w = world(t);
  // Z: a second interactive Claude Code session (claude 110, MCP child 111) in repoC, as awareness-notes-e2e adds it.
  const z = w.proc(110, { exe: w.CLAUDE, cwd: w.repoC, signed: 'claude', args: 'claude' });
  const zKid = w.proc(111, { ppid: 110, exe: w.procs.get(101).exe, cwd: w.repoC, args: w.procs.get(101).args, env: w.procs.get(101).env.replace('CLAUDE_CODE_SESSION_ID=X', 'CLAUDE_CODE_SESSION_ID=Z').replace('CLAUDE_PID=100', 'CLAUDE_PID=110') });
  w.stdio(zKid, z, 'unix');
  w.state.sessions.push(w.claudeSession('Z', { claudePid: 110, cwd: w.repoC }));
  for (const [k, url] of Object.entries(remotes)) if (url) git(w[k], 'remote', 'add', 'origin', url);
  w.state.config = config;
  fs.writeFileSync(path.join(w.root, 'config.json'), JSON.stringify(config));

  const bin = stubBin(w.dir);
  // The Tasks engine as utility-entry.js starts it: its data dir (short: AF_UNIX path limit), main's trace file.
  const { tmpDir, rm } = await imp('tasks-engine/test/helpers.js');
  const { viaParent } = await imp('tasks-engine/test/bus-helpers.js');
  const { startTasksEngine } = await imp('tasks-engine/index.js');
  const { ClaudeBackend } = await imp('runner/backends/claude.js');
  const { CodexBackend } = await imp('runner/backends/codex.js');
  const { makeLogger } = await imp('runner/util.js');
  class StubClaude extends ClaudeBackend { static async detect() { return { id: 'claude', installed: true, version: '9.9.9', signedIn: true, bin: path.join(bin.dir, 'claude') }; } }
  class StubCodex extends CodexBackend { static async detect() { return { id: 'codex', installed: true, version: '0.159.2', signedIn: true, bin: path.join(bin.dir, 'codex') }; } }
  const engineDir = tmpDir('pxe2e-');
  const work = { rows: [] };
  const engineEnv = { HOME: w.home, USER: process.env.USER || 'tester', PATH: `${bin.dir}:${process.env.PATH}`, TMPDIR: '/tmp', LANG: 'en_US.UTF-8' };
  const eng = await startTasksEngine({
    dataDir: path.join(engineDir, 'data'), backends: { claude: StubClaude, codex: StubCodex }, env: engineEnv,
    log: makeLogger(process.stderr, { quiet: !process.env.BOARD_TEST_LOG }), interruptWaitMs: 400, stopGraceMs: 600, hbMs: 200, buddyHome: null,
    maxParallel: 4, enabledAis: ['claude', 'codex'], defaultAi: 'claude', tickMs: 50,
    busTraceFile: path.join(w.root, 'bus-trace.jsonl'),
    onWork: (rows) => { work.rows = rows; },
  });
  const engine = eng.engine ?? eng;

  // main.js wiring.
  let wc = null;
  const svcHolder = {};
  const abm = AgentBusMain.register({ ipcMain: { handle() {} }, sessionsAllowed: () => false, tasks: () => svcHolder.svc, started: () => true,
    config: () => w.state.config, folders: () => w.state.sessions.filter((s) => ['claude', 'codex'].includes(s.source || 'claude') && !s.taskId).map((s) => s.cwd), setInterval: () => null });
  const svc = createTasksService({ boardHome: path.join(engineDir, 'data'), homeDir: w.home, busMain: (op, args, o = {}) => viaParent(engine, op, args, o.caller),
    busContext: () => abm.context(), onBusReady: () => {}, copy: () => {}, confirmDialog: async () => { throw new Error('a dialog was shown'); } });
  svcHolder.svc = svc;
  const aw = w.make({ mcpCaps: () => ({ claude: true, codex: true }), halted: () => abm.halted(), bus: (op, args) => abm.relay(op, args, null), busStarted: () => true,
    refreshHalt: () => abm.refresh(), repoFor: (cwd) => WorkCapture.repoFor(cwd),
    boardFor: (s) => wc?.boardFor?.(s) ?? { kind: 'unknown' }, addAgentCard: (s, a) => wc.addAgentCard(s, a), sessionFacts: (s) => wc?.sessionFacts?.(s) ?? null });
  const S = require('../../../src/signal-server.js')({ rootDir: w.root, sessionsDir: path.join(w.root, 'signal-sessions'), requestsDir: w.root, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} },
    agentBus: (op, args, caller, ident) => aw.relay(op, args, caller, ident, { forward: (o, a, c) => abm.relay(o, a, c) }) });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  await until(() => fs.existsSync(path.join(w.root, 'token')), { label: 'signal token' });
  const conn = { root: w.root, port: server.address().port };

  const myBoard = await startMyBoard(w.dir);
  const team = teamLink(hub, person);
  const routesFn = { get: () => team.getRoutes() };
  wc = WorkCapture.createWorkCapture({ startEnabled: true, file: path.join(w.dir, 'userData', 'work-capture.json'), host: HOST, home: w.home,
    excluded: (cwd) => aw.excludedForCards(cwd), getRoutes: () => routesFn.get(), sendLocal: (body) => myBoard.captureWork(body), sendTeam: (d, body) => team.sendTeam(d, body), log: () => {},
    // The handover writer's facts (main reads them from each session's transcript): started five minutes ago, one file edited.
    factsFor: (o) => (o.provider === 'claude' || o.provider === 'claude-code' || o.provider === 'codex' ? { startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), files: { 'src/a.js': 'edit' } } : null) });

  // Main observes the sessions for cards as their hooks report, before any AI asks where its cards go.
  await wc.observe(w.state.sessions, { wrapped: [] });
  await aw.build();
  await aw.refresh();
  const as = {
    X: () => { w.call(101); return conn; },
    Z: () => { w.call(111); return conn; },
    T: () => { w.call(201); return { ...conn, meta: { threadId: w.T } }; },
  };
  const call = (who, op, args = {}) => M.busCall(op, args, as[who]());
  const handles = async () => { const r = await aw.build(); return { X: r.self['claude|X']?.handle, Z: r.self['claude|Z']?.handle, T: r.self[`codex|${w.T}`]?.handle }; };
  // What main does on a session or work change: cards for the session rows and the engine's runs.
  const pump = async () => { await wc.observe(w.state.sessions, { wrapped: recordsFor(work.rows, { host: HOST }) }); };
  const taskOf = (handoffId) => [...engine.tasks.values()].find((x) => x.sourceMeta?.handoffId === handoffId);
  const traceLines = async () => {
    await engine.agentBus?.trace?.flush?.();
    try { return fs.readFileSync(path.join(w.root, 'bus-trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const mac = {
    w, aw, abm, svc, engine, eng, bin, conn, as, call, handles, pump, wc, work, myBoard, team, routesFn, taskOf, traceLines, until,
    // Waits until a hand-off's run reaches a state, then hands it back.
    async runOf(handoffId, pred = () => true, label = 'run') { return until(() => { const x = taskOf(handoffId); return x && pred(x) && x; }, { label }); },
    async stopRun(taskId) { try { await engine.act({ id: taskId, action: 'stop' }); } catch { /* already ended */ } },
    async cleanup() {
      for (const x of engine.tasks.values()) if (['running', 'queued', 'blocked'].includes(x.state)) await mac.stopRun(x.id);
      try { await wc.stop(); } catch { /* stopped */ }
      try { svc.stop(); } catch { /* stopped */ }
      abm.stop();
      aw.stop();
      server.closeAllConnections(); await new Promise((r) => server.close(r));
      await myBoard.close().catch(() => {});
      await eng.close();
      rm(engineDir);
    },
  };
  t.after(() => mac.cleanup());
  return mac;
}

// A real accounts-mode hub, as a separate process on loopback (console mailer: sign-in codes are read from its
// stderr), the same launch as test/account-flow-real-hub.test.js. stop()/start() keep its data dir and port, so a test
// can take it offline and bring it back.
async function startTeamHub(dir) {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const dataDir = path.join(dir, 'team-hub');
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  let proc = null;
  let err = '';
  const origin = `http://127.0.0.1:${port}`;
  const wire = [];
  const hub = {
    origin, wire,
    async start() {
      proc = spawn(process.execPath, [path.join(BOARD, 'hub', 'server.js')], {
        env: { PATH: process.env.PATH, HOME: dataDir, LANG: 'en_US.UTF-8', BOARD_AUTH: 'accounts', BOARD_SIGNUP: 'open', BOARD_ACCOUNTS_DEV: '1', BOARD_CONSOLE_MAILER: '1', BOARD_EMAIL_SIGNIN: '1',
          BOARD_BIND: '127.0.0.1', BOARD_PORT: String(port), BOARD_DATA_DIR: dataDir, BOARD_SECRET: secret, BOARD_LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      proc.stderr.on('data', (d) => { err += d; });
      await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, { label: 'hub health' });
    },
    async stop() {
      if (!proc) return;
      const p = proc; proc = null;
      p.kill('SIGTERM');
      await until(() => p.exitCode != null || p.signalCode != null, { ms: 10000, label: 'hub exit' }).catch(() => p.kill('SIGKILL'));
    },
    async call(token, method, url, body, team) {
      if (method !== 'GET') wire.push({ method, url, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
      const res = await fetch(`${origin}${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(team ? { 'X-Board-Team': team } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = await res.json().catch(() => null);
      return { status: res.status, ...(j || {}) };
    },
    async signIn(email) {
      const codes = () => [...err.matchAll(/To: (\S+)\nSubject: (\d{6}) is your \S+ sign-in code\n/g)].filter((m) => m[1] === email).map((m) => m[2]);
      const n = codes().length;
      const s = await hub.call(null, 'POST', '/api/auth/email/start', { email, client: 'buddy_desktop', device_name: 'Mac' });
      const code = await until(() => codes().length > n && codes().at(-1), { label: `code for ${email}` });
      const v = await hub.call(null, 'POST', '/api/auth/email/verify', { flow_id: s.flow_id, code });
      if (!v.device_token) throw new Error(`sign-in failed for ${email}: ${v.status}`);
      return { email, token: v.device_token, userId: v.user.id };
    },
    // Every card on a board as its members see it.
    async cards(person, teamId, boardId) {
      const r = await hub.call(person.token, 'GET', `/api/boards/${boardId}`, undefined, teamId);
      return r.cards ?? r.board?.cards ?? [];
    },
  };
  await hub.start();
  return hub;
}

module.exports = { startMac, startTeamHub, until, git, HOST };
