'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { PassThrough } = require('node:stream');
const { readMetadata } = require('../metadata'); const { KeeperClient, frame } = require('../keeper-client');
test('observed telemetry omits prompt/transcript content and gives no control identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-meta-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ source: 'codex', sessionId: 'private-provider-session', cwd: '/private/secret/project', updatedAt: new Date(100000).toISOString(), signal: 'permission-request', title: 'SECRET', summary: 'SECRET', transcript: 'SECRET', hostApp: 'Terminal', cost: { usd: 999 } }));
  const [row] = readMetadata(dir, 100001); assert.equal(row.project, 'project'); assert.equal(row.bucket, 'needs'); assert.equal(row.cost, null); assert.equal(row.age_ms, 1); assert(!JSON.stringify(row).includes('SECRET')); assert(!JSON.stringify(row).includes('/private')); assert(!JSON.stringify(row).includes('private-provider-session')); assert(!('sessionId' in row)); assert(!('keeperSessionId' in row));
});
test('metadata reader ignores symlinks, oversized files, ended and old sessions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-meta-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const other = path.join(dir, 'outside'); fs.writeFileSync(other, '{"signal":"permission-request"}'); fs.symlinkSync(other, path.join(dir, 'linked.json'));
  fs.writeFileSync(path.join(dir, 'huge.json'), ' '.repeat(128 * 1024 + 1)); fs.writeFileSync(path.join(dir, 'ended.json'), '{"signal":"session-end"}');
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ updatedAt: new Date(0).toISOString() })); assert.deepEqual(readMetadata(dir, 100000000), []);
});
test('frame parser pins attach channel before coalesced screen bytes', async () => {
  // Inbound and outbound are separated; no socket/network needed.
  const socket = new PassThrough(); const outgoing = []; socket.write = d => { outgoing.push(d); return true; };
  const client = new KeeperClient(socket); const order = [];
  client.on('reply', e => order.push(['reply', e.result.channel])); client.on('data', e => order.push(['data', e.channel]));
  const pending = client.call('attach', { sessionId: 'one', cols: 80, rows: 24 });
  const reply = frame(1, Buffer.from(JSON.stringify({ v: 1, re: 1, ok: true, channel: 9 })));
  const channel = Buffer.alloc(4); channel.writeUInt32BE(9); const bytes = frame(2, Buffer.concat([channel, Buffer.from('screen')]));
  socket.emit('data', Buffer.concat([reply, bytes])); await pending; assert.deepEqual(order, [['reply', 9], ['data', 9]]); client.close();
});
test('oversized inbound frame closes connection without parsing its contents', () => {
  const socket = new PassThrough(); socket.on('error', () => {}); const client = new KeeperClient(socket); client.on('notice', () => {});
  const header = Buffer.alloc(4); header.writeUInt32BE(65537); socket.emit('data', header); assert.equal(socket.destroyed, true);
});
test('public build cannot silently fall back to development', () => {
  const { spawnSync } = require('node:child_process'); const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/build-terminal.js')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Public Terminal distribution is disabled/);
});
