const test = require('node:test');
const assert = require('node:assert/strict');
const { keepOffline, NOWHERE } = require('../src/spellcheck.js');

function fakeApp() {
  const handlers = {};
  return { handlers, on: (ev, fn) => { handlers[ev] = fn; }, whenReady: () => Promise.resolve() };
}
const fakeSession = () => {
  const calls = [];
  return { calls, setSpellCheckerEnabled: (v) => calls.push(['enabled', v]), setSpellCheckerDictionaryDownloadURL: (u) => calls.push(['url', u]) };
};

test('spellcheck: off on the default session and every partition created later, off macOS', async () => {
  for (const platform of ['win32', 'linux']) {
    const app = fakeApp();
    const def = fakeSession();
    assert.equal(keepOffline({ app, getDefaultSession: () => def, platform }), true);
    await Promise.resolve();
    assert.deepEqual(def.calls, [['enabled', false], ['url', NOWHERE]]);
    const board = fakeSession();
    app.handlers['session-created'](board);
    assert.deepEqual(board.calls, [['enabled', false], ['url', NOWHERE]]);
  }
});

test('spellcheck: macOS is left exactly as it was', () => {
  const app = fakeApp();
  assert.equal(keepOffline({ app, getDefaultSession: () => { throw new Error('touched'); }, platform: 'darwin' }), false);
  assert.deepEqual(app.handlers, {});
});
