// Worker thread for src/main-watchdog.js. Writes to app.log directly, in the
// same line format as src/logging.js, because its console goes via main.
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { watchdogVerdict } = require('./main-watchdog.js');

const { logFile, stallMs = 8000, checkMs = 1000 } = workerData;
let lastBeat = Date.now();
let step = 'load';
let reportedAt = 0;

const write = (line) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} [error] ${line}\n`); } catch { /* never the reason anything breaks */ } };

parentPort.on('message', (m) => {
  if (reportedAt) write(`[watchdog] main thread responsive again after ${Math.round((Date.now() - lastBeat) / 1000)} s`);
  reportedAt = 0;
  lastBeat = m.at;
  if (m.step) step = m.step;
});

setInterval(() => {
  const line = watchdogVerdict({ now: Date.now(), lastBeat, step, stallMs, reported: !!reportedAt });
  if (line) { write(line); reportedAt = Date.now(); }
}, checkMs);
