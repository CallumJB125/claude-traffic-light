// startTasksEngine: the local "Hand it off" Tasks engine behind
// TASKS-CONTRACT.md. Not wired into the desktop yet; see README.md for how
// the next slice starts it (a utilityProcess, like the hub supervisor).
import path from 'node:path';
import { BACKENDS } from '../runner/backends/index.js';
import { ensurePrivateDir, makeLogger } from '../runner/util.js';
import { TaskStore } from './store.js';
import { TasksEngine } from './engine.js';
import { startTransport } from './transport.js';

/**
 * opts:
 *   dataDir   private dir (created 0700; a symlink or another user's dir is refused);
 *             keep it short: the socket path must fit in 103 bytes
 *   backends  {id: Backend class} (default: the runner's registry)
 *   log       {info, warn, error, debug} JSON-line logger (never given tokens or task text)
 *   now       wall clock ms (default Date.now)
 *   env       env the CLI allowlist is built from (default process.env)
 *   maxParallel (≤ 8), retentionDays (30), retentionMax (500), hbMs, mcpServer,
 *   interruptWaitMs, stopGraceMs
 * → {socketPath, tokenPath, token, epoch, tasks, engine, close({leaveRuns})}
 */
export async function startTasksEngine({ dataDir, backends = BACKENDS, log = makeLogger(), now = Date.now, ...opts } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path');
  ensurePrivateDir(dataDir);
  const store = new TaskStore(path.join(dataDir, 'store'));
  const engine = new TasksEngine({ dataDir, store, backends, log, now, ...opts });
  try {
    await engine.init();
  } catch (e) {
    store.close();
    throw e;
  }
  let transport;
  try {
    transport = await startTransport({ engine, dir: dataDir, log, hbMs: opts.hbMs });
  } catch (e) {
    await engine.close({ leaveRuns: true });
    throw e;
  }
  log.info('tasks engine listening', { epoch: engine.epoch });
  return {
    socketPath: transport.socketPath, tokenPath: transport.tokenPath, token: transport.token, epoch: engine.epoch,
    tasks: engine.tasks, engine,
    async close(o) {
      await transport.close();
      await engine.close(o);
    },
  };
}
