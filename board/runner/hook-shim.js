#!/usr/bin/env node
// Hook shim (CONTRACT §7.4): `hook-shim.js <event>`. Reads the CLI's hook JSON
// on stdin, forwards `hook {event, payload}` over the run's IPC socket, prints
// the runner's stdout object and exits with its exit code.
// Dead-man first: supervisor pid + lstart must match, else — like any IPC
// failure — `pre` DENIES (fail-closed) and every other event exits 0 quietly.
import fs from 'node:fs';
import path from 'node:path';
import { lstartOf, isAlive } from './procs.js';
import { ipcRequest } from './ipc.js';
import { HOOK_TOKEN_FILE } from './launch.js';

const event = process.argv[2];
const DENY = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'board supervisor unavailable' } };

// Pipes are async on macOS: exit only after the write has flushed.
function out(obj, code) {
  if (!obj) { process.exit(code); return; }
  process.stdout.write(JSON.stringify(obj), (err) => {
    if (err && event === 'pre') { process.stderr.write('board supervisor unavailable\n', () => process.exit(2)); return; }
    process.exit(code);
  });
}

function fail() {
  if (event === 'pre') out(DENY, 0);
  else process.exit(0);
}

function readStdin(ms) {
  return new Promise((resolve) => {
    let s = '';
    const t = setTimeout(() => resolve(s), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(s); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(s); });
  });
}

async function main() {
  const env = process.env;
  const pid = Number(env.BOARD_SUPERVISOR_PID);
  // The CLI scrubs *TOKEN* vars from hook env; the run dir holds the token file.
  let token = env.BOARD_RUN_TOKEN;
  if (!token && env.BOARD_RUN_SOCKET) {
    try { token = fs.readFileSync(path.join(path.dirname(env.BOARD_RUN_SOCKET), HOOK_TOKEN_FILE), 'utf8').trim(); } catch { token = null; }
  }
  if (!env.BOARD_RUN_SOCKET || !token || !Number.isSafeInteger(pid) || pid <= 0) return fail();
  if (!isAlive(pid) || !env.BOARD_SUPERVISOR_LSTART || lstartOf(pid) !== env.BOARD_SUPERVISOR_LSTART) return fail();
  const raw = await readStdin(5000);
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  // pre may wait ≤ 20 s for an ack after a short wake (offline rule 5); the CLI's hook timeout is 30 s.
  const timeoutMs = event === 'pre' ? 27000 : 8000;
  let res;
  try {
    res = await ipcRequest(env.BOARD_RUN_SOCKET, { type: 'hook', id: '1', token, event, payload }, { timeoutMs });
  } catch { return fail(); }
  if (!res?.ok || !res.result) return fail();
  const { stdout, exit_code: code } = res.result;
  out(stdout && typeof stdout === 'object' && Object.keys(stdout).length ? stdout : null, Number.isSafeInteger(code) ? code : 0);
}

main().catch(fail);
