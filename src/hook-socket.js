// The app's end of the fast hook path (hooks/fast-hook.js): a local socket that
// takes one forwarded hook event per connection and answers {"ok":true} only
// when `handle(msg)` ran it. Off unless started; the endpoint file is how a
// hook learns it is on, so stop() removes it first and a hook then goes
// straight to its own full path.
//
// Reachability is the user's own: a unix socket mode 0600 in the data folder,
// or a per-user-named pipe, and every message must carry the per-run token from
// the 0600 endpoint file. A bad token, bad JSON or an oversized message gets
// {"ok":false} and nothing else.
const fs = require('fs');
const net = require('net'); // privacy-flow: local-server
const path = require('path');
const crypto = require('crypto');
const Fast = require('../hooks/fast-hook.js');

function create({ rootDir, handle, platform = process.platform, netImpl = net, fsImpl = fs, log = () => {} }) {
  const token = crypto.randomBytes(32).toString('hex');
  const endpointFile = path.join(rootDir, Fast.ENDPOINT_FILE);
  const sockPath = Fast.pipePath(rootDir, platform);
  let server = null;

  const tokenOk = (sent) => {
    const a = Buffer.from(String(sent || ''));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  function onConnection(socket) {
    let buf = '';
    let replied = false;
    const reply = (ok) => { if (replied) return; replied = true; try { socket.end(JSON.stringify({ ok }) + '\n'); } catch { /* peer gone */ } };
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => { reply(false); socket.destroy(); });
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > Fast.MAX_MESSAGE_BYTES) return reply(false);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { return reply(false); }
      if (!msg || msg.v !== 1 || !tokenOk(msg.token)) return reply(false);
      let ok = false;
      try { ok = handle(msg) === true; } catch (e) { log(`[hook-socket] ${e.message}`); }
      reply(ok);
    });
  }

  function start() {
    if (server) return Promise.resolve(true);
    return new Promise((resolve) => {
      fsImpl.mkdirSync(rootDir, { recursive: true });
      if (platform !== 'win32') { try { fsImpl.rmSync(sockPath, { force: true }); } catch { /* stale socket */ } }
      const s = netImpl.createServer(onConnection);
      s.on('error', (e) => { log(`[hook-socket] ${e.message}`); if (!server) resolve(false); });
      s.listen(sockPath, () => {
        server = s;
        try {
          if (platform !== 'win32') fsImpl.chmodSync(sockPath, 0o600);
          const tmp = `${endpointFile}.tmp.${crypto.randomBytes(6).toString('hex')}`;
          fsImpl.writeFileSync(tmp, JSON.stringify({ v: 1, path: sockPath, token }), { mode: 0o600 });
          fsImpl.renameSync(tmp, endpointFile);
          resolve(true);
        } catch (e) {
          log(`[hook-socket] endpoint file: ${e.message}`);
          stop();
          resolve(false);
        }
      });
    });
  }

  function stop() {
    try { fsImpl.rmSync(endpointFile, { force: true }); } catch { /* already gone */ }
    if (!server) return;
    const s = server;
    server = null;
    try { s.close(); } catch { /* not listening */ }
    if (platform !== 'win32') { try { fsImpl.rmSync(sockPath, { force: true }); } catch { /* gone */ } }
  }

  return { start, stop, token, path: sockPath, get running() { return !!server; } };
}

module.exports = { create };
