'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { STACKS } = require('./starter-pack.js');

const TIMEOUT_MS = 1500, MAX_FOLDERS = 20;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeFolders = values => (Array.isArray(values) ? values : []).slice(0, MAX_FOLDERS)
  .filter(v => object(v) && typeof v.cwd === 'string' && path.isAbsolute(v.cwd) && v.cwd.length <= 4096 && !v.cwd.includes('\0') && Number.isFinite(v.at))
  .map(v => ({ cwd: v.cwd, at: v.at }));
function projection(value, folders) {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) return [];
  const allowed = new Map(folders.map(f => [f.cwd, f.at])), seen = new Set();
  const out = [];
  for (const v of value) {
    if (!object(v) || !allowed.has(v.cwd) || seen.has(v.cwd) || v.at !== allowed.get(v.cwd) || v.folder !== path.basename(v.cwd)
      || !Array.isArray(v.stacks) || !v.stacks.length || v.stacks.length > STACKS.length || !v.stacks.every(s => STACKS.includes(s)) || new Set(v.stacks).size !== v.stacks.length) return [];
    seen.add(v.cwd); out.push({ cwd: v.cwd, folder: v.folder, at: v.at, stacks: [...v.stacks] });
  }
  return out;
}

function createDetector({ timeoutMs = TIMEOUT_MS, startWorker = data => new Worker(path.join(__dirname, 'starter-pack-worker.js'), { workerData: data }) } = {}) {
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
  let pending = null, stopped = false, closing = null;
  function detect(values) {
    if (stopped) return Promise.resolve([]);
    const folders = safeFolders(values), key = JSON.stringify(folders);
    if (!folders.length) return Promise.resolve([]);
    // A timed-out filesystem call may still be blocked in the OS. Keep its
    // worker until exit; refresh never accumulates workers or queued scans.
    if (pending) return pending.key === key ? pending.result : Promise.resolve([]);
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const pass = { key, folders, result, resolve, worker: null, timer: null, settled: false };
    pending = pass;
    const settle = value => {
      if (pass.settled) return;
      pass.settled = true; clearTimeout(pass.timer); pass.resolve(value);
    };
    try {
      const worker = pass.worker = startWorker({ folders }); // privacy-flow: local-worker
      worker.on('message', message => {
        if (pending !== pass || stopped || pass.settled || message?.type !== 'detected') return;
        settle(projection(message.detected, folders));
      });
      worker.on('error', () => settle([]));
      worker.once('exit', () => { settle([]); if (pending === pass) pending = null; });
      worker.unref?.();
      pass.timer = setTimeout(() => settle([]), deadline);
    } catch {
      settle([]); if (pending === pass) pending = null;
    }
    return result;
  }
  function close() {
    if (closing) return closing;
    stopped = true;
    const pass = pending;
    if (pass) {
      clearTimeout(pass.timer);
      if (!pass.settled) { pass.settled = true; pass.resolve([]); }
    }
    // The thread is unreferenced, so even a native open that has not returned
    // cannot keep app shutdown alive. Retain the termination promise for tests.
    try { closing = Promise.resolve(pass?.worker?.terminate?.()).then(() => undefined, () => undefined); }
    catch { closing = Promise.resolve(); }
    return closing;
  }
  return { detect, close };
}

module.exports = { createDetector, TIMEOUT_MS };
