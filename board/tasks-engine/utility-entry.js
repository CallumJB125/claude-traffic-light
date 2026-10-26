// Electron utilityProcess entry. Only readiness, fixed error codes and main's note ops (parent-bus.js) cross
// parentPort: credentials remain in the engine's private files.
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTasksEngine } from './index.js';
import { makeLogger } from '../runner/util.js';
import { desktopProviders } from './desktop-providers.js';
import { parentBus, BUS_REQUEST } from './parent-bus.js';
import { productionCarry } from '../shared/claude-carry.cjs';

// The app's enforced spend cap (src/spend-enforce.js writes it; hooks/spend-gate.js reads it, fail-open). The
// router skips every AI while it holds.
const SpendGate = createRequire(import.meta.url)('../../hooks/spend-gate.js');
const appRoot = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(process.env.HOME || os.homedir(), '.claude-traffic-light');

const parent = process.parentPort;
let engine;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await engine?.close(); process.exit(0); }
  catch { process.exit(1); }
}
// O1b: bus_peers for a wrapped run is answered by main (it holds the roster); a reply that does not come in 3 s is none.
const asks = new Map();
let askSeq = 0;
function peersFor(taskId) {
  if (!parent) return Promise.resolve(null);
  const id = ++askSeq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { asks.delete(id); resolve(null); }, 3000);
    t.unref?.();
    asks.set(id, (result) => { clearTimeout(t); asks.delete(id); resolve(result); });
    try { parent.postMessage({ type: 'awareness.peers', id, taskId }); } catch { asks.get(id)?.(null); }
  });
}
parent?.on('message', (e) => {
  if (e?.data?.type === 'tasks.shutdown') close();
  if (e?.data?.type === 'awareness.peers.reply') asks.get(e.data.id)?.(e.data.result ?? null);
  if (e?.data?.type === BUS_REQUEST) {
    parentBus(engine?.engine ?? null, e.data).then((r) => { if (r && !closing) parent.postMessage(r); }, () => {});
  }
});
process.on('SIGTERM', close);
process.on('SIGINT', close);
try {
  engine = await startTasksEngine({
    dataDir: process.env.PLEXIFORM_TASKS_DATA_DIR,
    ...desktopProviders(),
    // loginShellEnv is the seam for PR 1b (src/login-shell-env.js): pass the filtered login-shell reader here.
    claudeCarry: productionCarry({ log: () => {} }),
    spendGate: () => SpendGate.readGate(appRoot),
    log: makeLogger(process.stderr, { quiet: true }),
    stopGraceMs: 1500,
    onRuns: (runs) => { try { parent?.postMessage({ type: 'tasks.runs', runs }); } catch { /* main is gone */ } },
    peersFor,
    onWork: (rows) => { try { parent?.postMessage({ type: 'tasks.work', rows }); } catch { /* main is gone */ } },
  });
  if (closing) await engine.close();
  else parent?.postMessage({ type: 'tasks.listening', socket: engine.socketPath, epoch: engine.epoch });
} catch {
  parent?.postMessage({ type: 'tasks.fatal', code: 'START_FAILED' });
  setTimeout(() => process.exit(1), 50);
}
