import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchema } from '../scripts/build-schema.js';
import { KEYWORDS, keywordsUsed, validate } from '../validate.js';
import {
  METHODS, ACTIONS, EVENT_TYPES, PUSH_KINDS, ERRORS, PARK_REASONS, MCP_TASK_TOOLS, CLI_SUBCOMMANDS, TASKS_PROTOCOL_VERSION,
} from '../protocol.js';
import { SCHEMA } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = fs.readFileSync(path.join(here, '..', '..', 'TASKS-CONTRACT.md'), 'utf8');

test('schema.json is exactly the generator output (run npm run tasks:schema)', () => {
  assert.deepEqual(SCHEMA, JSON.parse(JSON.stringify(buildSchema())));
});

test('schema uses only keywords the bundled validator implements', () => {
  const extra = [...keywordsUsed(SCHEMA)].filter((k) => !KEYWORDS.includes(k));
  assert.deepEqual(extra, []);
});

test('every $ref resolves', () => {
  const refs = JSON.stringify(SCHEMA).match(/"#\/\$defs\/[A-Za-z]+"/g) ?? [];
  for (const r of refs) assert.ok(SCHEMA.$defs[r.slice(9, -1)], r);
});

test('every protocol name appears in TASKS-CONTRACT.md', () => {
  const names = [...METHODS, ...ACTIONS, ...EVENT_TYPES, ...PUSH_KINDS, ...ERRORS, ...PARK_REASONS, ...MCP_TASK_TOOLS, ...Object.keys(CLI_SUBCOMMANDS)];
  const missing = names.filter((n) => !CONTRACT.includes(`\`${n}\``));
  assert.deepEqual(missing, []);
  assert.ok(CONTRACT.includes(`TASKS_PROTOCOL_VERSION = ${TASKS_PROTOCOL_VERSION}`));
});

test('the schema has an event shape per event type and a payload per action', () => {
  const eventConsts = SCHEMA.$defs.Event.oneOf.map((r) => SCHEMA.$defs[r.$ref.slice(8)].properties.type.const);
  assert.deepEqual([...eventConsts].sort(), [...EVENT_TYPES].sort());
  assert.deepEqual(Object.keys(SCHEMA.$defs.ActPayloads.properties).sort(), [...ACTIONS].sort());
});

test('validator rejects what it should', () => {
  assert.equal(validate(SCHEMA, 'TaskSpec', { text: 'x', cwd: '/r' }), null);
  assert.match(validate(SCHEMA, 'TaskSpec', { text: 'x' }).message, /missing required cwd/);
  assert.match(validate(SCHEMA, 'TaskSpec', { text: 'x', cwd: '/r', ai: 'gpt' }).message, /not in/);
  assert.match(validate(SCHEMA, 'TaskSpec', { text: 'x', cwd: '/r', extra: 1 }).message, /unexpected property/);
  assert.match(validate(SCHEMA, 'TaskSpec', { text: '', cwd: '/r' }).message, /shorter/);
  assert.ok(validate(SCHEMA, 'Event', { type: 'state', seq: 1, taskId: 't', at_age_ms: 0 }));
  assert.ok(validate(SCHEMA, 'ActPayloads', { discard: {} }));
  assert.equal(validate(SCHEMA, 'ActPayloads', { discard: { confirm: true } }), null);
  assert.equal(validate(SCHEMA, 'SpinOffInput', { task: 'fix the flaky test' }), null);
  assert.ok(validate(SCHEMA, 'SpinOffInput', { task: 'x', permissionLevel: 'bypass' }), 'spin-off can never ask for bypass');
  assert.equal(validate(SCHEMA, 'BuddyMessageInput', { to: 'task:tsk_1', text: 'hi' }), null);
});
