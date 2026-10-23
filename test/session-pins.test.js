const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/session-pins.js');

const e = (name, title, provider = 'codex', board = 'App') => ({ id: Math.random().toString(16).slice(2), owner: { name }, provider: { id: provider }, board: { label: board }, task: { title } });

test('pins: keyed by who/AI/board/task, so the pin survives a new opaque session id and a restart', () => {
  let s = P.togglePin(P.empty(), e('Ana', 'Fix login'));
  const again = P.parse(P.serialize(s));
  assert.equal(P.pinned(again, e('Ana', 'Fix login')), true);
  assert.equal(P.pinned(again, e('Ana', 'Other task')), false);
  s = P.togglePin(again, e('Ana', 'Fix login'));
  assert.equal(s.pins.length, 0);
});

test('pins: pinned sessions sort first, most recently pinned on top, others keep their order', () => {
  const a = e('Ana', 'A'), b = e('Ben', 'B'), c = e('Cy', 'C');
  let s = P.togglePin(P.empty(), b); s = P.togglePin(s, c);
  assert.deepEqual(P.order(s, [a, b, c]).map(x => x.task.title), ['C', 'B', 'A']);
});

test('pins: saved filters keep only known keys, replace by name and round-trip; garbage parses to empty', () => {
  let s = P.saveFilter(P.empty(), 'Ana on App', { person: 'Ana', project: 'App', bogus: 'x' });
  s = P.saveFilter(s, 'Ana on App', { person: 'Ana', focus: 'attention' });
  assert.equal(s.filters.length, 1);
  assert.deepEqual(s.filters[0].values, { person: 'Ana', focus: 'attention' });
  assert.deepEqual(P.parse(P.serialize(s)), s);
  assert.deepEqual(P.parse('nope'), P.empty());
  assert.deepEqual(P.parse('{"pins":["bad"],"filters":[{"name":"","values":{}}]}'), P.empty());
  assert.equal(P.removeFilter(s, 'Ana on App').filters.length, 0);
});

test('collections: add creates the collection, newest key first, no duplicates; membership helpers agree', () => {
  const a = e('Ana', 'A'), b = e('Ben', 'B');
  let s = P.addToCollection(P.empty(), ' Release 1.0 ', a);
  s = P.addToCollection(s, 'release 1.0', b);
  s = P.addToCollection(s, 'Release 1.0', a);
  assert.equal(s.collections.length, 1, 'names are unique case-insensitively');
  assert.equal(s.collections[0].name, 'Release 1.0', 'trimmed, first spelling kept');
  assert.deepEqual(s.collections[0].keys, [P.keyOf(b), P.keyOf(a)]);
  assert.equal(P.inCollection(s, 'release 1.0', a), true);
  assert.equal(P.inCollection(s, 'Release 1.0', e('Cy', 'C')), false);
  assert.equal(P.inCollection(s, 'Nope', a), false);
  s = P.addToCollection(s, 'Watching', a);
  assert.deepEqual(P.collectionsOf(s, a), ['Release 1.0', 'Watching']);
  assert.deepEqual(P.collectionsOf(s, b), ['Release 1.0']);
  assert.equal(P.addToCollection(s, '   ', a), s, 'blank name is a no-op');
  assert.equal(P.addToCollection(s, 'X', {}), s, 'entry without identity is a no-op');
});

test('collections: remove a key or a whole collection; unknown names are no-ops', () => {
  const a = e('Ana', 'A'), b = e('Ben', 'B');
  let s = P.addToCollection(P.addToCollection(P.empty(), 'R', a), 'R', b);
  const same = P.removeFromCollection(s, 'R', e('Cy', 'C')); assert.equal(same, s);
  s = P.removeFromCollection(s, 'r', a);
  assert.deepEqual(s.collections[0].keys, [P.keyOf(b)]);
  assert.equal(P.inCollection(s, 'R', a), false);
  s = P.removeCollection(s, 'R');
  assert.equal(s.collections.length, 0);
  assert.deepEqual(P.removeCollection(s, 'ghost').collections, []);
});

test('collections: round-trip, old serialised state without collections parses to [], garbage is dropped', () => {
  const a = e('Ana', 'A');
  const s = P.addToCollection(P.empty(), 'Release', a);
  assert.deepEqual(P.parse(P.serialize(s)), s);
  assert.ok(JSON.parse(P.serialize(s)).collections.length === 1, 'serialize includes collections');
  const old = P.parse('{"pins":[],"filters":[]}');
  assert.deepEqual(old, P.empty());
  assert.deepEqual(old.collections, []);
  const bad = P.parse(JSON.stringify({ collections: [
    { name: 'ok', keys: [P.keyOf(a), P.keyOf(a), 'bad', 42, '\u001f\u001f\u001f'] },
    { name: 'OK', keys: [] }, { name: '', keys: [] }, { name: 'x'.repeat(61), keys: [] }, 'nope', { name: 'nokeys' }, { name: 5, keys: [] },
  ] }));
  assert.deepEqual(bad.collections, [{ name: 'ok', keys: [P.keyOf(a)] }, { name: 'nokeys', keys: [] }]);
  assert.deepEqual(P.parse('[1,2]'), P.empty());
});

test('collections: caps of 12 collections and 30 keys each, names cut to 60 chars', () => {
  let s = P.empty();
  for (let i = 0; i < 15; i++) s = P.addToCollection(s, `C${i}`, e('Ana', `T${i}`));
  assert.equal(s.collections.length, P.MAX_COLLECTIONS); assert.equal(P.MAX_COLLECTIONS, 12);
  assert.equal(P.inCollection(s, 'C12', e('Ana', 'T12')), false, 'a 13th collection is refused');
  s = P.addToCollection(s, 'C0', e('Ana', 'T0'));
  assert.equal(s.collections.length, 12, 'adding to an existing collection still works at the cap');
  let big = P.empty();
  for (let i = 0; i < 40; i++) big = P.addToCollection(big, 'Big', e('Ben', `K${i}`));
  assert.equal(big.collections[0].keys.length, P.MAX_COLLECTION_KEYS); assert.equal(P.MAX_COLLECTION_KEYS, 30);
  assert.equal(big.collections[0].keys[0], P.keyOf(e('Ben', 'K39')), 'newest first; oldest fall off');
  const long = P.addToCollection(P.empty(), 'n'.repeat(80), e('Ana', 'A'));
  assert.equal(long.collections[0].name.length, 60);
  const many = JSON.stringify({ collections: Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, keys: Array.from({ length: 50 }, (_, j) => P.keyOf(e('Z', `k${j}`))) })) });
  const parsed = P.parse(many);
  assert.equal(parsed.collections.length, 12); assert.equal(parsed.collections[0].keys.length, 30);
});

test('collections: never change pins or filters', () => {
  const a = e('Ana', 'A');
  let s = P.togglePin(P.empty(), a);
  s = P.saveFilter(s, 'View', { person: 'Ana' });
  const pins = structuredClone(s.pins), filters = structuredClone(s.filters);
  s = P.addToCollection(s, 'R', a); s = P.addToCollection(s, 'R', e('Ben', 'B'));
  s = P.removeFromCollection(s, 'R', a); s = P.removeCollection(s, 'R');
  assert.deepEqual(s.pins, pins); assert.deepEqual(s.filters, filters);
  assert.equal(P.pinned(s, a), true);
  const t = P.togglePin(P.addToCollection(P.empty(), 'R', a), a);
  assert.deepEqual(t.collections, [{ name: 'R', keys: [P.keyOf(a)] }], 'pin changes leave collections alone');
});

test('pins: status filters saved under the old state words migrate once to bucket ids', () => {
  const old = JSON.stringify({ pins: [], collections: [], filters: [
    { name: 'Waiting on me', values: { status: 'Needs input', person: 'Ana' } }, { name: 'Busy', values: { status: 'Working' } },
    { name: 'Gone', values: { status: 'Ended' } }, { name: 'Ask', values: { status: 'Needs you' } }, { name: 'Broken', values: { status: 'Failed' } },
    { name: 'Plain', values: { person: 'Ben' } },
  ] });
  const s = P.parse(old);
  assert.equal(s.upgraded, true, 'the page writes the migrated filters back once');
  assert.deepEqual(s.filters.map((f) => f.values.status ?? null), ['needs', 'working', 'idle', 'needs', 'stuck', null]);
  assert.equal(s.filters[0].values.person, 'Ana');
  const { upgraded, ...saved } = s;
  const again = P.parse(P.serialize(saved));
  assert.equal(again.upgraded, undefined, 'a second load has nothing left to migrate');
  assert.deepEqual(again, saved);
  for (const id of P.BUCKET_IDS) assert.equal(P.parse(JSON.stringify({ filters: [{ name: 'x', values: { status: id } }] })).filters[0].values.status, id);
});
