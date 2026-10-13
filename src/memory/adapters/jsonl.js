'use strict';

// Incremental reads of an append-only JSONL transcript (Claude Code, Codex):
// only the bytes after the last complete line already indexed, in bounded
// chunks, so a pass over a 100 MB transcript never holds it in memory. Runs
// in the memory worker only.

const fs = require('node:fs');

const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;

// → { lines, offset, skipping, done }. `offset` is where the next read starts;
// a line longer than MAX_LINE is skipped whole (skipping carries across reads).
function readAppended(file, offset = 0, skipping = false) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (offset > size) return { lines: [], offset: 0, skipping: false, done: false, reset: true };
    const len = Math.min(CHUNK, size - offset);
    if (len <= 0) return { lines: [], offset, skipping, done: true };
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, offset);
    const last = buf.subarray(0, n).lastIndexOf(10);
    if (last < 0) {
      // No newline in a full chunk: one oversized line, skipped. A short tail is an unfinished line.
      if (n >= CHUNK || n >= MAX_LINE) return { lines: [], offset: offset + n, skipping: true, done: offset + n >= size };
      return { lines: [], offset, skipping, done: true };
    }
    const lines = buf.subarray(0, last).toString('utf8').split('\n');
    if (skipping) lines.shift();
    return { lines, offset: offset + last + 1, skipping: false, done: offset + last + 1 >= size };
  } finally { fs.closeSync(fd); }
}

const parseJson = (s) => { if (typeof s !== 'string' || !s || s.length > MAX_LINE) return null; try { const d = JSON.parse(s); return d && typeof d === 'object' ? d : null; } catch { return null; } };
const msOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(t) ? t : null; };

module.exports = { readAppended, parseJson, msOf, CHUNK, MAX_LINE };
