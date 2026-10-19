#!/usr/bin/env node
// board-runner CLI.
//   enroll --hub <url> --device <id> --token <tok> [--cf-client-id … --cf-client-secret …]
//   start [--foreground]          detached by default (Buddy later spawns `start` itself)
//   status | stop-all | opt-in <repo_id> --path <local checkout> | confirm <request_id> yes|no
//   hosted                        the always-on cloud runner (systemd buddy-runner.service; config from env)
//   hosted-check                  what the cloud runner would use here: sandbox, AI CLIs, hub (no secrets printed)
// BOARD_HOME overrides ~/.board.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from '../shared/local-sockets.cjs'; // protected Windows local transport; POSIX Unix sockets
import { fileURLToPath } from 'node:url';
import { boardHome, initHome, writeDevice, readPolicy, writePolicy } from './config.js';
import { Supervisor } from './supervisor.js';
import { HostedMode, hostedConfig } from './hosted/index.js';
import { detectCgroup } from './hosted/cgroup.js';
import { BACKENDS } from './backends/index.js';
import { makeLogger } from './util.js';

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function control(l, msg) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(l.controlSock); // privacy-flow: local-board-sockets
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${JSON.stringify({ id: '1', ...msg })}\n`));
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, i))); } });
    c.on('error', reject);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (cmd === 'hosted') return startHosted();
  if (cmd === 'hosted-check') return hostedCheck();
  const l = initHome(boardHome());
  switch (cmd) {
    case 'enroll': {
      if (!f.hub || !f.device || !f.token) throw new Error('usage: enroll --hub <url> --device <id> --token <token>');
      writeDevice(l, { hub: f.hub, device_id: f.device, device_token: f.token, ...(f['cf-client-id'] ? { cf_client_id: f['cf-client-id'], cf_client_secret: f['cf-client-secret'] } : {}) });
      process.stdout.write(`enrolled device ${f.device}; wrote ${l.device} (0600)\n`);
      return;
    }
    case 'start': {
      if (!f.foreground) {
        const log = fs.openSync(l.log, 'a', 0o600);
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--foreground'], { detached: true, stdio: ['ignore', log, log], env: process.env }); // privacy-flow: runner-local
        child.unref();
        process.stdout.write(`board runner started (pid ${child.pid}); log ${l.log}\n`);
        return;
      }
      const sup = await new Supervisor({ home: l.home }).start();
      const bye = async () => { await sup.shutdown({ stopRuns: false }); process.exit(0); };
      process.on('SIGTERM', bye);
      process.on('SIGINT', bye);
      return;
    }
    case 'status':
    case 'stop-all': {
      const r = await control(l, { type: cmd === 'status' ? 'status' : 'stop_all' });
      process.stdout.write(`${JSON.stringify(r.result ?? r, null, 2)}\n`);
      return;
    }
    case 'opt-in': {
      const repoId = f._[0];
      if (!repoId || !f.path) throw new Error('usage: opt-in <repo_id> --path <local checkout>');
      try {
        await control(l, { type: 'opt_in', repo_id: repoId, local_path: f.path });
      } catch {
        const p = readPolicy(l);
        p.repos[repoId] = { ...(p.repos[repoId] ?? {}), opt_in: true, local_path: f.path };
        writePolicy(l, p);
      }
      process.stdout.write(`opted in ${repoId} at ${f.path}\n`);
      return;
    }
    case 'confirm': {
      const r = await control(l, { type: 'confirm_offer', request_id: f._[0], accept: f._[1] === 'yes' });
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return;
    }
    default:
      process.stdout.write('usage: board-runner enroll|start|status|stop-all|opt-in|confirm (see runner/cli.js)\n');
      process.exitCode = cmd ? 1 : 0;
  }
}

// systemd runs this in the foreground; SIGTERM parks live runs like the desktop app's quit.
async function startHosted() {
  const log = makeLogger();
  const hosted = new HostedMode({ config: hostedConfig(process.env), log });
  const env = hosted.childEnv(process.env);
  delete env.CREDENTIALS_DIRECTORY;
  const sup = await new Supervisor({ home: hosted.boardHome, device: hosted.device, enabledAis: hosted.config.ais, hosted, env, log, controlSocket: true, buddyHome: null }).start();
  log.info('hosted runner started', { ais: hosted.config.ais, repos: hosted.config.repos.length, sandbox: hosted.cgroup.ok ? 'cgroup' : 'off' });
  let stopping = false;
  const bye = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('hosted runner stopping', { signal });
    sup.quitting = true;
    const live = [...sup.runs.values()].filter((r) => !r.ended && !r.hubHandoverPending);
    await Promise.race([Promise.all(live.map((r) => r.parkForQuit(10_000).catch(() => false))), new Promise((r) => setTimeout(r, 25_000))]);
    await sup.shutdown({ stopRuns: false });
    hosted.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
}

async function hostedCheck() {
  const out = {};
  try {
    const c = hostedConfig(process.env);
    out.config = { hub: c.hub, team: c.team, home: c.home, repos: c.repos, ais: c.ais, sandbox: c.sandbox, caps: c.caps, runner_token: 'present' };
  } catch (e) { out.config = { error: e.message }; }
  out.cgroup = detectCgroup();
  out.ai = {};
  for (const [id, B] of Object.entries(BACKENDS)) {
    const d = await B.detect({ env: process.env }).catch((e) => ({ installed: false, reason: e.message }));
    out.ai[id] = { installed: d.installed, version: d.version ?? null, signedIn: d.signedIn ?? 'unknown', ...(d.reason ? { reason: d.reason } : {}) };
  }
  out.bubblewrap = ['/usr/bin/bwrap', '/bin/bwrap'].some((p) => fs.existsSync(p));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = out.config.error || (out.config.sandbox === 'cgroup' && !out.cgroup.ok) ? 1 : 0;
}

main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
