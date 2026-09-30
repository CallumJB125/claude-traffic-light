#!/usr/bin/env node
// Board hub entry point: `node hub/server.js` (config from the environment,
// see hub/README.md). SIGTERM/SIGINT shut down gracefully.

import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createLogger } from './log.js';

// Under Electron's utilityProcess the embedding app hears about startup over
// process.parentPort (D35); plain `node` runs get nothing new.
const parent = process.parentPort ?? null;

const boot = createLogger();
// → never settles under parentPort, so the caller stops here until the exit.
function fatal(msg, e, code) {
  boot.error(msg, { err: e });
  if (!parent) process.exit(code);
  parent.postMessage({ type: 'board.fatal', message: `${msg}: ${e.message}` });
  setTimeout(() => process.exit(code), 100);   // let the message leave first
  return new Promise(() => {});
}

let config;
try {
  config = loadConfig();
} catch (e) {
  await fatal('invalid configuration', e, 2);
}

const log = createLogger({ level: config.logLevel });
let app;
let addr;
try {
  app = createApp(config, { log });
  addr = await app.listen();
} catch (e) {
  await fatal('startup failed', e, 1);
}
parent?.postMessage({ type: 'board.listening', port: addr.port, hub_epoch: app.hub.epoch, ...(app.hub.localSecret ? { local_secret: app.hub.localSecret } : {}) });
// D36: the desktop app sends the integrations key (from macOS safeStorage)
// this way, never through env. Local mode only, once; never logged.
if (parent && config.auth === 'local') {
  parent.on('message', (e) => {
    const m = e?.data;
    if (m?.type !== 'board.enc_key') return;
    try {
      app.hub.setVaultKey(Buffer.from(String(m.key ?? ''), 'base64'));
      parent.postMessage({ type: 'board.enc_key', ok: true });
    } catch (err) {
      log.warn('board.enc_key ignored', { reason: err.message });
      parent.postMessage({ type: 'board.enc_key', ok: false, reason: err.message });
    }
  });
}
if (app.devLoginSecret) {
  // Printed, not logged: the log may be shipped somewhere; this is for the person at the terminal.
  process.stderr.write(`\nDEV AUTH (loopback only; never behind any proxy or tunnel). Sign in at:\n  http://${config.bind}:${addr.port}/#dev_secret=${app.devLoginSecret}\n\n`);
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  try {
    await app.close();
    process.exit(0);
  } catch (e) {
    log.error('shutdown failed', { err: e });
    process.exit(1);
  }
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: e }));
