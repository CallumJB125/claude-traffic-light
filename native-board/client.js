'use strict';
const fs = require('node:fs');
const http = require('node:http'); // privacy-flow: local-mcp

function readGrant(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 8192 || (process.getuid && s.uid !== process.getuid()) || (process.platform !== 'win32' && (s.mode & 0o077))) throw new Error('Connection file must be private.');
    const g = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (g.version !== 1 || typeof g.socketPath !== 'string' || !/^[a-f0-9]{64}$/.test(g.token) || !['read', 'collaborate'].includes(g.mode)) throw new Error('Invalid connection file.');
    return g;
  } finally { fs.closeSync(fd); }
}

function request(file, name, args) {
  let g;
  try { g = readGrant(file); } catch { return Promise.resolve({ ok: false, code: 'UNAVAILABLE', error: 'Reconnect this app in Plexiform Settings.' }); }
  const body = JSON.stringify({ name, args });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({ socketPath: g.socketPath, path: '/call', method: 'POST', headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 20000 }, (res) => { // privacy-flow: local-mcp
      const chunks = []; let n = 0;
      res.on('data', (chunk) => { n += chunk.length; if (n > 2 * 1024 * 1024) res.destroy(); else chunks.push(chunk); });
      res.on('error', () => finish({ ok: false, error: 'Board response could not be read.' }));
      res.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish({ ok: false, error: 'Board response could not be read.' }); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish({ ok: false, code: 'UNAVAILABLE', error: 'Open Plexiform and sign in to use the boards.' }));
    req.end(body);
  });
}
module.exports = { readGrant, request };
