// BOARD_HOME layout (CONTRACT §6.10) and the runner-local files in it.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';

export function boardHome(env = process.env) {
  return env.BOARD_HOME || path.join(os.homedir(), '.board');
}

export function layout(home) {
  return {
    home,
    device: path.join(home, 'device.json'),
    policy: path.join(home, 'policy.json'),
    ledger: path.join(home, 'ledger.json'),
    outboxDir: path.join(home, 'outbox'),
    runDir: (runId) => path.join(home, 'run', runId),
    worktree: (repoId, key, fence) => path.join(home, 'worktrees', safeSeg(repoId), `${safeSeg(key)}-r${fence}`),
    controlSock: path.join(home, 'runner.sock'),
    log: path.join(home, 'runner.log'),
  };
}

function safeSeg(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function initHome(home) {
  ensureDir(home);
  for (const d of ['outbox', 'run', 'worktrees']) ensureDir(path.join(home, d));
  return layout(home);
}

export function readDevice(l) {
  return readJson(l.device, null);
}

export function writeDevice(l, dev) {
  writeJsonAtomic(l.device, dev);
}

export const DEFAULT_POLICY = Object.freeze({ repos: {}, accept_from: {}, backends: {}, never_auto_labels: ['never_auto'] });

export function readPolicy(l) {
  const p = readJson(l.policy, null) ?? {};
  return { ...DEFAULT_POLICY, ...p, repos: p.repos ?? {}, accept_from: p.accept_from ?? {}, backends: p.backends ?? {} };
}

export function writePolicy(l, policy) {
  writeJsonAtomic(l.policy, policy);
}

export function readLedger(l) {
  return readJson(l.ledger, null) ?? { runs: {} };
}

export function writeLedger(l, ledger) {
  writeJsonAtomic(l.ledger, ledger);
}

export function hubWsUrl(hub) {
  const u = new URL(hub);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  u.pathname = '/ws/runner';
  u.search = '';
  return u.toString();
}

export function fileMode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return null; }
}
