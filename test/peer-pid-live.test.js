'use strict';
// src/peer-pid.js against the real process table (macOS only): the socket peer
// of a loopback connection, its parent, and whether its stdin and stdout are
// the ends of streams its parent holds. A stdio child passes; a child whose
// stdin is /dev/null (what a model's shell command gets) and a grandchild do not.
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
    process.stdout.write(JSON.stringify({ stdio: stdio.pid, shell: shell.pid }) + '\\n');
    setTimeout(() => {}, 20000);`;
  const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { process.kill(parent.pid); } catch {} for (const p of kids) { try { process.kill(p); } catch {} } server.close(); });
  let kids = [];
  const pids = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(JSON.parse(String(d)))));
  kids = [pids.stdio, pids.shell];
  for (let i = 0; i < 100 && seen.size < 3; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.size, 3, 'all three connected');
  const P = PeerPid.create({ run, platform: 'darwin' });

  const stdioPid = await P.peerOf(seen.get('stdio'));
  assert.equal(stdioPid, pids.stdio);
  const me = await P.proc(stdioPid);
  assert.equal(me.ppid, parent.pid);
  assert.ok(me.start.length > 10);
  const fds = await P.fds(stdioPid, '0,1,cwd');
  assert.ok(fds.cwd && fds.cwd.name.startsWith('/'));
  assert.equal(PeerPid.stdioPeered(fds, await P.fds(parent.pid)), true, 'a stdio child of its parent');

  const shellPid = await P.peerOf(seen.get('shell'));
  assert.equal(shellPid, pids.shell);
  assert.equal((await P.proc(shellPid)).ppid, parent.pid, 'a direct child too');
  assert.equal(PeerPid.stdioPeered(await P.fds(shellPid, '0,1,cwd'), await P.fds(parent.pid)), false, 'but its stdin is /dev/null');

  const gPid = await P.peerOf(seen.get('grandchild'));
  kids.push(gPid);
  assert.equal((await P.proc(gPid)).ppid, pids.stdio, 'its parent is the child, not the server');
  assert.equal(PeerPid.stdioPeered(await P.fds(gPid, '0,1,cwd'), await P.fds(parent.pid)), false);

  // Our own end of the connection is never the answer.
  assert.equal(await P.peerOf(server.address().port), null);
});
