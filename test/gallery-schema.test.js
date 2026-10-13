'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('the site-safe schema core does not load the setups payload validator or its .mjs', () => {
  for (const k of Object.keys(require.cache)) if (/src[\\/](gallery-schema|recipes|borrow[\\/]payload)\.js$|secret-patterns\.mjs$/.test(k)) delete require.cache[k];
  const S = require('../src/gallery-schema.js');
  assert.deepEqual(S.validateItem(recipe()), []);
  assert.deepEqual(S.validateItem(character()), []);
  const loaded = Object.keys(require.cache);
  assert.ok(!loaded.includes(path.resolve(__dirname, '../src/borrow/payload.js')));
  assert.ok(!loaded.some((k) => k.endsWith('secret-patterns.mjs')));
});

const S = require('../src/gallery-schema.js');
const Hatch = require('../characters/hatch.js');
const Rules = require('../rules.js');

const base = (kind, id, payload, over = {}) => ({ schema: 1, kind, id, title: 'A title', summary: 'One line about it.', author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: ['tests'], stacks: ['node'], tools: ['auto'], added: '2026-10-01', updated: '2026-10-05', payload, ...over });
function recipe(over = {}, payload = {}) {
  return base('recipe', 'explain-it', { id: 'explain-it', title: 'A title', what: 'Explains the repo.', prompt: 'Read the repository and explain it.\n\nDo not change files.', tool: 'auto', edits: false, cost: 'Low.', ...payload }, over);
}
function character(over = {}) { return base('character', 'pebble', Hatch.templateCharacter({ name: 'Pebble' }), over); }
function pack(members = ['recipe/explain-it', 'character/pebble'], over = {}) { return base('pack', 'starter', { members, note: '' }, over); }
function rules(then = {}) {
  const r = Rules.normalizeRule({ id: 'r1', name: 'Done', when: { signal: ['done'] }, then: { lamp: 'green', ...then } });
  return base('rules', 'calm', { rulesVersion: Rules.RULES_VERSION, rules: [r] });
}
function setup(rel = '.claude/commands/review.md') {
  return base('setup', 'reviewer', { schema: 1, files: [{ id: '0b8f7c1e-3a1d-4e5f-9a2b-1c2d3e4f5a6b', source_id: 'claude-code', relative_path: rel, format: 'markdown', content: '# Review\n', note: '' }], items: [], note: '' });
}

test('each kind accepts a fixture', () => {
  for (const item of [recipe(), character(), pack(), rules(), setup()]) assert.deepEqual(S.validateItem(item, item.id), [], item.kind);
});

test('refusals: closed keys, file name, read-only recipes, leaks, css, packs, rules, setups', () => {
  const bad = (item, name, re) => { const p = S.validateItem(item, name); assert.ok(p.some((x) => re.test(x)), `${re} in ${JSON.stringify(p)}`); };
  bad({ ...recipe(), extra: 1 }, 'explain-it', /unknown field: extra/);
  bad(recipe(), 'other-name', /file name/);
  bad(recipe({}, { edits: true }), 'explain-it', /edits must be false/);
  bad(recipe({}, { id: 'other' }), 'explain-it', /payload.id/);
  bad(recipe({}, { prompt: 'Use sk-ant-api03-' + 'a'.repeat(93) + 'AA to call it.' }), 'explain-it', /secret/);
  bad(recipe({}, { prompt: 'Open /Users/ana/code and read it.' }), 'explain-it', /home folder/);
  bad(recipe({ summary: 'two\nlines' }), 'explain-it', /summary/);
  bad(recipe({ stacks: ['cobol'] }), 'explain-it', /stacks/);
  bad(recipe({ updated: '2026-09-01' }), 'explain-it', /updated/);
  bad(character({ payload: { ...Hatch.templateCharacter({ name: 'Pebble' }), css: '.x{}' } }), 'pebble', /css/);
  // Text that reads differently from what it is, in a dialog or a prompt.
  bad(recipe({}, { prompt: 'Explain it.\u202Eesrever ni daer' }), 'explain-it', /invisible formatting/);
  bad(recipe({}, { what: 'Explains\u200B the repo.' }), 'explain-it', /invisible formatting/);
  bad(recipe({}, { title: 'Another title' }), 'explain-it', /payload.title must equal/);
  bad(recipe({}, { title: 'A title\n\nVerified by Plexiform' }), 'explain-it', /title/);
  for (const name of ['Pebble\u202E', 'Peb\u200Bble', 'Pebble\n\nVerified by Plexiform', ' Pebble']) bad(character({ payload: { ...Hatch.templateCharacter({ name: 'Pebble' }), name } }), 'pebble', /payload.name: plain text only/);
  bad(pack(['recipe/explain-it']), 'starter', /members/);
  bad(pack(['recipe/explain-it', 'pack/other']), 'starter', /packs cannot contain packs/);
  bad(pack(Array.from({ length: 13 }, (_, i) => `recipe/r${i}`)), 'starter', /members/);
  bad(rules({ sound: 'file:/tmp/a.aiff' }), 'calm', /sounds from files/);
  bad(rules({ cameo: 'my-face' }), 'calm', /photo cameos/);
  bad(rules({ clicks: { click: { type: 'shell', arg: 'rm -rf ~' } } }), 'calm', /clicks/);
  const raw = rules(); raw.payload.rules[0] = { id: 'r1', name: 'x' };
  bad(raw, 'calm', /rule format/);
  for (const rel of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md', '.claude/settings.json', '.claude.json#mcpServers']) bad(setup(rel), 'reviewer', /only skills, commands and agents/);
});

test('pack members must exist in the build; ids and kinds must match their files', () => {
  assert.throws(() => S.buildIndex([{ item: recipe(), name: 'explain-it' }, { item: pack(['recipe/explain-it', 'character/ghost']), name: 'starter' }]), /member character\/ghost is not in the gallery/);
  assert.throws(() => S.buildIndex([{ item: recipe(), name: 'explain-it', kind: 'character' }]), /must equal the folder/);
  assert.throws(() => S.buildIndex([]), /no items/);
});

test('entryHash is stable under key reorder; entries round-trip through validateEntry', () => {
  const { index } = S.buildIndex([{ item: recipe(), name: 'explain-it' }]);
  const e = index.entries[0];
  const reversed = Object.fromEntries(Object.entries(e).reverse());
  assert.equal(S.entryHash(reversed), e.sha256);
  assert.deepEqual(S.validateEntry(reversed), []);
  assert.match(S.validateEntry({ ...e, title: 'Changed' })[0], /sha256/);
  assert.match(S.validateEntry({ ...e, extra: 1 })[0], /unknown or missing/);
});

test('buildIndex twice on the same items gives byte-identical output; generatedAt is max(updated)', () => {
  const items = () => [{ item: pack(), name: 'starter' }, { item: character({ updated: '2026-10-09' }), name: 'pebble' }, { item: recipe(), name: 'explain-it' }];
  const a = S.buildIndex(items()).text, b = S.buildIndex(items().reverse()).text;
  assert.equal(a, b);
  const index = JSON.parse(a);
  assert.equal(index.generatedAt, '2026-10-09T00:00:00.000Z');
  assert.deepEqual(index.entries.map((e) => e.id), ['character/pebble', 'pack/starter', 'recipe/explain-it']);
  assert.deepEqual(Object.keys(index), ['entries', 'generatedAt', 'kind', 'schemaVersion', 'serial']);
  assert.equal(index.serial, 1);
  assert.equal(JSON.parse(S.buildIndex(items(), { serial: 7 }).text).serial, 7);
  assert.throws(() => S.buildIndex(items(), { serial: 0 }), /serial/);
  assert.throws(() => S.buildIndex([{ item: recipe({ updated: '2027-01-01' }), name: 'explain-it' }], { now: Date.parse('2026-10-10T12:00:00Z') }), /updated: not later than tomorrow/);
  assert.throws(() => S.buildIndex([{ item: recipe({ added: '2026-09-01', updated: '2026-09-02' }), name: 'explain-it' }]), /generatedAt 2026-09-02T00:00:00.000Z/);
  assert.doesNotThrow(() => S.buildIndex([{ item: recipe({ updated: '2026-10-11' }), name: 'explain-it' }], { now: Date.parse('2026-10-10T12:00:00Z') }));
  assert.equal(S.validateIndex({ ...index, serial: 0 }), 'index-schema');
  assert.ok(a.endsWith('}\n'));
  assert.equal(S.validateIndex(index), null);
  assert.equal(S.validateIndex({ ...index, extra: 1 }), 'index-schema');
  assert.equal(S.validateIndex(index, false), 'index-time');
});

test('validateSetupPayload refuses a rules target before the full check', () => {
  assert.throws(() => S.validateSetupPayload(setup('.claude/CLAUDE.md').payload), /only skills, commands and agents/);
});
