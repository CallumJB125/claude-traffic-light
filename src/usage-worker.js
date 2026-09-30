// F1 spend: reads transcripts off the main thread. Owns its own incremental
// file cache, so after the first pass a read stats the files and parses only
// what was appended. Answers { unchanged: true } when nothing was parsed and
// no file came or went, so the main thread isn't handed the same turns again.
const { parentPort } = require('worker_threads');
const Usage = require('../usage.js');

const cache = new Map();
let lastFiles = null;

parentPort.on('message', async ({ id, root, since }) => {
  try {
    const r = await Usage.readTurns({ since, cache, ...(root ? { root } : {}) });
    const files = `${r.files}:${cache.size}`;
    const unchanged = r.parsed === 0 && files === lastFiles;
    lastFiles = files;
    parentPort.postMessage({ id, unchanged, turns: unchanged ? null : r.turns, parsed: r.parsed, files: r.files });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
