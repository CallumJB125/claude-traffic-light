'use strict';
// src/bus-trace.js: the closed shape (acceptance 7: no body or path can be written whatever a caller passes),
// rotation at the size cap, and a write that fails never throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/bus-trace.js');
const C = require('../src/bus-contract.js');
const { testTempDir } = require('./helpers/tmp');

test('sanitize keeps only contract fields, each matching its pattern; anything else is null', () => {
  const r = T.sanitize({ op: 'note', trace_id: 'tr_0123456789abcdef', from_handle: '/Users/me/secret', to: 'Rotate AKIA… now', provider: 'evil',
    repo_key_hash: '/Users/me/app', result: 'pwned', reason: 'the note text here', ms: 3.4, ref: 'note body', text: 'BODY', brief: 'BRIEF', cwd: '/Users/me' }, 5);
  assert.deepEqual(Object.keys(r).sort(), [...C.TRACE_FIELDS].sort());
  assert.deepEqual([r.from_handle, r.to, r.provider, r.repo_key_hash, r.result, r.reason, r.ref], [null, null, null, null, null, null, null]);
  assert.equal(r.ms, 3);
  assert.equal(r.t, 5);
  const ok = T.sanitize({ op: 'handoff', from_handle: 'claude-app-a1e0', to: 'codex', provider: 'any', repo_key_hash: 'aaaaaaaaaaaaaaaa', result: 'refused', reason: 'PROVIDER_UNAVAILABLE', ref: 'hof_0123456789abcdef' }, 1);
  assert.deepEqual([ok.from_handle, ok.to, ok.provider, ok.reason, ok.ref], ['claude-app-a1e0', 'codex', 'any', 'PROVIDER_UNAVAILABLE', 'hof_0123456789abcdef']);
  assert.ok(C.isTraceId(ok.trace_id) && C.isSpanId(ok.span), 'minted when missing');
  assert.deepEqual(T.resultOf({ reason: 'RATE' }), { result: 'refused', reason: 'RATE' });
  assert.deepEqual(T.resultOf(null, Object.assign(new Error('x'), { code: 'TIMEOUT' })), { result: 'error', reason: 'TIMEOUT' });
  assert.deepEqual(T.resultOf({ ok: true }), { result: 'ok', reason: null });
});

test('append writes 0600 JSONL, rotates to .1 at the cap, drops unknown ops, and a failing write never throws', async (t) => {
  const dir = testTempDir('pf-trace-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus-trace.jsonl');
  const tr = T.createTrace({ file, maxBytes: 600 });
  assert.equal(tr.append({ op: 'not-an-op' }), null);
  for (let i = 0; i < 6; i += 1) tr.append({ op: 'peers', result: 'ok' });
  await tr.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(`${file}.1`), 'rotated');
  assert.ok(fs.statSync(file).size <= 600);
  for (const l of fs.readFileSync(file, 'utf8').trim().split('\n')) assert.equal(JSON.parse(l).op, 'peers');
  const broken = T.createTrace({ file: path.join(dir, 'missing', 'x.jsonl') });
  assert.ok(broken.append({ op: 'peers' }));
  await broken.flush();
});

test('two writers share one file (main and the Tasks helper): a stale size never rotates the file the other just rotated', async (t) => {
  const dir = testTempDir('pf-trace2-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus-trace.jsonl');
  const line = Buffer.byteLength(`${JSON.stringify(T.sanitize({ op: 'peers', result: 'ok' }, Date.now()))}\n`);
  const max = line * 10 - 1; // nine lines fit
  const main = T.createTrace({ file, maxBytes: max });
  const helper = T.createTrace({ file, maxBytes: max });
  for (let i = 0; i < 8; i += 1) main.append({ op: 'peers', result: 'ok' });
  await main.flush();
  // The helper adds a line (nine), then rotates on the tenth and writes it to a fresh file.
  for (let i = 0; i < 2; i += 1) helper.append({ op: 'claim', result: 'ok' });
  await helper.flush();
  const rotated = fs.readFileSync(`${file}.1`, 'utf8');
  assert.equal(rotated.trim().split('\n').length, 9);
  // Main still counts eight lines of its own; the file has one. Its next two lines must not rotate again.
  for (let i = 0; i < 2; i += 1) main.append({ op: 'peers', result: 'refused' }); // a little longer than 'ok': past main's stale count
  await main.flush();
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), rotated, 'the rotated file is kept');
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).result), ['ok', 'refused', 'refused']);
});

test('review #3: a second writer (rotates:false) never renames the shared file; main does', async () => {
  const dir = testTempDir('pf-trace-rot-');
  try {
    const file = path.join(dir, 'bus-trace.jsonl');
    const helper = T.createTrace({ file, maxBytes: 500, rotates: false });
    for (let i = 0; i < 5; i += 1) helper.append({ op: 'note', result: 'ok' });
    await helper.flush();
    assert.equal(fs.existsSync(`${file}.1`), false, 'the helper only appends');
    assert.ok(fs.statSync(file).size > 500, 'past the cap, still one file');
    const main = T.createTrace({ file, maxBytes: 500 });
    main.append({ op: 'note', result: 'ok' });
    await main.flush();
    assert.equal(fs.existsSync(`${file}.1`), true, 'main rotates');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
