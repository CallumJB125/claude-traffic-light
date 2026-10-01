// End-to-end harness (CONTRACT §13 e2e): the real hub process (serving the real
// web), real runner processes (`runner/cli.js start --foreground`), the real
// board-mcp (spawned over stdio by fake-claude, as the CLI does) and a TCP
// proxy per runner that can black-hole the runner's socket and records every
// decoded WebSocket frame in both directions. Everything lives in /tmp temp
// dirs; BOARD_HOME, HOME and the hub data dir are never the member's.
// Timers are compressed with BOARD_TEST_TIME_SCALE (shared/liveness.js).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeRepo, fakeClaudeBin, tmpDir, rm, REMOTE_URL } from '../../runner/test/helpers.js';
import { replay, CARD_STATE } from '../../shared/journal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOARD = path.resolve(HERE, '..', '..');
export const SCALE = Number(process.env.BOARD_TEST_TIME_SCALE ?? 0.05);
export const DEV_SECRET = 'e2e-dev-login-secret-0123456789';
export const DEV_HEADERS = Object.freeze({ 'board-dev-secret': DEV_SECRET });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export async function until(fn, { timeout = 20000, every = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

const baseEnv = (extra) => ({
  PATH: process.env.PATH, LANG: 'en_US.UTF-8', BOARD_TEST_TIME_SCALE: String(SCALE), ...extra,
});

// ── hub ────────────────────────────────────────────────────────────────────
export async function startHub({ dataDir, port, env = {} }) {
  const logFile = path.join(dataDir, `hub-${Date.now()}.log`);
  const out = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, [path.join(BOARD, 'hub', 'server.js')], {
    env: baseEnv({
      HOME: dataDir, BOARD_AUTH: 'dev', BOARD_BIND: '127.0.0.1', BOARD_PORT: String(port), BOARD_DATA_DIR: dataDir,
      BOARD_DEV_SEED: '1', BOARD_DEV_REPO: REMOTE_URL, BOARD_SECRET: 'e2e-secret-0123456789abcdef0123456789abcdef', BOARD_DEV_LOGIN_SECRET: DEV_SECRET, BOARD_LOG_LEVEL: 'info', ...env,
    }),
    stdio: ['ignore', out, out],
  });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { what: 'hub health', timeout: 15000 });
  return { proc, url, port, logFile, dbPath: path.join(dataDir, 'board.db') };
}

// ── WebSocket-aware TCP proxy ──────────────────────────────────────────────
function wsFrames(onText) {
  let buf = Buffer.alloc(0);
  let upgraded = false;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      upgraded = true;
      buf = buf.subarray(i + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (masked) { const key = buf.subarray(off, off + 4); for (let k = 0; k < payload.length; k++) payload[k] ^= key[k % 4]; }
      if (op === 1) onText(payload.toString('utf8'));
      buf = buf.subarray(need);
    }
  };
}

export class Proxy {
  constructor(upstreamPort) {
    this.upstreamPort = upstreamPort;
    this.mode = 'pass';
    this.up = [];     // runner → hub text frames
    this.down = [];   // hub → runner text frames
    this.upBytes = 0;
    this.pairs = new Set();
  }

  async listen() {
    this.server = net.createServer((client) => {
      if (this.mode === 'blackhole') { this.pairs.add({ client, upstream: null }); client.on('error', () => {}); return; }
      const upstream = net.createConnection(this.upstreamPort, '127.0.0.1');
      const pair = { client, upstream };
      this.pairs.add(pair);
      const upParse = wsFrames((t) => this.up.push({ at: Date.now(), text: t }));
      const downParse = wsFrames((t) => this.down.push({ at: Date.now(), text: t }));
      client.on('data', (d) => { this.upBytes += d.length; upParse(d); if (this.mode === 'pass') upstream.write(d); });
      upstream.on('data', (d) => { downParse(d); if (this.mode === 'pass') client.write(d); });
      const end = () => { if (this.mode === 'pass') { client.destroy(); upstream.destroy(); this.pairs.delete(pair); } };
      client.on('close', end);
      upstream.on('close', end);
      client.on('error', () => {});
      upstream.on('error', () => {});
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  // Partition: nothing crosses, nothing closes (no FIN, no RST). New connections hang.
  blackhole() { this.mode = 'blackhole'; this.blackholedAt = Date.now(); }

  // Heal: drop the stale connections (as a NAT/Wi-Fi change would), pass new ones.
  heal() {
    this.mode = 'pass';
    for (const p of this.pairs) { p.client.destroy(); p.upstream?.destroy(); }
    this.pairs.clear();
  }

  frames(dir = 'up') { return (dir === 'up' ? this.up : this.down).map((f) => { try { return { at: f.at, ...JSON.parse(f.text) }; } catch { return { at: f.at, raw: f.text }; } }); }

  close() { this.heal(); return new Promise((r) => this.server.close(() => r())); }
}

// ── members (dev auth) ─────────────────────────────────────────────────────
export async function login(hubUrl, githubLogin) {
  const res = await fetch(`${hubUrl}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...DEV_HEADERS }, body: JSON.stringify({ github_login: githubLogin }) });
  if (!res.ok) throw new Error(`login ${githubLogin}: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => {
    const r = await fetch(`${hubUrl}${p}`, {
      method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(method === 'GET' ? undefined : { request_id: randomUUID(), ...body }) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json };
  };
  const me = (await call('GET', '/api/me')).body;
  return { cookie, call, me, id: me.member.id, boardId: me.boards[0].id };
}

// ── runners ────────────────────────────────────────────────────────────────
/**
 * An enrolled runner process for `member`, reaching the hub through its own
 * Proxy. scenario: the fake-claude script (board tools via the real board-mcp).
 */
export async function startRunner({ root, name, member, hubPort, repo, repoId, scenario, policy = {} }) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const userHome = path.join(root, `${name}-home`);
  fs.mkdirSync(userHome, { recursive: true });
  const proxy = await new Proxy(hubPort).listen();
  const dev = (await member.call('POST', '/api/devices', { name })).body;
  const env = baseEnv({ HOME: userHome, BOARD_HOME: home, CLAUDE_TRAFFIC_LIGHT_HOME: path.join(userHome, '.ctl') });
  execFileSync(process.execPath, [path.join(BOARD, 'runner', 'cli.js'), 'enroll', '--hub', `http://127.0.0.1:${proxy.port}`, '--device', dev.device_id, '--token', dev.device_token], { env });
  const bin = fakeClaudeBin(root, { mcp_stdio: true, ...scenario });
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({
    repos: { [repoId]: { opt_in: true, local_path: repo.checkout, allow_write_extra: [repo.bare], ...(policy.repo ?? {}) }, ...(policy.extraRepos ?? {}) },
    accept_from: policy.accept_from ?? {}, backends: { claude: bin }, never_auto_labels: [], form_factor: 'laptop',
  }), { mode: 0o600 });
  const logFile = path.join(root, `${name}.log`);
  const out = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, [path.join(BOARD, 'runner', 'cli.js'), 'start', '--foreground'], { env, stdio: ['ignore', out, out] });
  await until(async () => (await member.call('GET', '/api/devices')).body.devices.some((d) => d.id === dev.device_id && d.online), { what: `${name} online` });
  const r = {
    name, home, proc, proxy, logFile, deviceId: dev.device_id,
    ledger: () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8')).runs ?? {}; } catch { return {}; } },
    runDirs: () => { try { return fs.readdirSync(path.join(home, 'run')).map((d) => path.join(home, 'run', d)); } catch { return []; } },
    fakeLog: (runId) => { try { return fs.readFileSync(path.join(home, 'run', runId, 'fake.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    logs: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }),
    control: (msg) => new Promise((resolve, reject) => {
      const c = net.createConnection(path.join(home, 'runner.sock'));
      let b = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write(`${JSON.stringify({ id: '1', ...msg })}\n`));
      c.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { c.end(); resolve(JSON.parse(b.slice(0, i))); } });
      c.on('error', reject);
    }),
    cliPid: (runId) => r.ledger()[runId]?.pid ?? null,
    signal(sig, { cli = true, runner = true } = {}) {
      if (cli) for (const e of Object.values(r.ledger())) { try { process.kill(-e.pid, sig); } catch { try { process.kill(e.pid, sig); } catch { /* gone */ } } }
      if (runner) { try { process.kill(proc.pid, sig); } catch { /* gone */ } }
    },
    async stop() {
      try { process.kill(proc.pid, 'SIGCONT'); } catch { /* gone */ }
      for (const e of Object.values(r.ledger())) { try { process.kill(-e.pid, 'SIGKILL'); } catch { /* gone */ } }
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
      await proxy.close();
    },
  };
  return r;
}

// ── a whole stack ──────────────────────────────────────────────────────────
export async function stack() {
  const root = tmpDir('bE-');
  const dataDir = path.join(root, 'hub');
  fs.mkdirSync(dataDir);
  const port = await freePort();
  let hub = await startHub({ dataDir, port });
  const repo = makeRepo(root);
  const alice = await login(hub.url, 'alice');
  const bob = await login(hub.url, 'bob');
  const repoId = (await alice.call('GET', '/api/repos')).body.repos[0].id;
  const runners = [];
  const s = {
    root, dataDir, port, repo, repoId, alice, bob, runners,
    get hub() { return hub; },
    async runner(name, member, scenario, policy) {
      const r = await startRunner({ root, name, member, hubPort: port, repo, repoId, scenario, policy });
      runners.push(r);
      return r;
    },
    async card(member, fields = {}) {
      const res = await member.call('POST', `/api/boards/${member.boardId}/cards`, { title: 'E2E card', repo_id: repoId, ...fields });
      if (res.status !== 200) throw new Error(`create card ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.card;
    },
    view: async (member, cardId) => (await member.call('GET', `/api/cards/${cardId}`)).body,
    async restartHub({ signal = 'SIGKILL' } = {}) {
      hub.proc.kill(signal);
      await new Promise((r) => hub.proc.once('exit', r));
      hub = await startHub({ dataDir, port });
      return hub;
    },
    db() { return new DatabaseSync(hub.dbPath, { readOnly: true }); },
    async close() {
      stopWatchers();
      for (const r of runners) await r.stop();
      hub.proc.kill('SIGKILL');
      await new Promise((r) => (hub.proc.exitCode != null ? r() : hub.proc.once('exit', r)));
      if (!process.env.BOARD_E2E_KEEP) rm(root);
    },
  };
  return s;
}

/**
 * Poll a card every `every` ms and keep a timeline of {t, run_state, green,
 * post_wake_activity, fence}. stop() returns it.
 */
const watchers = new Set();
export function stopWatchers() { for (const w of watchers) w(); watchers.clear(); }

export function watch(member, cardId, every = 50) {
  const tl = [];
  let on = true;
  watchers.add(() => { on = false; });
  (async () => {
    while (on) {
      try {
        const t = Date.now();   // request start: the view is at least this fresh
        const v = (await member.call('GET', `/api/cards/${cardId}`)).body?.card;
        if (v) tl.push({ t, run_state: v.run_state, green: !!v.live?.green, post_wake_activity: v.live?.post_wake_activity ?? null, fence: v.fence });
      } catch { /* hub restarting */ }
      await sleep(every);
    }
  })();
  return { tl, stop: () => { on = false; return tl; } };
}

/** Journal ⇄ cards: replay() reproduces every card, and every observed state is a journalled transition. */
export function checkJournal(db, timelines = {}) {
  const rows = db.prepare('SELECT * FROM journal ORDER BY seq').all();
  const cards = replay(rows);
  const live = db.prepare('SELECT * FROM cards').all();
  const mismatches = [];
  for (const c of live) {
    const r = cards.get(c.id);
    if (!r) { mismatches.push(`${c.key}: no journal`); continue; }
    for (const f of CARD_STATE) if ((r[f] ?? null) !== (c[f] ?? null)) mismatches.push(`${c.key}.${f}: journal ${r[f]} ≠ live ${c[f]}`);
  }
  for (const [cardId, tl] of Object.entries(timelines)) {
    const to = new Set(rows.filter((x) => x.card_id === cardId && x.kind === 'card.transition').map((x) => JSON.parse(x.payload).to));
    for (const s of new Set(tl.map((x) => x.run_state))) if (s !== 'todo' && !to.has(s)) mismatches.push(`${cardId}: observed ${s} but no journalled transition to it`);
  }
  return { rows, mismatches, transitions: rows.filter((x) => x.kind === 'card.transition').length };
}

export { tmpDir, rm };
