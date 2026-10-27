'use strict';
// PR 0s: the keeper protocol v1 golden transcripts parse against the schemas
// (plan-agent-terminal §R2.3.4, §R3.2.1, §R3.14 condition 2), and the provider
// requirement strings have one source (§R3.6).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../src/keeper-protocol');
const { checkTakeover } = require('../src/keeper-protocol/takeover-shape');

const DIR = path.join(__dirname, 'fixtures/keeper-protocol/v1');
const schema = JSON.parse(fs.readFileSync(K.SCHEMA_PATH, 'utf8'));
const transcripts = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort()
  .map((f) => ({ name: f, frames: fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) }));
const validator = import('../board/tasks-api/validate.js');

test('every v1 transcript frame parses against the schema', async () => {
  const { validate } = await validator;
  const all = transcripts();
  assert.equal(all.length, 12);
  for (const { name, frames } of all) for (const [i, f] of frames.entries()) {
    const where = `${name}:${i + 1}`;
    assert.ok(['c>k', 'k>c'].includes(f.dir), where);
    if (f.type === 1) {
      assert.equal(validate(schema, 'control', f.json), null, `${where} ${JSON.stringify(validate(schema, 'control', f.json))}`);
      assert.ok(Buffer.byteLength(JSON.stringify(f.json)) <= K.LIMITS.controlBytes);
    } else if (f.type === 2) {
      assert.ok(Number.isInteger(f.channel) && f.channel > 0 && typeof f.b64 === 'string', where);
      assert.ok(Buffer.from(f.b64, 'base64').length <= K.LIMITS.dataBytes, where);
    } else {
      assert.equal(f.type, 0, `${where}: frame types are 1, 2, or the 0 close marker`);
      assert.ok(f.dir === 'k>c' && K.ERROR_CODES.includes(f.close), where);
    }
    if (f.conn !== undefined) assert.equal(f.conn, 'driver', where);
  }
});

test('the schema rejects what v1 senders never send', async () => {
  const { validate } = await validator;
  const bad = [
    { v: 2, op: 'status', id: 1 },
    { v: 1, op: 'status', id: 0 },
    { v: 1, op: 'status', id: 1, extra: true },
    { v: 1, op: 'spawn', id: 1, kind: 'takeover' },
    { v: 1, re: 1, ok: true, code: 'NOPE', text: '' },
    { v: 1, ev: 'attached', channel: 1 },
    { v: 1, op: 'attached', id: 2, channel: 1 },
    { v: 1, op: 'rows.publish', id: 1, rows: [{ sessionId: 'k1', bucket: 'working', status: 'x', title: 'Rename me' }] },
  ];
  for (const m of bad) assert.notEqual(validate(schema, 'control', m), null, JSON.stringify(m));
});

test('the schema keeps to the in-repo validator\'s keywords', async () => {
  const { keywordsUsed, KEYWORDS } = await validator;
  for (const k of keywordsUsed(schema)) assert.ok(KEYWORDS.includes(k), `keyword ${k}`);
});

test('the control role never gets a data frame, and its refused ops say ROLE', () => {
  for (const { name, frames } of transcripts()) {
    const control = frames.filter((f) => f.conn === undefined);
    const hello = control.find((f) => f.json?.op === 'hello');
    if (hello?.json.app !== 'plexiform') continue;
    assert.ok(!control.some((f) => f.type === 2 && f.dir === 'k>c'), `${name}: no data frame to control`);
    for (const f of control.filter((x) => x.dir === 'c>k' && x.type === 1 && x.json.op)) {
      const reply = control.find((x) => x.json?.re === f.json.id);
      const allowed = K.OPS[f.json.op].includes('control') && (f.json.op !== 'spawn' || K.SPAWN_KINDS.control.includes(f.json.kind));
      if (!allowed) assert.equal(reply?.json.code, 'ROLE', `${name}: ${f.json.op}`);
    }
  }
});

test('the take-over spawns in the transcripts fit the take-over shape', () => {
  const dataDir = '/Users/fixture/Library/Application Support/Plexiform';
  let n = 0;
  for (const { name, frames } of transcripts()) for (const f of frames) {
    if (f.json?.op === 'spawn' && f.json.kind === 'takeover') { assert.equal(checkTakeover(f.json, { dataDir }), null, name); n++; }
  }
  assert.ok(n >= 2);
});

test('the replay hand-off is the in-band marker (§R3.14), with no attached round trip', () => {
  const t = transcripts().find((x) => x.name.startsWith('10-')).frames;
  const marker = t.findIndex((f) => f.json?.ev === 'handoff');
  assert.ok(marker > 0);
  assert.ok(t.slice(0, marker).some((f) => f.type === 2 && f.dir === 'k>c'), 'the preamble precedes the marker');
  assert.ok(!t.slice(0, marker).some((f) => f.type === 2 && f.dir === 'c>k'), 'nothing typed reaches the session before the marker');
  assert.ok(t.some((f) => f.json?.op === 'handoff'), 'detach mirrors it with the driver\'s marker');
  assert.ok(!JSON.stringify(transcripts()).includes('"attached"'));
});

// src/peer-pid.js keeps its literal (bus-main-thread.test.js pins it to require
// nothing, so main's awareness path does no load-time read); the keeper's Swift
// constant is generated from the JSON, and this test keeps the two equal.
test('one source for the provider requirement strings (§R3.6)', () => {
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/provider-requirements.json'), 'utf8'));
  // The strings src/peer-pid.js held before PR 0s, verbatim.
  assert.deepEqual(json, {
    claude: 'identifier "com.anthropic.claude-code" and anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
    codex: 'identifier "codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
  });
  const { REQUIREMENT } = require('../src/peer-pid');
  assert.deepEqual({ ...REQUIREMENT }, json);
  assert.ok(Object.isFrozen(REQUIREMENT));
});

test('protocol constants', () => {
  assert.deepEqual(K.PROTOCOL, { major: 1, minor: 0 });
  assert.deepEqual(K.FRAME, { CONTROL: 1, DATA: 2 });
  assert.deepEqual(K.SPAWN_KINDS.control, ['takeover']);
  for (const op of ['attach', 'resize', 'detach', 'signal', 'shutdown']) assert.deepEqual(K.OPS[op], ['driver'], op);
  assert.equal(K.LIMITS.pendingShow, 3);
});
