// Socket, token and frame hardening of the real engine (TASKS-CONTRACT §3, §4, §9.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startTasksEngine } from '../index.js';
import { connect } from '../../tasks-api/client.js';
import { MAX_FRAME_BYTES } from '../../tasks-api/protocol.js';
import { TaskStore } from '../store.js';
import { startEngine, fakeBackends, makeRepo, tmpDir, rm, waitFor, ENV } from './helpers.js';

function raw(socketPath, lines, { waitMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    let buf = '';
    const out = [];
    s.setEncoding('utf8');
    s.on('connect', () => { for (const l of lines) s.write(typeof l === 'string' ? l : `${JSON.stringify(l)}\n`); });
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    s.on('close', () => resolve({ out, closed: true }));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve({ out, closed: false }); }, waitMs);
  });
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('data dir 0700, socket 0600, token 0600 btk_; the token survives a restart; a loosened token file is replaced', async () => {
  const dir = tmpDir();
  try {
    let m = await startEngine({ dir });
    assert.equal(fs.statSync(m.dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(m.eng.socketPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(m.eng.tokenPath).mode & 0o777, 0o600);
    assert.match(m.eng.token, /^btk_[A-Za-z0-9_-]{43}$/);
    assert.equal(path.basename(m.eng.socketPath), 'tasks.sock', 'its own socket, not the runner control socket');
    const tok = m.eng.token;
    await m.close();
    m = await startEngine({ dir });
    assert.equal(m.eng.token, tok, 'same token after a restart');
    await m.close();
    fs.chmodSync(path.join(dir, 'data', 'tasks.token'), 0o644);
    m = await startEngine({ dir });
    assert.notEqual(m.eng.token, tok, 'a token others could read is rotated');
    assert.equal(fs.statSync(m.eng.tokenPath).mode & 0o777, 0o600);
    await m.close();
  } finally { rm(dir); }
});

test('refuses a symlinked data dir, something else at the socket path, a live socket, and a too-long path; replaces a stale socket', async () => {
  const dir = tmpDir();
  const backends = fakeBackends(dir, { steps: [] });
  const start = (dataDir) => startTasksEngine({ dataDir, backends, env: ENV, log: quiet });
  try {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, path.join(dir, 'link'));
    await assert.rejects(start(path.join(dir, 'link')));

    const d1 = path.join(dir, 'd1');
    fs.mkdirSync(d1, { mode: 0o700 });
    fs.writeFileSync(path.join(d1, 'tasks.sock'), 'not a socket');
    await assert.rejects(start(d1), (e) => e.code === 'SOCKET_IN_USE' && !e.message.includes(dir));

    const d2 = path.join(dir, 'd2');
    const a = await start(d2);
    await assert.rejects(start(d2), (e) => e.code === 'SOCKET_IN_USE');
    await a.close();

    // A stale socket file (no listener) left by a crash is replaced.
    const d3 = path.join(dir, 'd3');
    fs.mkdirSync(d3, { mode: 0o700 });
    const sock = path.join(d3, 'tasks.sock');
    const ghost = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.stdout.write('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => ghost.stdout.once('data', r));
    ghost.kill('SIGKILL');
    await new Promise((r) => ghost.once('exit', r));
    assert.ok(fs.lstatSync(sock).isSocket(), 'a dead socket file is left behind');
    const b = await start(d3);
    await b.close();

    const long = path.join(dir, 'x'.repeat(110));
    await assert.rejects(start(long), (e) => e.code === 'SOCKET_PATH_TOO_LONG' && !e.message.includes('xxxx'));
  } finally { rm(dir); }
});

test('auth, hello-first, unknown method, runner-control frames, bad json and oversize frames; none of it touches seq or the store', async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const m = await startEngine({ dir });
  try {
    const tok = m.eng.token;
    const { id } = await m.client.createTask({ text: 'one', cwd: repo.checkout });
    await waitFor(async () => (await m.client.getTask(id)).state === 'in_review', { label: 'in_review' });
    const before = (await m.client.getTask(id)).lastSeq;
    const bad = await raw(m.eng.socketPath, [{ id: '1', method: 'hello', params: { protocol: 1 }, token: 'btk_wrong' }]);
    assert.equal(bad.out[0].error.code, 'UNAUTHENTICATED');
    assert.equal(bad.closed, true);
    const pre = await raw(m.eng.socketPath, [{ id: '2', method: 'listTasks', params: {}, token: tok.slice(0, -1) }]);
    assert.equal(pre.out[0].error.code, 'UNAUTHENTICATED');
    const r = await raw(m.eng.socketPath, [
      { id: 'a', method: 'createTask', params: { requestId: 'req-00000001', spec: { text: 'x', cwd: repo.checkout } }, token: tok },
      { id: 'b', method: 'hello', params: { protocol: 2 }, token: tok },
      { id: 'c', method: 'hello', params: { protocol: 1 }, token: tok },
      { id: 'd', method: 'fly', params: {}, token: tok },
      { id: 'e', type: 'stop_all', token: tok },
      { id: 'f', method: 'act', params: { id, action: 'merge', payload: {}, requestId: 'act-00000001', extra: 1 }, token: tok },
      { id: 'g', method: 'createTask', params: { requestId: 'req-00000002', spec: { text: 'x', cwd: repo.checkout, evil: true } }, token: tok },
      { id: 'h', method: 'subscribe', params: { id: 'tsk_000000000000' }, token: tok },
      'not json\n', '[1,2,3]\n', `${'['.repeat(100000)}\n`,
    ]);
    const by = Object.fromEntries(r.out.filter((o) => o.id).map((o) => [o.id, o]));
    assert.equal(by.a.error.code, 'VALIDATION');
    assert.equal(by.b.error.code, 'PROTOCOL_UNSUPPORTED');
    assert.equal(by.c.result.protocol, 1);
    assert.equal(by.c.result.mock, false);
    assert.equal(by.d.error.code, 'UNKNOWN_METHOD');
    assert.equal(by.e.error.code, 'VALIDATION');
    assert.equal(by.f.error.code, 'VALIDATION');
    assert.equal(by.g.error.code, 'VALIDATION');
    assert.equal(by.h.error.code, 'NOT_FOUND');
    assert.equal(r.out.filter((o) => o.id === null && o.error?.code === 'VALIDATION').length, 3);
    const big = await raw(m.eng.socketPath, [`{"id":"x","token":"${tok}","pad":"${'a'.repeat(MAX_FRAME_BYTES)}"}\n`]);
    assert.equal(big.out[0].error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(big.closed, true);
    const noNl = await raw(m.eng.socketPath, ['a'.repeat(MAX_FRAME_BYTES + 10)]);
    assert.equal(noNl.out[0].error.code, 'PAYLOAD_TOO_LARGE');

    assert.equal((await m.client.getTask(id)).lastSeq, before, 'no event from any rejected frame');
    assert.equal((await m.client.listTasks()).length, 1);
    await m.close();
    const s = new TaskStore(path.join(m.dataDir, 'store'));
    const loaded = s.load();
    s.close();
    assert.equal(loaded.tasks.size, 1);
    const seqs = loaded.events.map((x) => x.e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.equal(new Set(seqs).size, seqs.length);
  } finally { await m.close().catch(() => {}); rm(dir); }
});

test('a client is dropped as lagged under backpressure and resumes from lastSeq without gaps (client.js)', async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const m = await startEngine({ dir, scenario: { steps: [...Array.from({ length: 100 }, (_, i) => ({ assistant: `${i} ${'x'.repeat(60000)}` })), { result: 'success' }] } });
  try {
    const c = await connect({ socketPath: m.eng.socketPath, tokenPath: m.eng.tokenPath });
    const got = [];
    await c.subscribe('*', { fromSeq: 1 }, (e) => got.push(e.seq));
    c.sock.pause();
    const lagged = new Promise((r) => c.once('lagged', r));
    const { id } = await m.client.createTask({ text: 'flood', cwd: repo.checkout });
    await waitFor(async () => (await m.client.getTask(id)).state === 'in_review', { label: 'in_review' });
    c.sock.resume();
    await lagged;
    const last = (await m.client.getTask(id)).lastSeq;
    await waitFor(() => got.at(-1) === last, { label: 'caught up after resubscribe' });
    assert.deepEqual(got, [...new Set(got)].sort((a, b) => a - b), 'in order, no duplicates');
    c.close();
  } finally { await m.close(); rm(dir); }
});
