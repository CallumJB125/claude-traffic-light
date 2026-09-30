// A fake download.plexiform.dev on 127.0.0.1 for the updater tests: static
// files with ETag and Range, a switch to cut a response half way, and a log
// of every request. Plus a test key pair and a signed-release builder.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../src/updater/verify.js');

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, keys: V.loadKeys([publicKey.export({ type: 'spki', format: 'pem' })]) };
}

const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');

async function startFeed() {
  const files = new Map();
  const requests = [];
  const cut = new Map(); // path → bytes to send before dropping the connection (once)
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push({ path: p, range: req.headers.range || null, ifRange: req.headers['if-range'] || null });
    const body = files.get(p);
    if (!body) { res.writeHead(404); res.end(); return; }
    const etag = `"${sha(body).slice(0, 16)}"`;
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const rangeOk = m && (!req.headers['if-range'] || req.headers['if-range'] === etag);
    if (rangeOk) {
      start = Number(m[1]);
      if (start >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }); res.end(); return; }
      res.writeHead(206, { etag, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, 'content-length': body.length - start });
    } else {
      res.writeHead(200, { etag, 'content-length': body.length });
    }
    const slice = body.subarray(start);
    if (cut.has(p)) {
      const n = cut.get(p);
      cut.delete(p);
      res.write(slice.subarray(0, n), () => setTimeout(() => res.socket.destroy(), 20));
      return;
    }
    res.end(slice);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, files, requests, cut,
    put: (p, body) => files.set(p, Buffer.isBuffer(body) ? body : Buffer.from(body)),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/**
 * Publishes a signed release at <prefix>release.json(.sig) and its files at <prefix><name>.
 * files: [{ name, body, platform, arch, kind }]; tamper: { manifest?, file? } for the bad cases.
 */
function publish(feed, { prefix = '/', privateKey, version, channel = 'stable', rollback = false, issuedAt = new Date().toISOString(), product = 'plexiform', notes = `Plexiform ${version}`, files, servedBodies = {} }) {
  const manifest = {
    product, channel, version, issuedAt, rollback, notes,
    files: files.map((f) => ({ name: f.name, sha512: sha(f.body), size: Buffer.byteLength(f.body), platform: f.platform, arch: f.arch, kind: f.kind })),
  };
  const json = Buffer.from(JSON.stringify(manifest, null, 2));
  feed.put(`${prefix}release.json`, json);
  feed.put(`${prefix}release.json.sig`, crypto.sign(null, json, privateKey).toString('base64'));
  for (const f of files) feed.put(`${prefix}${f.name}`, servedBodies[f.name] ?? f.body);
  return manifest;
}

const tmpDir = (tag) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `updater-${tag}-`));

module.exports = { keyPair, startFeed, publish, sha, tmpDir };
