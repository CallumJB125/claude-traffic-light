import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate, SHAPES, OUTBOX_SHAPES, FACT_KINDS, ERRORS, httpStatus, compatible, PROTOCOL_VERSION, MCP_TOOLS, RPC_METHODS, MCP_OUTBOX_TOOLS, HOOK_EVENTS, RUNNER_COMMANDS } from '../protocol.js';
import { TRANSITIONS } from '../states.js';

const CONTRACT = readFileSync(fileURLToPath(new URL('../../CONTRACT.md', import.meta.url)), 'utf8');

test('CONTRACT.md names every message type, outbox kind, fact kind, error code, tool and hook event', () => {
  const missing = [];
  const need = (name) => { if (!CONTRACT.includes(`\`${name}\``)) missing.push(name); };
  for (const table of Object.values(SHAPES)) Object.keys(table).forEach(need);
  Object.keys(OUTBOX_SHAPES).forEach(need);
  Object.keys(FACT_KINDS).forEach(need);
  Object.keys(ERRORS).forEach(need);
  [...MCP_TOOLS, ...RPC_METHODS, ...HOOK_EVENTS, ...RUNNER_COMMANDS].forEach(need);
  assert.deepEqual(missing, []);
});

test('CONTRACT.md documents every transition row id', () => {
  const missing = TRANSITIONS.map((r) => r.id).filter((id) => !CONTRACT.includes(`\`${id}\``));
  assert.deepEqual(missing, []);
});

test('versioning', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(compatible(1), true);
  assert.equal(compatible(2), false);
  assert.equal(compatible('1'), false);
});

test('error codes map to HTTP status; runner-local codes never have one', () => {
  assert.equal(httpStatus('FENCED'), 409);
  assert.equal(httpStatus('PROTOCOL_UNSUPPORTED'), 426);
  assert.equal(httpStatus('CONFIRM_REQUIRED'), 428);
  assert.equal(httpStatus('NOPE'), 500);
  assert.equal(httpStatus('GATE_CLOSED'), 500, 'runner-local codes are not HTTP answers');
});

test('outbox tools are MCP tools with outbox kinds', () => {
  for (const [tool, kind] of Object.entries(MCP_OUTBOX_TOOLS)) {
    assert.ok(MCP_TOOLS.includes(tool));
    assert.ok(kind in OUTBOX_SHAPES);
  }
  for (const m of RPC_METHODS.filter((x) => x !== 'team_context')) assert.ok(MCP_TOOLS.includes(m), m);
});

test('validate: accepts well-formed messages on each channel', () => {
  const ok = [
    ['browser→hub', { type: 'hello', protocol: 1 }],
    ['browser→hub', { type: 'subscribe', board_id: 'b1' }],
    ['hub→browser', { type: 'lease.tick', card_id: 'c', live: {}, state_age_ms: 5 }],
    ['runner→hub', { type: 'hb', seq_hb: 1, mono_ms: 10, wall_ms: 10, slept_ms: 0, runs: [] }],
    ['runner→hub', { type: 'claim', id: 'q1', card_id: 'c', request_id: 'r', expected_fence: 4 }],
    ['runner→hub', { type: 'out', seq: 7, delayed: false, msg: { kind: 'facts', run_id: 'r', card_id: 'c', fence: 4, repo_id: 'x', items: [{ kind: 'file', path: 'a/b', op: 'edit' }, { kind: 'compacted' }] } }],
    ['runner→hub', { type: 'out', seq: 8, delayed: true, msg: { kind: 'run.failed', run_id: 'r', card_id: 'c', fence: 4, repo_id: 'x', fail_kind: 'error', reason: null } }],
    ['hub→runner', { type: 'hb.ack', seq_hb: 1, hub_epoch: 'e', runs: [] }],
    ['hub→runner', { type: 'cmd', cmd_id: 'k', run_id: 'r', card_id: 'c', fence: 4, cmd: 'stop' }],
    ['ipc→runner', { type: 'tool', id: '1', token: 't', name: 'board_get_card', args: {} }],
  ];
  for (const [ch, m] of ok) assert.equal(validate(ch, m), null, `${ch} ${m.type}: ${JSON.stringify(validate(ch, m))}`);
});

test('validate: rejects unknown types, missing/mistyped fields, bad outbox/fact kinds', () => {
  assert.match(validate('runner→hub', { type: 'nope' }).message, /unknown type/);
  assert.match(validate('nope', { type: 'hb' }).message, /unknown channel/);
  assert.match(validate('runner→hub', { type: 'claim', id: 'q', card_id: 'c', request_id: 'r' }).message, /missing expected_fence/);
  assert.match(validate('runner→hub', { type: 'claim', id: 'q', card_id: 'c', request_id: 'r', expected_fence: 1.5 }).message, /int/);
  assert.match(validate('runner→hub', { type: 'out', seq: 1, delayed: false, msg: { kind: 'x' } }).message, /unknown outbox kind/);
  assert.match(validate('runner→hub', { type: 'out', seq: 1, delayed: false, msg: { kind: 'activity', run_id: 'r', card_id: 'c', fence: 1, source: 's' } }).message, /repo_id/);
  assert.match(validate('runner→hub', { type: 'out', seq: 1, delayed: false, msg: { kind: 'facts', run_id: 'r', card_id: 'c', fence: 1, repo_id: 'x', items: [{ kind: 'zzz' }] } }).message, /unknown fact kind/);
  assert.match(validate('runner→hub', { type: 'out', seq: 1, delayed: false, msg: { kind: 'facts', run_id: 'r', card_id: 'c', fence: 1, repo_id: 'x', items: [{ kind: 'file', op: 'edit' }] } }).message, /fact file: missing path/);
  assert.match(validate('hub→browser', null).message, /unknown type/);
});
