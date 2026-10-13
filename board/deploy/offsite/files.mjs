import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, encode, OffsiteError } from './schema.mjs';

export function directory(dir, { create = false } = {}) {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) fail('PATH');
  const pieces = dir.split(path.sep).filter(Boolean); let current = path.parse(dir).root;
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]);
    if (i === pieces.length - 1 && create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const s = fs.lstatSync(current); if (s.isSymbolicLink() || !s.isDirectory()) fail('PATH');
  }
  if (fs.lstatSync(dir).mode & 0o077) fail('PRIVATE_MODE');
  return dir;
}
export function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function open(file, max = Infinity) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.mode & 0o077 || !Number.isSafeInteger(s.size) || s.size > max) fail('PRIVATE_FILE');
    return { fd, size: s.size };
  } catch (e) { fs.closeSync(fd); throw e; }
}
export function readJson(file, max) {
  const { fd } = open(file, max);
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { fail(); } finally { fs.closeSync(fd); }
}
export function writeAll(fd, bytes) {
  let off = 0; while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
}
export const exclusive = (file) => fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
export function json(file, data) {
  const fd = exclusive(file);
  try { writeAll(fd, encode(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(path.dirname(file));
}
export function replaceJson(file, data) {
  const temp = path.join(path.dirname(file), `.state-${randomUUID()}`);
  try { json(temp, data); fs.renameSync(temp, file); syncDir(path.dirname(file)); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function digest(file, max = Infinity) {
  const { fd, size } = open(file, max), h = createHash('sha256'), b = Buffer.alloc(128 * 1024); let length = 0;
  try {
    let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) { length += n; if (length > size || length > max) fail('LIMITS'); h.update(b.subarray(0, n)); }
    if (length !== size || fs.fstatSync(fd).size !== size) fail('CHANGED');
    return { sha256: h.digest('hex'), byte_length: length };
  } finally { fs.closeSync(fd); }
}
export function check(file, expected, max = expected.byte_length) {
  const actual = digest(file, max);
  if (actual.byte_length !== expected.byte_length || actual.sha256 !== expected.sha256) fail('BYTES');
  return actual;
}
export async function* source(file, { start = 0, length = null } = {}) {
  const { fd, size } = open(file); const limit = length ?? size; let off = 0;
  try {
    if (start < 0 || limit < 0 || start + limit > size) fail('BYTES');
    while (off < limit) {
      const b = Buffer.alloc(Math.min(128 * 1024, limit - off)), n = fs.readSync(fd, b, 0, b.length, start + off);
      if (!n) fail('CHANGED'); off += n; yield b.subarray(0, n);
    }
    if (fs.fstatSync(fd).size !== size) fail('CHANGED');
  } finally { fs.closeSync(fd); }
}
export async function consume(stream, file, { max, expected = null, signal } = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function' || !Number.isSafeInteger(max) || max < 1) fail('BYTES');
  const iterator = stream[Symbol.asyncIterator]();
  const fd = exclusive(file), h = createHash('sha256'); let size = 0;
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(new OffsiteError('ABORTED')); signal?.addEventListener('abort', abort, { once: true }); });
  try {
    while (true) {
      if (signal?.aborted) fail('ABORTED');
      const { done, value } = await Promise.race([iterator.next(), cancelled]); if (done) break;
      const b = Buffer.from(value); size += b.length; if (size > max) fail('LIMITS'); writeAll(fd, b); h.update(b);
    }
    const sha256 = h.digest('hex');
    if (expected && (size !== expected.byte_length || sha256 !== expected.sha256)) fail('BYTES');
    fs.fsyncSync(fd); return { sha256, byte_length: size };
  } finally { signal?.removeEventListener('abort', abort); stream.destroy?.(); fs.closeSync(fd); }
}
export function usage(root) {
  let total = 0;
  const walk = dir => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, d.name), s = fs.lstatSync(file);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) fail('PATH');
    if (s.isDirectory()) walk(file); else total += s.size;
    if (!Number.isSafeInteger(total)) fail('LIMITS');
  } }; walk(root); return total;
}
export async function locked(root, fn) {
  directory(root, { create: true }); const lock = path.join(root, '.lock'), token = randomUUID();
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const reaper = path.join(root, '.reaper');
    try { fs.mkdirSync(reaper, { mode: 0o700 }); } catch { fail('LOCKED'); }
    try {
      // Serialize stale-lock reclamation and reread under that reservation.
      // An interrupted reaper is left for explicit operator repair.
      directory(lock); let owner;
      try { owner = readJson(path.join(lock, 'owner.json'), 1024); } catch { fail('LOCKED'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') fail('LOCKED');
      try { process.kill(owner.pid, 0); fail('LOCKED'); } catch (p) { if (p.code !== 'ESRCH') throw p; }
      fs.rmSync(lock, { recursive: true });
      try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('LOCKED'); }
      json(path.join(lock, 'owner.json'), { pid: process.pid, token });
    } finally { fs.rmdirSync(reaper); }
  }
  if (!fs.existsSync(path.join(lock, 'owner.json'))) json(path.join(lock, 'owner.json'), { pid: process.pid, token });
  syncDir(root);
  try { return await fn(); }
  finally {
    const owner = readJson(path.join(lock, 'owner.json'), 1024);
    if (owner.token === token) { fs.rmSync(lock, { recursive: true }); syncDir(root); }
  }
}
