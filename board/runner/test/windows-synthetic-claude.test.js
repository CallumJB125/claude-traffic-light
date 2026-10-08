import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { WindowsSyntheticClaude } from './windows-synthetic-claude.js';
import { ClaudeBackend } from '../backends/claude.js';

test('synthetic Windows backend uses Job ownership and the real stream-json parser while production Claude stays unavailable', async () => {
  const job = new EventEmitter(), messages = []; let started, stops = 0;
  job.pid = 123; job.lstart = 'win32:0000000000000123'; job.ready = Promise.resolve(job);
  job.stdout = new PassThrough(); job.stderr = new PassThrough();
  job.stdin = new Writable({ write(bytes, encoding, cb) {
    const value = JSON.parse(bytes.toString()); messages.push(value); cb();
    if (value.type === 'control_request') queueMicrotask(() => job.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: value.request_id, subtype: 'success' } }) + '\n'));
  } });
  job.stop = async () => { stops++; job.closed = true; job.stopped = true; job.emit('exit', 0, null); return true; };
  const b = new WindowsSyntheticClaude({ bin: 'scenario.json', cwd: process.cwd(), env: {}, runDir: process.cwd(), sessionId: 'test-session', makeJob(...args) { started = args; return job; } });
  assert.equal(ClaudeBackend.describe('win32').startable, false);
  assert.throws(() => new ClaudeBackend({ platform: 'win32' }).start('secret'), { code: 'NOT_AVAILABLE' });
  assert.equal(WindowsSyntheticClaude.describe().startable, true);
  await b.start('fixture prompt');
  assert.equal(started[0], process.execPath); assert.match(started[1][0], /fake-claude\.js$/); assert.equal(started[1][1], 'scenario.json');
  assert.equal(b.pid, job.pid); assert.equal(b.lstart, job.lstart); assert.equal(b.pgid, null);
  assert.equal(messages[0].type, 'user');
  let seen; b.once('result', result => { seen = result; });
  job.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture result' }) + '\n');
  assert.equal(seen.result, 'fixture result');
  b.send('second turn'); assert.equal(b.confirmStopped(), false);
  assert.equal(await b.stop(), true); assert.equal(stops, 1); assert.equal(b.confirmStopped(), true);
  assert.ok(messages.some(m => m.type === 'control_request'));
});
