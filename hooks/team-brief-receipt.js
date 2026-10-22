'use strict';
// A receipt means stdout was written to the provider hook, not that an agent
// read, agreed with, or acted on it. Store only an opaque version, never text.
// One hook output can carry several receipts (the awareness roster and the
// team brief in one additionalContext), each written once the output is.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VERSION = /^[a-f0-9]{64}$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const prepared = new WeakMap();

function fileFor(root, adapter, session, cwd) {
  if (typeof session !== 'string' || !session || session.length > 120) return null;
  const key = crypto.createHash('sha256').update(JSON.stringify([adapter, session, cwd])).digest('hex');
  return path.join(root, 'team-brief-receipts', `${key}.json`);
}

function read(file, now = Date.now()) {
  if (!file) return null;
  let fd;
  try {
    if (!fs.lstatSync(path.dirname(file)).isDirectory()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 2048) return null;
    const r = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return r && r.v === 1 && VERSION.test(r.version) && r.status === 'hook_output_written'
      && Number.isSafeInteger(r.prepared_at) && Number.isSafeInteger(r.written_at)
      && r.written_at <= now && now - r.written_at < MAX_AGE_MS ? r : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function prepareMany(out, entries) {
  if (!out || typeof out !== 'object') return out;
  const list = (prepared.get(out) || []).concat((entries || []).filter((e) => e && e.file && VERSION.test(e.version)).map((e) => ({ file: e.file, version: e.version, at: Number.isSafeInteger(e.at) ? e.at : Date.now() })));
  if (list.length) prepared.set(out, list);
  return out;
}

function prepare(out, file, version, at = Date.now()) {
  return prepareMany(out, [{ file, version, at }]);
}

// The receipts an output carries, to move onto a combined output.
const preparedOf = (out) => (out && typeof out === 'object' ? [...(prepared.get(out) || [])] : []);

function writeOne(r) {
  let tmp;
  try {
    const dir = path.dirname(r.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(dir).isDirectory()) return false;
    const previous = read(r.file);
    if (previous && previous.prepared_at > r.at) return false;
    tmp = `${r.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, version: r.version, prepared_at: r.at, written_at: Date.now(), status: 'hook_output_written', agent_acknowledgement: 'not_observed' }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, r.file);
    return true;
  } catch { return false; } finally { if (tmp) { try { fs.unlinkSync(tmp); } catch {} } }
}

function recordDelivered(out) {
  const list = out && typeof out === 'object' ? prepared.get(out) : null;
  if (!list) return false;
  prepared.delete(out);
  let ok = true;
  for (const r of list) ok = writeOne(r) && ok;
  return ok;
}

module.exports = { fileFor, read, prepare, prepareMany, preparedOf, recordDelivered, VERSION };
