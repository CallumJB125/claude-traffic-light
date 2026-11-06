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
