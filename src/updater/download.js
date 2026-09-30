// Downloads one release file and proves it is the signed one.
//
// Resumable: bytes land in <partial>, with <partial>.json remembering the URL,
// the expected sha512 and the server's ETag. A later call sends Range (and
// If-Range when there is an ETag) and appends. The finished file is checked
// by size and sha512 against the signed entry; a resumed file that fails is
// discarded and fetched once more from zero (a corrupt partial), a fresh one
// that fails is refused. Only a verified file is renamed to <dest>.
//
// fetch is WHATWG fetch: Electron's net.fetch in the app, Node's in tests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UpdateError, checkFile } = require('./verify.js');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };

async function hashFile(file) {
  const h = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('base64');
}

function fsError(err) {
  if (err instanceof UpdateError) return err;
  if (err?.code === 'ENOSPC') return new UpdateError('disk-full', 'Not enough disk space for the update.');
  if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EROFS') return new UpdateError('not-writable', `Can't write ${err.path || 'the update folder'}.`);
  return null;
}
const netError = (err) => fsError(err) || new UpdateError('offline', `Download interrupted: ${err?.cause?.code || err?.message || err}`);

async function isVerified(file, entry) {
  if (sizeOf(file) !== entry.size) return false;
  return (await hashFile(file)) === entry.sha512;
}

async function attempt({ fetch, url, entry, partial, onProgress }) {
  const metaPath = `${partial}.json`;
  let meta = readJson(metaPath);
  let have = sizeOf(partial);
  if (have < 0 || !meta || meta.url !== url || meta.sha512 !== entry.sha512 || have > entry.size) {
    fs.rmSync(partial, { force: true });
    have = 0;
    meta = { url, sha512: entry.sha512, etag: null };
  }
  const resumed = have > 0;
  const hash = crypto.createHash('sha512');
  if (have === entry.size) {
    for await (const chunk of fs.createReadStream(partial)) hash.update(chunk);
  } else {
    const headers = {};
    if (have > 0) {
      headers.Range = `bytes=${have}-`;
      if (meta.etag) headers['If-Range'] = meta.etag;
    }
    let res;
    try {
      res = await fetch(url, { headers, cache: 'no-store', redirect: 'follow' }); // privacy-flow: auto-update
    } catch (err) {
      throw netError(err);
    }
    if (res.status === 416) {
      fs.rmSync(partial, { force: true });
      throw Object.assign(new UpdateError('verify', 'The server refused to resume; starting over.'), { restart: true });
    }
    if (res.status !== 200 && res.status !== 206) throw new UpdateError('server', `The download server answered ${res.status}.`);
    let start = 0;
    if (res.status === 206) {
      const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') || '');
      if (!m || Number(m[1]) !== have) throw Object.assign(new UpdateError('server', 'The server resumed at the wrong place.'), { restart: true });
      start = have;
    }
    meta.etag = res.headers.get('etag') || null;
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    if (start > 0) {
      for await (const chunk of fs.createReadStream(partial, { end: start - 1 })) hash.update(chunk);
    }
    const fh = await fs.promises.open(partial, start > 0 ? 'a' : 'w');
    let got = start;
    try {
      onProgress?.({ transferred: got, total: entry.size });
      for await (const chunk of res.body) {
        got += chunk.length;
        if (got > entry.size) throw new UpdateError('verify', `${entry.name} is larger than the signed release says.`);
        const buf = Buffer.from(chunk);
        hash.update(buf);
        await fh.write(buf);
        onProgress?.({ transferred: got, total: entry.size });
      }
    } catch (err) {
      throw fsError(err) || netError(err);
    } finally {
      await fh.close();
    }
    have = got;
  }
  try {
    checkFile(entry, { size: have, sha512: hash.digest('base64') });
  } catch (err) {
    fs.rmSync(partial, { force: true });
    fs.rmSync(metaPath, { force: true });
    if (resumed) err.restart = true;
    throw err;
  }
}

/**
 * → dest, once it holds exactly entry's bytes.
 * opts: { fetch, url, entry: {name, size, sha512}, dir (for the partial), dest, onProgress }
 */
async function download({ fetch, url, entry, dir, dest, onProgress }) {
  if (await isVerified(dest, entry)) return dest;
  const partial = path.join(dir, `${entry.name}.part`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw fsError(err) || err;
  }
  try {
    await attempt({ fetch, url, entry, partial, onProgress });
  } catch (err) {
    if (!err.restart) throw err;
    await attempt({ fetch, url, entry, partial, onProgress });
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(partial, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(partial, dest);
      fs.rmSync(partial, { force: true });
    }
  } catch (err) {
    throw fsError(err) || err;
  }
  fs.rmSync(`${partial}.json`, { force: true });
  // A copy across volumes is re-read: dest is what gets installed.
  if (!(await isVerified(dest, entry))) {
    fs.rmSync(dest, { force: true });
    throw new UpdateError('verify', `${entry.name} changed on disk after it was checked.`);
  }
  return dest;
}

// Partials older than maxAgeMs, and any that aren't for keepName, go.
function cleanPartials(dir, { keepName = null, maxAgeMs = 3 * 24 * 3600000, now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/\.part(\.json)?$/.test(n)) continue;
    const base = n.replace(/\.part(\.json)?$/, '');
    let old = true;
    try { old = now - fs.statSync(path.join(dir, n)).mtimeMs > maxAgeMs; } catch { /* gone */ }
    if (old || (keepName && base !== keepName)) fs.rmSync(path.join(dir, n), { force: true });
  }
}

module.exports = { download, cleanPartials, hashFile };
