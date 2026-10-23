'use strict';
// src/peer-pid.js against the real process table (macOS only): the socket peer
// of a loopback connection, its parent, and whether its stdin and stdout are
// the ends of streams its parent holds. A stdio child passes; a child whose
// stdin is /dev/null (what a model's shell command gets), one whose stdin is a
// copy of its own stdout (`exec 0<&1`, review #2) and a grandchild do not; and
// an unsigned node is neither Anthropic's nor OpenAI's program (review #1).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const PeerPid = require('../src/peer-pid.js');

const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { encoding: 'utf8', timeout: 5000 }, (e, out) => (e ? reject(e) : resolve(out))));

test('live: peer pid, parent and stdio peering from lsof and ps', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
  const seen = new Map();
  const server = http.createServer((req) => { seen.set(req.headers['x-who'], req.socket.remotePort); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // Each one opens a connection and holds it.
  const dial = (who) => `require('http').request({host:'127.0.0.1',port:${port},method:'POST',headers:{'x-who':'${who}'}}).write('x');setTimeout(()=>{},20000)`;
  const parentCode = `
    const { spawn } = require('child_process');
    const node = process.execPath;
    const stdio = spawn(node, ['-e', ${JSON.stringify(`${dial('stdio')};require('child_process').spawn(process.execPath,['-e',${JSON.stringify(dial('grandchild'))}],{stdio:['pipe','pipe','inherit']})`)}], { stdio: ['pipe', 'pipe', 'inherit'] });
    const shell = spawn(node, ['-e', ${JSON.stringify(dial('shell'))}], { stdio: ['ignore', 'pipe', 'inherit'] });
    const dup = spawn('/bin/sh', ['-c', 'exec 0<&1; exec "$0" -e "$1"', node, ${JSON.stringify(dial('dup'))}], { stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(JSON.stringify({ stdio: stdio.pid, shell: shell.pid, dup: dup.pid }) + '\\n');
    setTimeout(() => {}, 20000);`;
  const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { process.kill(parent.pid); } catch {} for (const p of kids) { try { process.kill(p); } catch {} } server.closeAllConnections(); server.close(); });
  let kids = [];
  const P = PeerPid.create({ run, platform: 'darwin' });
  const pids = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(JSON.parse(String(d)))));
  kids = [pids.stdio, pids.shell, pids.dup];
  for (let i = 0; i < 100 && seen.size < 4; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.size, 4, 'all four connected');
  const fdsOf = async (pid) => PeerPid.parseFds(await P.lsof(pid));

  const stdioPid = await P.peerOf(seen.get('stdio'));
  assert.equal(stdioPid, pids.stdio);
  const me = await P.proc(stdioPid);
  assert.equal(me.ppid, parent.pid);
  assert.ok(me.start.length > 10);
  const fds = await fdsOf(stdioPid);
  assert.ok(fds.cwd && fds.cwd.name.startsWith('/'));
  assert.ok(fds.txt && fds.txt.name.startsWith('/'), 'the executable is the first txt entry');
  assert.equal(PeerPid.stdioPeered(fds, await fdsOf(parent.pid)), true, 'a stdio child of its parent');
  assert.equal(PeerPid.stdioPeered(fds, await fdsOf(parent.pid), 'unix'), true, 'node spawns over socketpairs');
  assert.equal(PeerPid.stdioPeered(fds, await fdsOf(parent.pid), 'PIPE'), false);

  const shellPid = await P.peerOf(seen.get('shell'));
  assert.equal(shellPid, pids.shell);
  assert.equal((await P.proc(shellPid)).ppid, parent.pid, 'a direct child too');
  assert.equal(PeerPid.stdioPeered(await fdsOf(shellPid), await fdsOf(parent.pid)), false, 'but its stdin is /dev/null');

  // `exec 0<&1`: fd 0 and fd 1 are one end, whose other end the parent holds. Review #2: this passed before.
  const dupPid = await P.peerOf(seen.get('dup'));
  assert.equal((await P.proc(dupPid)).ppid, parent.pid);
  const dfds = await fdsOf(dupPid);
  assert.equal(dfds['0'].addr, dfds['1'].addr, 'lsof shows the same end twice');
  assert.equal(PeerPid.stdioPeered(dfds, await fdsOf(parent.pid)), false);

  // The real codesign on a running, unsigned node: neither Anthropic's nor OpenAI's.
  assert.equal(await P.signedAs(stdioPid, 'claude'), false);
  assert.equal(await P.signedAs(stdioPid, 'codex'), false);

  const gPid = await P.peerOf(seen.get('grandchild'));
  kids.push(gPid);
  assert.equal((await P.proc(gPid)).ppid, pids.stdio, 'its parent is the child, not the server');
  assert.equal(PeerPid.stdioPeered(await fdsOf(gPid), await fdsOf(parent.pid)), false);

  // Our own end of the connection is never the answer.
  assert.equal(await P.peerOf(server.address().port), null);
});

// Re-review N1: an inspector (or any port a process listens on) shows in the same lsof listing; a connection out does not count.
test('live: a process with an inspector listening is seen as listening; one that only connects out is not', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dial = `require('http').request({host:'127.0.0.1',port:${server.address().port},method:'POST'}).write('x');setTimeout(()=>{},20000)`;
  const plain = spawn(process.execPath, ['-e', dial], { stdio: ['pipe', 'pipe', 'ignore'] });
  const inspected = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', dial], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { plain.kill('SIGKILL'); inspected.kill('SIGKILL'); server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => inspected.stderr.once('data', resolve));
  await new Promise((r) => setTimeout(r, 300));
  const P = PeerPid.create({ run, platform: 'darwin' });
  assert.equal(PeerPid.listening(PeerPid.parseFds(await P.lsof(inspected.pid))), true);
  assert.equal(PeerPid.listening(PeerPid.parseFds(await P.lsof(plain.pid))), false);
});
