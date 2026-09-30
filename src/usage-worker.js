// F1 spend: reads transcripts off the main thread. Owns its own incremental
// file cache, so after the first pass a read stats the files and parses only
// what was appended. Answers { unchanged: true } when nothing was parsed and
// no file came or went, so the main thread isn't handed the same turns again.
//
// It also keeps the permanent daily usage record (usage-history.js) on the
// same pass: `history.tick` folds the turns this worker already parsed into
// the record, and the first tick backfills from every transcript still on
// disk, a few files at a time, so spend reads keep being answered meanwhile.
const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const Usage = require('../usage.js');
const History = require('../usage-history.js');

const cache = new Map();
let lastFiles = null;
let lastTurns = null;
let historyBusy = false;

async function historyTick({ root, dataDir, statsFile }) {
  if (historyBusy) return null;
  historyBusy = true;
  try {
    const store = History.open({ root: dataDir });
    const marker = path.join(dataDir, 'usage', '.backfilled');
    const first = !fs.existsSync(marker);
    let imported = 0;
    if (first) {
      let stats = null;
      try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch { /* none yet */ }
      const r = await History.catchUp(store, {
        root: root || path.join(require('os').homedir(), '.claude', 'projects'),
        onProgress: (p) => parentPort.postMessage({ type: 'history.progress', ...p }),
      });
      imported = History.importLegacy(store, stats && stats.days);
      History.flush(store);
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, new Date().toISOString(), { mode: 0o600 });
      return { first, added: r.added, imported };
    }
    // the turns the spend read already holds (this week); recording is idempotent
    const turns = lastTurns || (await Usage.readTurns({ since: Date.now() - 7 * 86400000, cache, ...(root ? { root } : {}) })).turns;
    const r = History.record(store, turns);
    History.flush(store);
    return { first, added: r.added, grown: r.grown };
  } finally {
    historyBusy = false;
  }
}

parentPort.on('message', async (msg) => {
  if (msg && msg.type === 'history.tick') {
    try {
      const r = await historyTick(msg);
      if (r) parentPort.postMessage({ type: 'history.done', ...r });
    } catch (err) {
      parentPort.postMessage({ type: 'history.error', error: err.message });
    }
    return;
  }
  const { id, root, since } = msg;
  try {
    const r = await Usage.readTurns({ since, cache, ...(root ? { root } : {}) });
    const files = `${r.files}:${cache.size}`;
    const unchanged = r.parsed === 0 && files === lastFiles;
    lastFiles = files;
    if (!unchanged) lastTurns = r.turns;
    parentPort.postMessage({ id, unchanged, turns: unchanged ? null : r.turns, parsed: r.parsed, files: r.files });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
