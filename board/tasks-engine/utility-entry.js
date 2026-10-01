// Electron utilityProcess entry. Only readiness and fixed error codes cross
// parentPort: credentials remain in the engine's private files.
import { startTasksEngine } from './index.js';
import { makeLogger } from '../runner/util.js';

const parent = process.parentPort;
let engine;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await engine?.close(); process.exit(0); }
  catch { process.exit(1); }
}
parent?.on('message', (e) => { if (e?.data?.type === 'tasks.shutdown') close(); });
process.on('SIGTERM', close);
process.on('SIGINT', close);
try {
  engine = await startTasksEngine({
    dataDir: process.env.PLEXIFORM_TASKS_DATA_DIR,
    // Other providers remain registered for explicit use by their own
    // engine integration. Opening this desktop page never probes Claude.
    enabledAis: ['codex'], defaultAi: 'codex',
    log: makeLogger(process.stderr, { quiet: true }),
    stopGraceMs: 1500,
  });
  if (closing) await engine.close();
  else parent?.postMessage({ type: 'tasks.listening', socket: engine.socketPath, epoch: engine.epoch });
} catch {
  parent?.postMessage({ type: 'tasks.fatal', code: 'START_FAILED' });
  setTimeout(() => process.exit(1), 50);
}
