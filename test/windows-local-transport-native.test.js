'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const Private = require('../board/shared/windows-private-directory.cjs');
const Local = require('../board/shared/local-sockets.cjs');
function prepare(root) {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = [Console]::In.ReadToEnd()
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($me); $acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @($me, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $root -AclObject $acl
`;
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { input: root, encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true, shell: false });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return Private.ensureDirectory(root);
}
function pipeName(identity, role = 1) {
  const bytes = Buffer.alloc(56);
  bytes.writeBigUInt64LE(BigInt('0x' + identity.volume), 0); Buffer.from(identity.fileId, 'hex').copy(bytes, 8); bytes.writeUInt32LE(role, 24);
  return '\\\\.\\pipe\\Plexiform-local-v1-' + crypto.createHash('sha256').update(bytes).digest('hex');
}

test('native Windows broker authenticates helpers, multiplexes bounded streams, refuses collisions and preserves private tokens', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-transport-native-'));
  const peers = [], clients = []; let server, rogue;
  try {
    const identity = prepare(root), endpoint = path.join(root, 'tasks.sock');
    const token = Local.token(endpoint, true);
    assert.match(token, /^btk_[A-Za-z0-9_-]{43}$/);
    assert.equal(Local.token(endpoint, false), token); assert.equal(Local.token(endpoint, true), token);
    const malformed = Buffer.from(token + '\n'); malformed[4] = 0;
    fs.writeFileSync(path.join(root, 'tasks.token'), malformed);
    const rejectedToken = spawnSync(path.join(path.dirname(Private.helperPath()), 'windows-local-transport.exe'), [], {
      input: Local.request('R', endpoint), timeout: 5000, maxBuffer: 256, shell: false, windowsHide: true,
    });
    assert.equal(rejectedToken.error, undefined); assert.equal(rejectedToken.status, 2, 'native token parser refuses embedded NUL');
    fs.writeFileSync(path.join(root, 'tasks.token'), token + '\n');
    server = Local.createServer(c => { peers.push(c); c.on('error', () => {}); c.on('data', data => c.write(data)); });
    const ready = once(server, 'listening'); server.listen(endpoint); await ready;
    assert.equal(Local.token(endpoint, false), token, 'independent read leases coexist with the listening server');
    assert.deepEqual(Private.ensureDirectory(root), identity, 'startup reopens a root retained by the broker');
    const childPath = path.join(root, 'new-child');
    const childIdentity = Private.ensureDirectory(childPath);
    assert.deepEqual(Private.ensureDirectory(childPath), childIdentity, 'relative child creation coexists with the broker lease');
    const collision = Local.createServer(); const refused = once(collision, 'error'); collision.listen(endpoint); await refused;
    const before = peers.length;
    rogue = net.createConnection(pipeName(identity)); rogue.on('error', () => {});
    const rogueClosed = new Promise(resolve => rogue.once('close', resolve)); await rogueClosed;
    assert.equal(peers.length, before, 'an unverified Node process never becomes an application connection');
    await Promise.all(Array.from({ length: 4 }, async (_, n) => {
      const c = Local.createConnection(endpoint); clients.push(c); c.on('error', () => {}); await once(c, 'connect');
      const payload = Buffer.alloc(1024 * 1024 + 17, n + 1), chunks = []; let length = 0;
      const received = new Promise((resolve, reject) => { c.once('error', reject); c.on('data', b => { chunks.push(b); length += b.length; if (length === payload.length) resolve(Buffer.concat(chunks)); }); });
      c.write(payload); assert.deepEqual(await received, payload);
    }));
    assert.equal(peers.length, 4);
    // Fill all slots, then refuse overflow without losing the listener or peers.
    for (let n = 4; n < 32; n++) {
      const admitted = once(server, 'connection');
      const c = Local.createConnection(endpoint); clients.push(c); c.on('error', () => {});
      await Promise.all([once(c, 'connect'), admitted]);
    }
    // The client OPEN verifies identity before server admission, so closure is
    // the observable refusal whether connect has already been emitted or not.
    const overflow = Local.createConnection(endpoint); clients.push(overflow); overflow.on('error', () => {});
    await new Promise(resolve => overflow.once('close', resolve));
    assert.equal(peers.length, 32, 'overflow never becomes an application connection');
    const survivor = clients[31], echoed = once(survivor, 'data');
    survivor.write('capacity-survivor');
    assert.equal((await echoed)[0].toString(), 'capacity-survivor');
    // Back up shared stdout, then close a stream whose worker may be emitting
    // a partial frame. Cancelling it must not truncate the broker byte stream.
    server.bridge.child.stdout.pause();
    for (const c of clients.slice(0, 16)) c.write(Buffer.alloc(65536, 42));
    await new Promise(resolve => setTimeout(resolve, 100));
    peers[0].destroy();
    server.bridge.child.stdout.resume();
    const afterCancel = once(survivor, 'data'); survivor.write('cancel-survivor');
    assert.equal((await afterCancel)[0].toString(), 'cancel-survivor');
    for (const c of clients) c.destroy();
    await new Promise(resolve => server.close(resolve)); server = null;
    // A same-user listener with the wrong executable must not receive a token.
    let exposed = false;
    const impostor = net.createServer(c => { c.on('data', () => { exposed = true; }); c.on('error', () => {}); });
    await new Promise((resolve, reject) => { impostor.once('error', reject); impostor.listen(pipeName(identity), resolve); });
    const denied = Local.createConnection(endpoint); denied.write(token); await once(denied, 'error');
    await new Promise(resolve => impostor.close(resolve)); assert.equal(exposed, false);
  } finally {
    rogue?.destroy(); for (const c of clients) c.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
