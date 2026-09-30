// Stands in for the app's signal server wherever a blocking hook needs one:
// the per-install token in <home>/token, the token proof on POST
// /request-key/challenge, and POST /request-key into a real
// requestKeys store (hooks/answer-file.js), so tests answer with the key the
// hook handed over, as the app does. It runs in its own process, so a test
// may drive the hook with spawnSync without starving the server; the keys it
// took are mirrored to a file outside <home> for keyFor().
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER = `
const [token, keysFile, takeKeys] = process.argv.slice(1);
const A = require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'answer-file.js'))});
const fs = require('fs');
const keys = A.requestKeys();
const seen = {};
const srv = require('http').createServer((q, r) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    let d = {};
    try { d = JSON.parse(body); } catch {}
    if (q.method === 'POST' && q.url === '/request-key/challenge') {
      r.writeHead(200, { connection: 'close', 'content-type': 'application/json' });
      return r.end(JSON.stringify({ proof: A.requestKeyProof(token, q.socket.localPort, String(d.nonce)) }));
    }
    const ok = takeKeys === '1' && q.method === 'POST' && q.url === '/request-key' && q.headers['x-buddy-token'] === token && keys.register(d.id, d.key);
    if (ok) { seen[d.id] = d.key; fs.writeFileSync(keysFile, JSON.stringify(seen)); }
    r.writeHead(ok ? 200 : 409, { connection: 'close' });
    r.end();
  });
});
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\\n'));
`;

function fakeApp(home, { takeKeys = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'token'), token, { mode: 0o600 });
  const keysFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-fake-app-')), 'keys.json');
  const child = spawn(process.execPath, ['-e', SERVER, token, keysFile, takeKeys ? '1' : '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const keyFor = (id) => {
    try { const hex = JSON.parse(fs.readFileSync(keysFile, 'utf8'))[id]; return hex ? Buffer.from(hex, 'hex') : null; } catch { return null; }
  };
  return new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve({ port: Number(out.trim()), keyFor, close: () => child.kill() });
    });
  });
}

module.exports = { fakeApp };
