const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { startMainWatchdog, watchdogVerdict } = require('../src/main-watchdog.js');

test('watchdogVerdict reports a stopped heartbeat once, naming the step', () => {
  assert.equal(watchdogVerdict({ now: 5000, lastBeat: 0, step: 'ready', stallMs: 8000, reported: false }), null);
  const line = watchdogVerdict({ now: 9000, lastBeat: 0, step: 'window', stallMs: 8000, reported: false });
  assert.match(line, /main thread blocked for 9 s \(last startup step: window\)/);
  assert.equal(watchdogVerdict({ now: 20000, lastBeat: 0, step: 'window', stallMs: 8000, reported: true }), null);
});

test('startMainWatchdog never throws when no worker can start', () => {
  const w = startMainWatchdog({ createWorker: () => { throw new Error('no workers'); } });
  w.step('ready');
  w.stop();
});

test('a blocked main thread is written to app.log by the worker, with the last step', async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-')), 'app.log');
  const dog = startMainWatchdog({
    intervalMs: 50,
    createWorker: () => new Worker(path.join(__dirname, '..', 'src', 'main-watchdog-worker.js'), { workerData: { logFile, stallMs: 300, checkMs: 50 } }),
  });
  try {
    await new Promise((r) => setTimeout(r, 150));
    dog.step('tray+signal-server');
    // Block this thread synchronously, as a read waiting on a privacy prompt does.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
    await new Promise((r) => setTimeout(r, 300));
    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /\[error\] \[watchdog\] main thread blocked for \d+ s \(last startup step: tray\+signal-server\)/);
    assert.match(log, /\[watchdog\] main thread responsive again after \d+ s/);
  } finally {
    dog.stop();
  }
});
