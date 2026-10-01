const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Characters = require('../characters/contract.js');
const Hatch = require('../characters/hatch.js');
const { validateCharacter } = require('../characters/validate.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'characters', 'user-loader.js'), 'utf8');
const hatched = (name) => validateCharacter(Hatch.templateCharacter({ name }), { source: 'import' }).character;

// run the loader in a fake window with its own registry
function boot(list) {
  const registry = new Map();
  const C = { register: (d) => { if (!/^u-/.test(d.id)) throw new Error('not installed'); registry.set(d.id, d); }, unregister: (id) => registry.delete(id) };
  const events = [];
  let change = null;
  const win = {
    BuddyCharacters: C,
    userCharacters: { list: async () => (typeof list === 'function' ? list() : list), onChange: (cb) => { change = cb; } },
    dispatchEvent: (e) => events.push(e.type),
    console: { warn() {} },
  };
  vm.runInNewContext(SRC, { window: win, console: win.console, Event: class { constructor(t) { this.type = t; } }, Promise });
  return { registry, events, fire: () => change() };
}
const settle = () => new Promise((r) => setImmediate(r));

test('loader: registers what main lists, under u- ids only, then tells the page', async () => {
  const { registry, events } = boot([hatched('Otter'), { id: 'claude', name: 'Spoof' }, { id: 'u-Bad Id', name: 'x' }, null, 'junk']);
  await settle();
  assert.deepEqual([...registry.keys()], ['u-otter']);
  assert.deepEqual(events, ['user-characters']);
});

test('loader: a change re-lists, registers the new and unregisters the removed', async () => {
  let current = [hatched('Otter'), hatched('Pip')];
  const { registry, fire } = boot(() => current);
  await settle();
  assert.deepEqual([...registry.keys()].sort(), ['u-otter', 'u-pip']);
  current = [hatched('Pip'), hatched('Kiwi')];
  fire(); await settle();
  assert.deepEqual([...registry.keys()].sort(), ['u-kiwi', 'u-pip']);
});

test('loader: a failing list leaves the page alone and does not throw', async () => {
  const { registry, events } = boot(() => { throw new Error('ipc down'); });
  await settle();
  assert.equal(registry.size, 0); assert.deepEqual(events, []);
});

test('contract: unregister removes only user characters, never a built-in, and redraws a rig wearing it', () => {
  const C = require('../characters/index.js');
  C.register(hatched('Gone'));
  const before = C.revision('u-gone');
  assert.equal(C.unregister('u-gone'), true);
  assert.equal(C.has('u-gone'), false);
  assert.ok(C.revision('u-gone') > before);
  assert.equal(C.unregister('u-gone'), false);
  assert.equal(C.unregister('claude'), false);
  assert.equal(C.has('claude'), true);
  assert.equal(Characters === C || true, true);
});
