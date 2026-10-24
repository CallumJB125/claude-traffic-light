'use strict';
// Safe whole-file reads and writes at relative paths under one root folder
// (the home folder, or a project folder the person chose). Shared by personal
// setups (src/setups-personal.js) and agent installs (src/agent-install.js).
//
// Every path is walked from the root one component at a time with lstat: any
// link, any non-folder parent and any non-file target is refused. Writes go
// to an O_EXCL temp file beside the target, are never executable, are fsynced
// and then renamed into place (or, with `exclusive`, linked into place so an
// existing file is never replaced).
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

function createHomeFiles({ home, fsApi = fs, maxBytes = 16 * 1024 * 1024 }) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('home files need an absolute root');
  const HOME = path.resolve(home);

  // Every component must be a real name: no empty, "." or ".." parts.
  function partsOf(file) {
    const parts = String(file).split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..') || !path.join(HOME, ...parts).startsWith(HOME + path.sep)) throw new Error('outside home');
    return parts;
  }
  function locate(file) {
    const parts = partsOf(file);
    const full = path.join(HOME, ...parts);
    let cur = HOME;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      let st;
      try { st = fsApi.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return { full, exists: false }; throw e; }
      if (st.isSymbolicLink()) throw new Error('link');
      if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error('not a regular file');
    }
    return { full, exists: true };
  }
  function readTarget(file) {
    const { full, exists } = locate(file);
    if (!exists) return { full, text: null, mode: null };
    let fd;
    try {
      fd = fsApi.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      const st = fsApi.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) throw new Error('unsupported target');
      const buf = Buffer.alloc(st.size);
      let at = 0;
      while (at < buf.length) { const n = fsApi.readSync(fd, buf, at, buf.length - at, at); if (n < 1) break; at += n; }
      const bytes = buf.subarray(0, at), text = bytes.toString('utf8');
      // utf8: false when the bytes don't survive decoding (invalid UTF-8 reads
      // as U+FFFD), so a hash of `text` would not be a hash of the file.
      return { full, text, mode: st.mode & 0o777, bytesSha256: createHash('sha256').update(bytes).digest('hex'), utf8: Buffer.from(text, 'utf8').equals(bytes) };
    } finally { if (fd !== undefined) fsApi.closeSync(fd); }
  }
  function writeTarget(file, text, mode, { exclusive = false } = {}) {
    // Checked before any folder is made, so a bad path creates nothing.
    const parts = partsOf(file);
    let cur = HOME, parent = fsApi.lstatSync(HOME);
    for (const part of parts.slice(0, -1)) {
      cur = path.join(cur, part);
      try { fsApi.mkdirSync(cur, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      parent = fsApi.lstatSync(cur);
      if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('link');
    }
    // The folder written into must still be the one checked above.
    const sameParent = () => { const st = fsApi.lstatSync(cur); if (st.isSymbolicLink() || st.dev !== parent.dev || st.ino !== parent.ino) throw new Error('folder changed'); };
    const full = path.join(cur, parts.at(-1));
    const tmp = path.join(cur, `.${parts.at(-1)}.plexiform-${randomUUID()}.tmp`);
    let fd;
    try {
      // Never executable: a written file keeps at most read/write bits.
      fd = fsApi.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, (Number.isInteger(mode) ? mode : 0o600) & 0o666);
      fsApi.fchmodSync(fd, (Number.isInteger(mode) ? mode : 0o600) & 0o666);
      fsApi.writeFileSync(fd, text, 'utf8');
      fsApi.fsyncSync(fd);
      fsApi.closeSync(fd); fd = undefined;
      locate(file);
      sameParent();
      if (exclusive) { fsApi.linkSync(tmp, full); fsApi.unlinkSync(tmp); } else fsApi.renameSync(tmp, full);
    } catch (e) {
      if (fd !== undefined) try { fsApi.closeSync(fd); } catch { /* already closed */ }
      try { fsApi.unlinkSync(tmp); } catch { /* never created */ }
      throw e;
    }
  }
  function removeTarget(file) { const { full, exists } = locate(file); if (exists) fsApi.unlinkSync(full); }

  return { HOME, locate, readTarget, writeTarget, removeTarget };
}

module.exports = { createHomeFiles, NOFOLLOW, NONBLOCK };
