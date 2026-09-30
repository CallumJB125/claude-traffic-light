// Small runner-local helpers: JSON-line logging, atomic 0600 writes, clocks.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const RUNNER_VERSION = '0.1.0';

// Stderr JSON lines (CONTRACT §14). Never pass tokens or card bodies here.
export function makeLogger(stream = process.stderr, { quiet = false } = {}) {
  const write = (level, msg, fields) => {
    if (quiet && level !== 'error') return;
    try { stream.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`); } catch { /* closed stream */ }
  };
  return {
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
    debug: (msg, f) => { if (process.env.BOARD_DEBUG) write('debug', msg, f); },
  };
}

export const realClock = Object.freeze({ mono: () => performance.now(), wall: () => Date.now() });

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ }
  return dir;
}

export function writeFileAtomic(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj, mode = 0o600) {
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`, mode);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, onTimeout) {
  let t;
  return Promise.race([
    promise,
    new Promise((resolve) => { t = setTimeout(() => resolve(onTimeout()), ms); }),
  ]).finally(() => clearTimeout(t));
}

export function clip(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Line splitter for NDJSON streams with a per-line cap.
export function lineReader(onLine, { maxLine = 1 << 20, onOverflow } = {}) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > maxLine) { buf = ''; onOverflow?.(); }
  };
}
