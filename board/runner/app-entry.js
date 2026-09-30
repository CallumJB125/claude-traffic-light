#!/usr/bin/env node
// The runner under the desktop app (CONTRACT D37a): Electron utilityProcess
// runs `runner/app-entry.js`; the app is the supervisor (no detaching). No
// device file and no env secret is read: the app sends
//   {type:'runner.config', hub_url, device_id, device_token, cf_client_id?, cf_client_secret?, data_dir}
// over process.parentPort and the credentials stay in memory, used only for
// the hub WS connect. data_dir replaces BOARD_HOME (runs, worktrees, outbox).
// Replies: runner.ready, runner.status {state, detail?}, runner.fatal {message},
// runner.stopped {parked, parked_pending, orphaned}. `runner.presence` feeds team presence
// (D37b). SIGTERM/SIGINT → park every live run (bounded), exit 0.
import path from 'node:path';
import { WS_CLOSE } from '../shared/protocol.js';
import { Supervisor } from './supervisor.js';
import { PresenceReporter } from './presence.js';
import { makeLogger } from './util.js';

const QUIT_BUDGET_MS = 25_000;   // the app waits for us; exit 0 by then whatever is left
const QUIT_HANDOVER_MS = 10_000; // the agent's final-handover window inside that budget

const STATE_OF_CLOSE = {
  [WS_CLOSE.UNAUTHENTICATED]: 'unauthenticated',
  [WS_CLOSE.REVOKED]: 'revoked',
  [WS_CLOSE.UNAVAILABLE]: 'unavailable',
  [WS_CLOSE.PROTOCOL_UNSUPPORTED]: 'unavailable',
};

/** → an error message (never echoing a credential), or null when the config is usable. */
export function configError(m) {
  const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096;
  if (!str(m.hub_url)) return 'hub_url required';
  let u;
  try { u = new URL(m.hub_url); } catch { return 'hub_url is not a URL'; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return 'hub_url must be http(s) or ws(s)';
  // The device token rides this connection: cleartext only to this machine.
  if ((u.protocol === 'http:' || u.protocol === 'ws:') && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return 'hub_url must be https: or wss: unless it is localhost';
  if (!str(m.device_id)) return 'device_id required';
  if (!str(m.device_token)) return 'device_token required';
  if ((m.cf_client_id != null || m.cf_client_secret != null) && !(str(m.cf_client_id) && str(m.cf_client_secret))) return 'cf_client_id and cf_client_secret go together';
  if (!str(m.data_dir) || !path.isAbsolute(m.data_dir)) return 'data_dir must be an absolute path';
  return null;
}

const parent = process.parentPort ?? null;
if (!parent) {
  process.stderr.write('runner/app-entry.js runs only under the desktop app (process.parentPort); use runner/cli.js otherwise\n');
  process.exit(2);
}

const log = makeLogger();
const post = (m) => { try { parent.postMessage(m); } catch { /* app gone */ } };
let sup = null;
let presence = null;
let configured = false;
let pendingPresence = null;
let lastState = null;

function fatal(message, code) {
  log.error('runner fatal', { message });
  post({ type: 'runner.fatal', message });
  setTimeout(() => process.exit(code), 100);   // let the message leave first
}

function status(state, detail) {
  if (state === lastState) return;
  lastState = state;
  post({ type: 'runner.status', state, ...(detail ? { detail } : {}) });
}

async function start(m) {
  const bad = configError(m);
  if (bad) { fatal(`bad runner.config: ${bad}`, 2); return; }
  const device = {
    hub: m.hub_url, device_id: m.device_id, device_token: m.device_token,
    ...(m.cf_client_id ? { cf_client_id: m.cf_client_id, cf_client_secret: m.cf_client_secret } : {}),
  };
  try {
    sup = new Supervisor({ home: m.data_dir, device, log });
    presence = new PresenceReporter(sup);
    sup.on('connected', () => status('connected'));
    sup.on('hub_closed', ({ code }) => status(STATE_OF_CLOSE[code] ?? 'backoff', code == null ? 'hub unreachable' : `closed ${code}`));
    await sup.start();
  } catch (e) {
    fatal(`runner start failed: ${e.message}`, 1);
    return;
  }
  post({ type: 'runner.ready' });
  if (pendingPresence) presence.update(pendingPresence);
  pendingPresence = null;
}

parent.on('message', (e) => {
  const m = e?.data;
  if (m?.type === 'runner.config') {
    if (configured) { log.warn('runner.config ignored: already configured'); return; }
    configured = true;
    start(m).catch((err) => fatal(`runner start failed: ${err.message}`, 1));
    return;
  }
  if (m?.type === 'runner.presence') {
    if (presence) presence.update(m).catch((err) => log.warn('presence update failed', { err: err.message }));
    else pendingPresence = m;
  }
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('runner stopping', { signal });
  status('stopping');
  presence?.stop();
  const live = sup ? [...sup.runs.values()].filter((r) => !r.ended) : [];
  const pending = live.filter((r) => r.hubHandoverPending);
  const runs = live.filter((r) => !pending.includes(r));
  let parked = 0;
  if (sup) sup.quitting = true;
  let budget;
  await Promise.race([
    Promise.all(runs.map((r) => r.parkForQuit(QUIT_HANDOVER_MS).then((ok) => { if (ok) parked += 1; }, (e) => log.warn('park failed', { run_id: r.run_id, err: e.message })))),
    new Promise((r) => { budget = setTimeout(r, QUIT_BUDGET_MS); }),
  ]);
  clearTimeout(budget);
  const orphaned = runs.length - parked;
  if (orphaned) log.warn('quit: runs not parked; the next start treats them as orphans', { orphaned });
  try { await sup?.shutdown({ stopRuns: false }); } catch (e) { log.error('shutdown failed', { err: e.message }); }
  post({ type: 'runner.stopped', parked, parked_pending: pending.length, orphaned });
  setTimeout(() => process.exit(0), 100);   // let the message leave first
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
