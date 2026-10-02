// Test harness: temp BOARD_HOME + git fixture (bare "GitHub" remote reached
// through insteadOf), a fake hub speaking /ws/runner, the fake claude wrapper,
// a fake clock, and IPC helpers. Nothing touches ~/.claude*, ~/.board or the network.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Supervisor } from '../supervisor.js';
import { makeLogger } from '../util.js';
import { ipcRequest } from '../ipc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.js');
export const REMOTE_URL = 'https://github.com/acme/app.git';
export const CANON = 'github.com/acme/app';
export const REPO_ID = 'repo-app';
export const OWNER = 'm-owner';

// Short paths: AF_UNIX socket paths must stay < 104 bytes on macOS.
const TEMP_ROOT = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
export function tmpDir(prefix = 'brt-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(TEMP_ROOT, prefix)));
}

export function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** bare remote + a member checkout whose origin is REMOTE_URL (rewritten locally). */
export function makeRepo(root, { remoteUrl = REMOTE_URL } = {}) {
  const bare = path.join(root, 'remote.git');
  const co = path.join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  fs.mkdirSync(co);
  git(co, 'init', '-q', '-b', 'main');
  git(co, 'config', 'user.email', 't@example.com');
  git(co, 'config', 'user.name', 'T');
  git(co, 'config', 'commit.gpgsign', 'false');
  git(co, 'remote', 'add', 'origin', remoteUrl);
  git(co, 'config', `url.file://${bare}.insteadOf`, remoteUrl);
  fs.writeFileSync(path.join(co, 'README.md'), '# app\n');
  fs.writeFileSync(path.join(co, 'CLAUDE.md'), 'Use tabs.\n');
  git(co, 'add', '-A');
  git(co, 'commit', '-q', '-m', 'init');
  git(co, 'push', '-q', 'origin', 'main');
  return { bare, checkout: co, git: (...a) => git(co, ...a), gitIn: git };
}

export function fakeClaudeBin(dir, scenario) {
  const sc = path.join(dir, `scenario-${crypto.randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(sc, JSON.stringify(scenario));
  const bin = path.join(dir, `claude-${crypto.randomUUID().slice(0, 8)}`);
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CLAUDE}' '${sc}' "$@"\n`, { mode: 0o755 });
  return bin;
}

export function fakeClock(start = 1_000_000) {
  let mono = start;
  let wall = 1_790_000_000_000;
  return {
    mono: () => mono,
    wall: () => wall,
    advance(ms) { mono += ms; wall += ms; },
  };
}

export function readFakeLog(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

export async function waitFor(pred, { timeout = 10000, interval = 25, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Fake hub. Auto-answers hello/out/hb/claim/rpc. `down` = answer upgrades
 * with an HTTP status (530 + "error code: 1033" = Cloudflare origin down).
 */
export async function startFakeHub({ allowlist = [{ repo_id: REPO_ID, canonical_url: CANON, aliases: [] }], memberId = OWNER } = {}) {
  const hub = {
    frames: [],            // parsed runner→hub frames
    raw: [],               // raw strings as received
    bytes: 0,
    lastAck: 0,
    autoAck: true,
    handoverVersion: 0,
    current: true,         // hb.ack current flag
    fencedRuns: new Set(),
    endedRuns: new Set(),  // hb.ack current:false reason RUN_ENDED
    holdHb: false,         // withhold hb.acks (silent hub on a live socket)
    heldHb: [],
    down: null,
    closeWith: null,       // close every new socket right after the upgrade with this code
    claimReply: null,      // (frame) => claim.result body
    rpcReply: (f) => ({ ok: true, result: {} }),
    nextRun: 0,
    sockets: new Set(),
    epoch: `ep-${crypto.randomUUID().slice(0, 6)}`,
  };
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    if (hub.down === 'reset') { socket.destroy(); return; }
    if (hub.down) {
      socket.write(`HTTP/1.1 ${hub.down} Origin Down\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nerror code: 1033`);
      socket.destroy();
      return;
    }
    hub.lastAuth = req.headers.authorization;
    hub.lastHeaders = req.headers;
    hub.upgrades = (hub.upgrades ?? 0) + 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (hub.closeWith) { ws.close(hub.closeWith, 'test close'); return; }
      wss.emit('connection', ws);
    });
  });
  const send = (ws, o) => ws.send(JSON.stringify(o));
  wss.on('connection', (ws) => {
    hub.sockets.add(ws);
    ws.on('close', () => hub.sockets.delete(ws));
    ws.on('message', (data) => {
      const s = String(data);
      hub.raw.push(s);
      hub.bytes += Buffer.byteLength(s);
      const f = JSON.parse(s);
      hub.frames.push(f);
      switch (f.type) {
        case 'hello':
          send(ws, { type: 'welcome', protocol: 1, hub_epoch: hub.epoch, device_id: f.device_id, member_id: memberId, last_seq_acked: hub.lastAck, allowlist });
          break;
        case 'out':
          if (hub.autoAck && f.seq === hub.lastAck + 1) {
            hub.lastAck = f.seq;
            const v = f.msg?.kind === 'handover.write' ? { versions: [{ seq: f.seq, version: ++hub.handoverVersion }] } : {};
            send(ws, { type: 'ack', seq: f.seq, ...v });
          }
          break;
        case 'hb':
          if (hub.holdHb) { hub.heldHb.push(() => send(ws, { type: 'hb.ack', seq_hb: f.seq_hb, hub_epoch: hub.epoch, runs: f.runs.map((r) => ({ run_id: r.run_id, fence: r.fence, current: true, state: 'running' })) })); break; }
          send(ws, { type: 'hb.ack', seq_hb: f.seq_hb, hub_epoch: hub.epoch, runs: f.runs.map((r) => {
            const reason = hub.fencedRuns.has(r.run_id) ? 'FENCED' : hub.endedRuns.has(r.run_id) ? 'RUN_ENDED' : null;
            return { run_id: r.run_id, fence: r.fence, current: hub.current && !reason, state: 'running', ...(reason ? { reason } : {}) };
          }) });
          break;
        case 'claim': {
          const body = hub.claimReply ? hub.claimReply(f) : {
            ok: true, run_id: `run-${++hub.nextRun}`, fence: f.expected_fence + 1, branch: null, run_token: `brt1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`,
            team_context: { text: 'Team context: nobody else is in src/.', tokens: 8 },
          };
          send(ws, { type: 'claim.result', re: f.id, ...body });
          break;
        }
        case 'rpc':
          send(ws, { type: 'rpc.result', re: f.id, ...hub.rpcReply(f) });
          break;
        default:
          break;
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hub.url = `ws://127.0.0.1:${server.address().port}/ws/runner`;
  hub.send = (o) => { for (const ws of hub.sockets) send(ws, o); };
  hub.releaseHb = () => { hub.holdHb = false; for (const f of hub.heldHb.splice(0)) f(); };
  hub.dropAll = () => { for (const ws of hub.sockets) ws.terminate(); };
  hub.of = (type) => hub.frames.filter((f) => f.type === type);
  hub.outs = (kind) => hub.frames.filter((f) => f.type === 'out' && (!kind || f.msg.kind === kind)).map((f) => f.msg);
  hub.facts = (kind) => hub.outs('facts').flatMap((m) => m.items).filter((i) => !kind || i.kind === kind);
  hub.close = () => new Promise((r) => { hub.dropAll(); wss.close(); server.close(() => r()); });
  return hub;
}

export function offerFor({ key = 'APP-1', fence = 0, title = 'Fix the thing', by = OWNER, seed = {}, request_id = crypto.randomUUID(), labels = [] } = {}) {
  return {
    type: 'offer', card_id: `card-${key}`, key, title, body: 'Body of the card', repo_id: REPO_ID, base_ref: 'main', fence,
    request_id, dispatched_by: { member_id: by, name: by === OWNER ? 'Owner' : 'Teammate' }, needs_confirm: by !== OWNER,
    labels, budget_usd: 1, max_turns: 20, require_plan_approval: false, seed,
  };
}

/** Supervisor wired to a temp home, the fake hub and a fake claude. */
export async function startRunner({ hub, home, repo, scenario, clock, policyExtra = {}, repoPolicy = {}, confirm, powerMonitor, env, autoTick = false, opts = {} }) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'device.json'), JSON.stringify({ hub: 'http://127.0.0.1', device_id: 'dev-1', device_token: 'bdt_testtoken' }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({
    repos: { [REPO_ID]: { opt_in: true, local_path: repo.checkout, max_concurrent: 2, approvals_from: [], ...repoPolicy } },
    accept_from: {}, backends: {}, never_auto_labels: ['never_auto'], ...policyExtra,
  }), { mode: 0o600 });
  const bin = scenario ? fakeClaudeBin(home, scenario) : null;
  const sup = new Supervisor({
    home, hubUrl: hub.url, clock, claudeBin: bin, autoTick, confirm, powerMonitor,
    env: env ?? { HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, TMPDIR: TEMP_ROOT, LANG: 'en_US.UTF-8' },
    log: makeLogger(process.stderr, { quiet: !process.env.BOARD_TEST_LOG }),
    interruptWaitMs: 500, stopGraceMs: 800, limitBackoffMs: 50, gitleaks: null, rand: () => 0, reconnectDelayFn: () => 30,
    keepRunFiles: true,   // tests read fake.log after the run ends
    buddyHome: null,      // never write Buddy launch records into the real home
    detectAis: async () => null,   // never probe the real claude/codex
    ...opts,
  });
  await sup.start();
  await waitFor(() => sup.connected, { what: 'runner connected' });
  return sup;
}

/** Tick n times, advancing the fake clock `step` ms before each, yielding to I/O as it goes. */
export async function advance(sup, clock, n, step = 1000) {
  for (let i = 0; i < n; i++) {
    clock.advance(step);
    sup.tick();
    if (i % 15 === 14) await new Promise((r) => setTimeout(r, 15));
  }
  await new Promise((r) => setTimeout(r, 30));
}

export function ipcCall(run, msg, opts) {
  return ipcRequest(run.socketPath, { id: crypto.randomUUID(), token: run.run_token, ...msg }, opts);
}

export function hookCall(run, event, payload, opts) {
  return ipcCall(run, { type: 'hook', event, payload }, opts);
}

export async function claimRun(sup, hub, offer, { active = true } = {}) {
  hub.send(offer);
  const run = await waitFor(() => [...sup.runs.values()].find((r) => r.card_id === offer.card_id), { what: 'run started' });
  await waitFor(() => run.backend || run.ended, { what: 'run spawned' });
  if (active) await waitFor(() => run.firstActivity || run.ended, { what: 'first activity' });
  return run;
}

export function tree() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' });
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

