// In-process test rig: a real hub (dev auth, temp SQLite file, fake clock,
// fake GitHub, no timers) on an ephemeral loopback port, plus fake runners
// and browsers speaking the real WS protocol. Nothing touches the network
// beyond 127.0.0.1 or any home-directory state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApp } from '../app.js';
import { silentLogger } from '../log.js';
import { validateConfig } from '../config.js';
import { seedDev } from '../seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEV_SECRET = 'dev-secret-for-tests-0123456789';
export const DEV_HEADERS = Object.freeze({ 'board-dev-secret': DEV_SECRET });

export function fakeClock(start = 1_000_000) {
  let mono = start;
  let wall = Date.parse('2026-09-30T10:00:00.000Z');
  return {
    mono: () => mono,
    wall: () => wall,
    advance(ms) { mono += ms; wall += ms; },
    advanceWallOnly(ms) { wall += ms; },
  };
}

export function fakeGitHub() {
  const pulls = new Map();
  const commits = new Set();
  return {
    enabled: true,
    pulls,
    commits,
    setPull(number, p) { pulls.set(number, { number, state: 'open', merged: false, merged_by: null, merged_at: null, html_url: `https://github.com/acme/app/pull/${number}`, ...p }); },
    async getPull(canonical, number) { return canonical === 'github.com/acme/app' ? pulls.get(number) ?? null : null; },
    async getCommit(canonical, sha) { return commits.has(sha) ? { sha } : null; },
  };
}

export function testConfig(over = {}) {
  const dir = over.dataDir ?? mkdtempSync(join(tmpdir(), 'board-hub-'));
  return validateConfig({
    bind: '127.0.0.1', port: 0, dataDir: dir, dbPath: join(dir, 'board.db'), auth: 'dev', accessTeam: null, accessAud: null,
    secret: 'x'.repeat(40), devLoginSecret: DEV_SECRET, publicUrl: null, devSeed: true, devRepo: 'git@github.com:acme/app.git', bootstrap: null,
    restore: false, tunnelProbeUrl: null, githubToken: null, githubApi: 'https://api.github.com', githubPollMs: 60_000,
    webDir: resolve(HERE, 'fixtures', 'web'), sharedDir: resolve(HERE, '..', '..', 'shared'), logLevel: 'silent', shutdownGraceMs: 200,
    ...over,
    devSeed: (over.auth ?? 'dev') === 'dev',
  });
}

export async function startHub({ clock = fakeClock(), github = fakeGitHub(), config = {}, dataDir, fetchImpl } = {}) {
  const cfg = testConfig({ ...config, ...(dataDir ? { dataDir, dbPath: join(dataDir, 'board.db') } : {}) });
  const app = createApp(cfg, { clock, log: silentLogger, github, timers: false, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!cfg.devSeed) seedDev(app.hub, { repoUrl: cfg.devRepo });   // same fixture data under Access auth
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const db = app.db;
  const org = db.get("SELECT * FROM orgs WHERE name = 'dev'");
  const ids = {
    org: org.id,
    board: db.get('SELECT id FROM boards WHERE org_id = ?', org.id).id,
    repo: db.get("SELECT id FROM repos WHERE canonical_url = 'github.com/acme/app'")?.id,
    alice: db.get("SELECT id FROM members WHERE github_login = 'alice'").id,
    bob: db.get("SELECT id FROM members WHERE github_login = 'bob'").id,
  };
  const runners = [];
  const browsers = [];

  const h = {
    app, hub: app.hub, db, clock, github, base, ids, dataDir: cfg.dataDir, devHeaders: DEV_HEADERS,
    async login(login) {
      const res = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...DEV_HEADERS }, body: JSON.stringify({ github_login: login }) });
      return res.headers.get('set-cookie').split(';')[0];
    },
    async api(cookie, method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    async enroll(cookie, name = 'MacBook') {
      const r = await h.api(cookie, 'POST', '/api/devices', { request_id: randomUUID(), name });
      return r.body;
    },
    async runner(dev, opts = {}) {
      const r = new FakeRunner(base, dev);
      runners.push(r);
      await r.open();
      if (opts.hello !== false) await r.hello(opts.runs ?? []);
      if (opts.advertise !== false && opts.hello !== false) await r.advertise([{ repo_id: ids.repo, approvals_from: opts.approvals_from ?? [], auto_accept_from: opts.auto_accept_from ?? [] }]);
      return r;
    },
    async browser(cookie, boardId = ids.board) {
      const b = new FakeBrowser(base, cookie);
      browsers.push(b);
      await b.open();
      await b.subscribe(boardId);
      return b;
    },
    async tick(ms = 0) {
      if (ms) clock.advance(ms);
      await app.hub.tick();
    },
    // Advance in steps (the reaper runs every second in production).
    async run(ms, every = 1000) {
      for (let t = 0; t < ms; t += every) await h.tick(Math.min(every, ms - t));
    },
    card(id) { return db.get('SELECT * FROM cards WHERE id = ?', id); },
    async createCard(cookie, fields = {}) {
      const r = await h.api(cookie, 'POST', `/api/boards/${ids.board}/cards`, { request_id: randomUUID(), title: 'Fix it', repo_id: ids.repo, ...fields });
      if (r.status !== 200) throw new Error(`createCard ${r.status} ${r.text}`);
      return r.body.card;
    },
    async action(cookie, cardId, action, body = {}) {
      return h.api(cookie, 'POST', `/api/cards/${cardId}/actions/${action}`, { request_id: randomUUID(), ...body });
    },
    // Card → dispatched → claimed by `runner` → running (fresh activity). Returns the run handle.
    async startRun(cookie, runner, fields = {}) {
      const card = await h.createCard(cookie, fields);
      const d = await h.action(cookie, card.id, 'dispatch');
      if (d.status !== 200) throw new Error(`dispatch ${d.status} ${d.text}`);
      const offer = await runner.next('offer', (o) => o.card_id === card.id);
      const res = await runner.claim(offer);
      if (!res.ok) throw new Error(`claim failed ${JSON.stringify(res.error)}`);
      const run = { card_id: card.id, key: card.key, run_id: res.run_id, fence: res.fence, run_token: res.run_token, repo_id: ids.repo, branch: res.branch };
      await runner.out({ kind: 'activity', ...runMsg(run), source: 'init' });
      await runner.hb([runHb(run)]);
      return run;
    },
    async close() {
      await app.close({ graceMs: 200 });
      for (const r of runners) r.terminate();
      for (const b of browsers) b.terminate();
    },
    async destroy() {
      await h.close();
      rmSync(cfg.dataDir, { recursive: true, force: true });
    },
  };
  return h;
}

export const runMsg = (run) => ({ run_id: run.run_id, card_id: run.card_id, fence: run.fence, repo_id: run.repo_id });

export function runHb(run, over = {}) {
  return {
    run_id: run.run_id, card_id: run.card_id, fence: run.fence, child_alive: true, tool_in_flight: null,
    last_activity_age_ms: 0, cost_usd: 0.01, post_wake_activity: false, wake_age_ms: null, gate: 'open', local_state: 'running', ...over,
  };
}

class Peer {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.closeCode = null;
  }

  attach(ws) {
    this.ws = ws;
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      this.msgs.push(m);
      for (const w of [...this.waiters]) {
        if (w.match(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    ws.on('close', (code, reason) => { this.closeCode = code; this.closeReason = String(reason ?? ''); for (const w of this.closeWaiters ?? []) w(code); });
    return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  }

  send(m) { this.ws.send(JSON.stringify(m)); }

  // Resolves with the first message (already received or future) matching.
  next(type, pred = () => true, { timeout = 3000, fresh = false } = {}) {
    const match = (m) => m.type === type && pred(m);
    if (!fresh) {
      const i = this.msgs.findIndex((m) => match(m) && !m.__taken);
      if (i !== -1) { this.msgs[i].__taken = true; return Promise.resolve(this.msgs[i]); }
    }
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (m) => { clearTimeout(t); m.__taken = true; resolve(m); } };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  all(type, pred = () => true) { return this.msgs.filter((m) => m.type === type && pred(m)); }
  clear() { this.msgs = []; }

  closed() {
    if (this.closeCode != null) return Promise.resolve(this.closeCode);
    return new Promise((r) => { (this.closeWaiters ??= []).push(r); });
  }

  terminate() { try { this.ws.terminate(); } catch { /* gone */ } }
}

export class FakeRunner extends Peer {
  constructor(base, dev) {
    super();
    this.url = `${base.replace('http', 'ws')}/ws/runner`;
    this.dev = dev;
    this.seq = 0;
    this.seqHb = 0;
    this.n = 0;
  }

  // dev.team: an enrolled runner (accounts P4) also names its team.
  open() {
    return this.attach(new WebSocket(this.url, { headers: { authorization: `Bearer ${this.dev.device_token}`, ...(this.dev.team ? { 'board-team': this.dev.team } : {}) } }));
  }

  async hello(runs = [], { outbox_head_seq = this.seq, outbox_id, outbox_acked_seq } = {}) {
    this.send({ type: 'hello', protocol: 1, device_id: this.dev.device_id, runner_version: 'test', outbox_head_seq, runs, ...(outbox_id ? { outbox_id } : {}), ...(outbox_acked_seq != null ? { outbox_acked_seq } : {}) });
    this.welcome = await this.next('welcome', () => true, { fresh: true });
    // A real runner persists its outbox head; resume after what the hub acked.
    this.seq = Math.max(this.seq, this.welcome.last_seq_acked);
    return this.welcome;
  }

  async advertise(repos) {
    this.send({ type: 'advertise', repos });
    await new Promise((r) => setTimeout(r, 20));
  }

  async claim(offer, { expected_fence = offer.fence, request_id = offer.request_id } = {}) {
    const id = `c${++this.n}`;
    this.send({ type: 'claim', id, card_id: offer.card_id, request_id, expected_fence });
    return this.next('claim.result', (m) => m.re === id);
  }

  async hb(runs, { slept_ms = 0 } = {}) {
    const seq_hb = ++this.seqHb;
    this.send({ type: 'hb', seq_hb, mono_ms: 1, wall_ms: 1, slept_ms, runs });
    return this.next('hb.ack', (m) => m.seq_hb === seq_hb);
  }

  async out(msg, { delayed = false, seq = ++this.seq, wait = true } = {}) {
    this.send({ type: 'out', seq, delayed, msg });
    if (!wait) return null;
    return this.next('ack', (m) => m.seq >= seq, { fresh: false });
  }

  async rpc(run, method, params = {}, over = {}) {
    const id = `r${++this.n}`;
    this.send({ type: 'rpc', id, method, ...runMsg(run), run_token: run.run_token, params, ...over });
    return this.next('rpc.result', (m) => m.re === id);
  }
}

export class FakeBrowser extends Peer {
  constructor(base, cookie) {
    super();
    this.url = `${base.replace('http', 'ws')}/ws/board`;
    this.cookie = cookie;
  }

  open(headers = {}) {
    return this.attach(new WebSocket(this.url, { headers: { cookie: this.cookie, ...headers } }));
  }

  async subscribe(boardId) {
    this.send({ type: 'hello', protocol: 1 });
    await this.next('welcome');
    this.send({ type: 'subscribe', board_id: boardId });
    this.snapshot = await this.next('snapshot', () => true, { fresh: true });
    return this.snapshot;
  }

  lastCard(cardId) {
    const ups = this.all('card.upsert', (m) => m.card.id === cardId);
    return ups.length ? ups[ups.length - 1].card : null;
  }
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeout = 2000, every = 5 } = {}) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error('until: condition not met');
    await settle(every);
  }
}
