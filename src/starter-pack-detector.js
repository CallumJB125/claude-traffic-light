'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
const { STACKS } = require('./starter-pack.js');

const TIMEOUT_MS = 1500, RETRY_MS = 45_000, MAX_FOLDERS = 20;
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

function startDetectorProcess() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  return fork(path.join(__dirname, 'starter-pack-process.js'), [], {
    execPath: process.execPath, execArgv: [], env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
  });
}
function createDetector({ timeoutMs = TIMEOUT_MS, startProcess = startDetectorProcess, now = Date.now } = {}) {
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
  let pending = null, stopped = false, closing = null, failed = null;
  function detect(values) {
    if (stopped) return Promise.resolve([]);
    const folders = safeFolders(values), key = JSON.stringify(folders), failureKey = JSON.stringify(folders.map(f => f.cwd));
    if (!folders.length) return Promise.resolve([]);
    // A child has its own native filesystem threads. Unlike Worker threads,
    // its blocked open cannot make Node join that thread during app shutdown.
    // Retain the pending slot until actual exit, even after asking it to die.
    if (pending) return pending.key === key ? pending.result : Promise.resolve([]);
    if (failed?.key === failureKey && failed.until > now()) return Promise.resolve([]);
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const pass = { key, folders, result, resolve, child: null, timer: null, settled: false };
    pending = pass;
    const settle = value => {
      if (pass.settled) return;
      pass.settled = true; clearTimeout(pass.timer); pass.resolve(value);
    };
    const kill = () => { try { pass.child?.kill('SIGKILL'); } catch { /* already gone */ } };
    const unavailable = () => { failed = { key: failureKey, until: now() + RETRY_MS }; settle([]); kill(); };
    try {
      const child = pass.child = startProcess(); // privacy-flow: local-worker
      child.on('message', message => {
        if (pending !== pass || stopped || pass.settled || message?.type !== 'detected') return;
        settle(projection(message.detected, folders));
      });
      child.once('error', unavailable);
      const exited = () => { settle([]); if (pending === pass) pending = null; };
      child.once('exit', exited); child.once('close', exited);
      child.unref?.(); child.channel?.unref?.();
      pass.timer = setTimeout(unavailable, deadline);
      // Folder paths stay out of command lines and environment values.
      child.send({ type: 'detect', folders }, error => { if (error && !pass.settled && !stopped) unavailable(); });
    } catch {
      unavailable(); if (!pass.child && pending === pass) pending = null;
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
    try { pass?.child?.kill('SIGKILL'); } catch { /* already gone */ }
    // Do not wait for native I/O or child exit in the app's quit listener.
    closing = Promise.resolve();
    return closing;
  }
  return { detect, close };
}

module.exports = { createDetector, TIMEOUT_MS, RETRY_MS };
