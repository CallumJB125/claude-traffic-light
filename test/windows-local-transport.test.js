'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const Local = require('../board/shared/local-sockets.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const endpoint = 'C:\\Users\\synthetic\\tasks.sock';
function fixture() {
  const child = new EventEmitter(), writes = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, encoding, callback) { writes.push(Buffer.from(bytes)); callback(); } });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('exit', 0)));
  child.kill = () => { child.emit('exit', 1); return true; };
  const options = { platform: 'win32', executable: 'C:\\App\\native\\windows-local-transport.exe', spawn(exe, args, opts) {
    assert.equal(exe, 'C:\\App\\native\\windows-local-transport.exe'); assert.deepEqual(args, []);
    assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true); assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    return child;
  } };
  return { child, writes, options, frame: (type, id, bytes) => child.stdout.write(Local.packet(type, id, bytes)), packets: () => writes.slice(1).map(b => ({ type: b[0], id: b.readUInt32LE(1), bytes: b.subarray(9) })) };
}

test('Windows client withholds bytes until verified native OPEN and applies write acknowledgements and chunk bounds', async () => {
  const f = fixture(), client = Local.createConnection(endpoint, f.options); client.on('error', () => {});
  const bytes = Buffer.alloc(Local.BLOCK + 3, 's'); let finished = false;
  client.write(bytes, () => { finished = true; });
  await tick(); assert.equal(f.writes.length, 1, 'only path bootstrap may precede verified connection');
  assert.equal(f.writes[0][0], 'C'.charCodeAt(0)); assert.equal(f.writes[0].subarray(5).toString('utf16le'), endpoint);
  f.frame(2, 1); await tick();
  assert.equal(f.packets()[0].type, 3); assert.equal(f.packets()[0].bytes.length, Local.BLOCK); assert.equal(finished, false);
  f.frame(5, 1); await tick();
  assert.equal(f.packets()[1].bytes.length, 3); assert.equal(finished, false);
  f.frame(5, 1); await tick(); assert.equal(finished, true);
  client.end(); await tick(); assert.equal(f.packets().at(-1).type, 8, 'end requests native flush before closure');
  f.frame(4, 1); await tick(); assert.equal(client.destroyed, true);
});

test('Windows client bounds unread bytes and only grants another read after the consumer drains', async () => {
  const f = fixture(), client = Local.createConnection(endpoint, f.options); client.on('error', () => {});
  f.frame(2, 1); await tick(); f.frame(3, 1, Buffer.alloc(Local.BLOCK, 'r'));
  await tick(); assert.equal(f.packets().filter(p => p.type === 7).length, 0);
  assert.equal(client.read().length, Local.BLOCK); await tick();
  assert.equal(f.packets().filter(p => p.type === 7).length, 1);
  client.destroy(); await tick();
});

test('Windows bridge rejects an unacknowledged second read block', async () => {
  const f = fixture(), client = Local.createConnection(endpoint, f.options); const errors = []; client.on('error', e => errors.push(e));
  f.frame(2, 1); await tick(); f.frame(3, 1, Buffer.alloc(Local.BLOCK)); f.frame(3, 1, Buffer.from('overflow')); await tick();
  assert.ok(errors.some(e => /read window/.test(e.message))); assert.equal(client.destroyed, true);
});

for (const scenario of ['bad-frame', 'oversize-frame', 'wrong-ready', 'duplicate-open', 'unexpected-write-receipt', 'exit-before-connect']) {
  test(`Windows bridge refuses ${scenario} and closes pending client construction`, async () => {
    const f = fixture(), client = Local.createConnection(endpoint, f.options); const errors = []; client.on('error', e => errors.push(e));
    if (scenario === 'bad-frame') f.frame(99, 1);
    if (scenario === 'oversize-frame') { const b = Buffer.alloc(9); b[0] = 3; b.writeUInt32LE(Local.BLOCK + 1, 5); f.child.stdout.write(b); }
    if (scenario === 'wrong-ready') f.frame(1, 0);
    if (scenario === 'duplicate-open') { f.frame(2, 1); f.frame(2, 2); }
    if (scenario === 'unexpected-write-receipt') { f.frame(2, 1); f.frame(5, 1); }
    if (scenario === 'exit-before-connect') f.child.emit('exit', 1);
    await tick(); assert.equal(client.destroyed, true); assert.ok(errors.length > 0);
  });
}

test('Windows listener requires READY, caps 32 clients, and closes all connections on native failure', async () => {
  const f = fixture(), peers = [], errors = [];
  const server = Local.createServer(c => { c.on('error', () => {}); peers.push(c); }, f.options); server.on('error', e => errors.push(e));
  let listening = false; server.listen(endpoint, () => { listening = true; }); assert.equal(listening, false);
  f.frame(1, 0); assert.equal(listening, true); assert.equal(server.address(), endpoint);
  for (let id = 1; id <= 32; id++) f.frame(2, id);
  assert.equal(peers.length, 32);
  f.frame(2, 33); await tick(); assert.ok(errors.some(e => /connection receipt/.test(e.message))); assert.ok(peers.every(p => p.destroyed));
});

test('Windows endpoint bootstrap admits only native drive paths and fixed endpoint roles', () => {
  for (const value of ['relative', '\\\\server\\share\\tasks.sock', 'C:/tasks.sock', 'C:\\x\\other.sock', 'C:\\x\0\\tasks.sock']) assert.throws(() => Local.request('C', value));
  assert.throws(() => Local.request('X', endpoint));
});

test('Windows private token requires native success and exact token bytes; paths travel only through stdin', () => {
  const expected = 'btk_' + 'A'.repeat(43); let retained;
  const options = { executable: 'C:\\native\\helper.exe', spawnSync(exe, args, opts) {
    assert.equal(exe, 'C:\\native\\helper.exe'); assert.deepEqual(args, []); assert.equal(opts.timeout, 5000); assert.equal(opts.shell, false); assert.equal(opts.maxBuffer, 256);
    retained = opts.input; assert.equal(retained[0], 'T'.charCodeAt(0));
    return { status: 0, stdout: expected + '\n' };
  } };
  assert.equal(Local.token(endpoint, true, options), expected); assert.ok(retained.every(b => b === 0));
  for (const result of [{ status: 1, stdout: expected + '\n' }, { status: 0, error: new Error('timeout'), stdout: expected + '\n' }, { status: 0, stdout: expected }, { status: 0, stdout: expected + '\nEXTRA' }]) assert.throws(() => Local.token(endpoint, false, { spawnSync: () => result }), /token unavailable/);
});


test('Windows listener closes exactly once after spawn failure without exit and later close callbacks complete', async () => {
  const f = fixture(); f.child.stdin.removeAllListeners('finish');
  const server = Local.createServer(undefined, f.options), errors = [];
  server.on('error', error => errors.push(error)); let closes = 0, callbacks = 0;
  server.on('close', () => closes++); server.listen(endpoint);
  f.child.emit('error', Object.assign(new Error('missing helper'), { code: 'ENOENT' }));
  server.close(() => callbacks++);
  f.child.emit('close', -2); await tick();
  assert.equal(errors.length, 1); assert.equal(closes, 1); assert.equal(callbacks, 1);
  f.child.emit('exit', -2); await tick(); assert.equal(closes, 1);
  server.close(() => callbacks++); await tick(); assert.equal(callbacks, 2); assert.equal(closes, 1);
});
