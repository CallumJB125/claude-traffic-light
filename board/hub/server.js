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
await app.listen();

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
