#!/usr/bin/env node
// Board hub entry point: `node hub/server.js` (config from the environment,
// see hub/README.md). SIGTERM/SIGINT shut down gracefully.

import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createLogger } from './log.js';

const boot = createLogger();
let config;
try {
  config = loadConfig();
} catch (e) {
  boot.error('invalid configuration', { err: e });
  process.exit(2);
}

const log = createLogger({ level: config.logLevel });
const app = createApp(config, { log });
const addr = await app.listen();
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
