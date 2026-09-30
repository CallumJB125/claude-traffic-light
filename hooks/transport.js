// How a reporter's signed envelope reaches the desktop. Each transport is
// { validate(config) → normalized config | null, create(config) → { name,
// send(envelope) → Promise<{ ok, status?, authentic?, error?, body? }> } }.
// A transport owns its own address and auth fields; send never rejects and
// always settles within its timeout.
//
// 'direct' POSTs to the desktop's device listener: a URL (the end of an
// ssh -R tunnel on loopback, or a Tailscale address) or a unix socket (an
// ssh -R forward to a socket in a 0700 directory, which other users of the
// host can't reach at all). 'hub' is where the board hub plugs in; it
// carries the same envelope, so hooks don't change when it does. Not built.
const fs = require('fs');
const path = require('path');
const Protocol = require('./remote-protocol.js');

const PATH = '/remote/event';
const DEFAULT_TIMEOUT_MS = 800;
const MAX_TIMEOUT_MS = 2000;

// A socket in a directory only this user can enter.
function privateSocket(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  if (process.platform === 'win32') return false;
  try {
    const dir = fs.statSync(path.dirname(p));
    return dir.isDirectory() && (dir.mode & 0o077) === 0 && dir.uid === process.getuid();
  } catch { return false; }
}

const direct = {
  validate(c) {
    if (!c || typeof c !== 'object' || !Protocol.DEVICE_ID.test(String(c.device)) || !Protocol.TOKEN.test(String(c.token))) return null;
    const t = Number(c.timeoutMs);
    const base = { transport: 'direct', device: c.device, token: c.token, timeoutMs: Number.isFinite(t) ? Math.min(MAX_TIMEOUT_MS, Math.max(100, t)) : DEFAULT_TIMEOUT_MS };
    if (c.socketPath !== undefined) return privateSocket(c.socketPath) ? { ...base, socketPath: c.socketPath } : null;
    return Protocol.urlAllowed(c.url) ? { ...base, url: new URL(c.url).origin } : null;
  },
  create({ url, socketPath, device, token, timeoutMs }) {
    const https = !socketPath && new URL(url).protocol === 'https:';
    // https only loads for an https target; the usual tunnel is plain http.
    const mod = https ? require('https') : require('http'); // privacy-flow: remote-reporter
    const target = socketPath ? { socketPath, path: PATH } : new URL(PATH, url);
    return {
      name: 'direct',
      send(envelope) {
        return new Promise((resolve) => {
          let settled = false;
          const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
          const body = Buffer.from(JSON.stringify(envelope));
          const headers = Protocol.signedHeaders({ device, token, body });
          const nonce = headers[Protocol.HEADERS.nonce];
          let req;
          const timer = setTimeout(() => { done({ ok: false, error: 'timeout' }); if (req) req.destroy(); }, timeoutMs);
          try {
            const opts = { method: 'POST', agent: false, headers: { ...headers, 'content-length': body.length } };
            req = socketPath ? mod.request({ ...target, ...opts }, onResponse) : mod.request(target, opts, onResponse); // privacy-flow: remote-reporter
            req.on('error', (e) => done({ ok: false, error: e.code || e.message }));
            req.end(body);
          } catch (e) {
            done({ ok: false, error: e.message });
          }
          function onResponse(res) {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => { size += c.length; if (size <= 4096) chunks.push(c); });
            res.on('end', () => {
              const text = Buffer.concat(chunks);
              // Anything that isn't the desktop (a squatter on the tunnel's
              // port) can answer, but only the desktop can sign with this key.
              const authentic = Protocol.responseAuthentic(token, { nonce, status: res.statusCode, body: text, sig: res.headers[Protocol.HEADERS.sig] });
              let parsed = null;
              if (authentic) { try { parsed = JSON.parse(text.toString('utf8')); } catch {} }
              done({ ok: authentic && res.statusCode === 200, status: res.statusCode, authentic, body: parsed });
            });
            res.on('error', (e) => done({ ok: false, error: e.message }));
          }
        });
      },
    };
  },
};

const TRANSPORTS = { direct };

// The normalized config, or null for an unknown transport or one whose own
// fields don't validate (so a bad remote.json sends nothing).
function validate(config) {
  const t = config && TRANSPORTS[config.transport || 'direct'];
  return t ? t.validate(config) : null;
}

function create(config) {
  const c = validate(config);
  return c ? TRANSPORTS[c.transport].create(c) : null;
}

module.exports = { validate, create, PATH, TRANSPORTS, DEFAULT_TIMEOUT_MS, privateSocket };
