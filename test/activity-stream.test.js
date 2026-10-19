'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityStream, cleanEvent, parseBlock } = require('../src/activity-stream');

const HUB = 'https://hub.example.test';
const enc = new TextEncoder();
const block = (seq, type, data) => `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, ...data })}\n\n`;

// A fake SSE response whose chunks the test pushes.
function sseResponse() {
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; } });
  return { res: { ok: true, status: 200, headers: new Map([['content-type', 'text/event-stream; charset=utf-8']]), body },
    push: (text) => ctl.enqueue(enc.encode(text)), close: () => { try { ctl.close(); } catch { /* closed */ } } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('parses events, cleans fields, resumes with Last-Event-ID after a drop', async (t) => {
  const conns = [];
  const fetch = async (url, init) => { const s = sseResponse(); conns.push({ url, init, ...s }); init.signal.addEventListener('abort', () => s.close()); return s.res; };
  const got = [];
  const stream = createActivityStream({ hubs: () => [{ origin: HUB, token: () => 'tok' }], fetch, onEvent: (o, e) => got.push(e),
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms >= 60_000 ? ms : Math.min(ms, 5)), clearTimeout } });
  t.after(() => stream.stop());
  stream.start();
  await tick();
  assert.equal(conns[0].init.headers.authorization, 'Bearer tok');
  assert.equal(conns[0].init.headers['last-event-id'], undefined);
  assert.equal(conns[0].init.redirect, 'error');
  conns[0].push(': ping\n\n' + block(7, 'record.upsert', { record_id: 'r1', rev: 2, author: 'Jo‮', record: { title: 'T'.repeat(500), status: 'working', files: { edited: ['a.js'] }, secret: 'x' } }));
  conns[0].push(block(8, 'collision', { repo_id: 'repo', path: 'a.js', records: ['r1', 'r2'], people: ['Jo', 'Sam'] }).slice(0, 20));
  await tick();
  conns[0].push(block(8, 'collision', { repo_id: 'repo', path: 'a.js', records: ['r1', 'r2'], people: ['Jo', 'Sam'] }).slice(20));
  conns[0].push(block(9, 'something.else', {}));
  await tick();
  assert.deepEqual(got.map((e) => e.type), ['record.upsert', 'collision']);
  assert.equal(got[0].record.title.length, 120);
  assert.equal(got[0].record.secret, undefined);
  assert.equal(got[0].author, 'Jo ');
  assert.deepEqual(got[1].people, ['Jo', 'Sam']);
  conns[0].close();
  for (let i = 0; i < 50 && conns.length < 2; i++) await tick();
  assert.equal(conns[1].init.headers['last-event-id'], '9');
  assert.match(conns[1].url, /after=9$/);
});

test('a 401 stops that hub; a non-https hub is never contacted', async (t) => {
  const urls = [];
  const fetch = async (url) => { urls.push(url); return { ok: false, status: 401, headers: new Map() }; };
  const stream = createActivityStream({ hubs: () => [{ origin: HUB, token: () => 'tok' }, { origin: 'http://evil.example.test', token: () => 'tok' }], fetch });
  t.after(() => stream.stop());
  stream.start();
  await tick();
  assert.deepEqual(urls, [`${HUB}/api/activity/v1/stream`]);
  assert.deepEqual(stream.state(), []);
});

test('cleanEvent and parseBlock reject junk', () => {
  assert.equal(cleanEvent('record.upsert', { type: 'record.upsert' }), null, 'no seq');
  assert.equal(cleanEvent('nope', { seq: 1 }), null);
  assert.deepEqual(parseBlock('id: 3\nevent: x\ndata: {"a":\ndata: 1}'), { id: '3', event: 'x', data: ['{"a":', '1}'] });
});
