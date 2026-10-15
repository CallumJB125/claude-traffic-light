'use strict';
// Optional Home suggestions must never synchronously open an arbitrary recent
// project folder on Electron main (macOS may hold that open for a privacy prompt).
const { parentPort, workerData } = require('node:worker_threads');
const Starter = require('./starter-pack.js');
try {
  parentPort.postMessage({ type: 'detected', detected: Starter.detect(workerData.folders) });
} catch {
  // No filesystem error/path or project contents cross this optional boundary.
  parentPort.postMessage({ type: 'detected', detected: [] });
}
parentPort.close();
