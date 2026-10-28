'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const SharedMain = require('../src/thread-shared-main');

const auth = () => ({ live: () => true, owner: 'Bob', seen: () => null, invalidate() {}, resolve: async () => ({ hub: {}, scope: 'interact' }),
  inspect: async () => ({ ok: true, selection: crypto.randomUUID(), state: { generation: 2, activeTurn: null, provider: { label: 'Codex' } }, capabilities: { send: { available: true, reason: '' } } }),
  act: async () => ({ ok: true, delivery: { id: 'd', state: 'acknowledged' } }) });
const c = { contents: { id: 1 }, generation: 1, boundId: 'b'.repeat(64) }, still = () => true;
async function sendOnce(a, t) {
  const r = await a.review(c, { op: 'send', text: 'x' }, still); t.v += 700;
  const done = await a.confirm(c, { selection: r.selection, text: 'x' }, still);
  const view = { header: {} }; a.afterRead(c, view);
  return { ok: done.ok, askEach: view.askEach, window: view.window };
}

test('Ask me each time: a stored "on" is honoured from the first send after a restart, and no window opens', async () => {
  const t = { v: 0 };
  const a = SharedMain.createSharedThreadActions({ authority: () => auth(), askEach: { get: () => true, set() {} }, now: () => t.v });
  const done = await sendOnce(a, t);
  assert.equal(done.ok, true);
  assert.equal(done.askEach, true);
  assert.equal(done.window, 0);
});

test('Ask me each time: off by default, with no preference, a missing value or a broken read', async () => {
  for (const askEach of [null, { get: () => undefined, set() {} }, { get: () => 'yes', set() {} }, { get: () => { throw new Error('x'); }, set() {} }]) {
    const t = { v: 0 };
    const a = SharedMain.createSharedThreadActions({ authority: () => auth(), askEach, now: () => t.v });
    const done = await sendOnce(a, t);
    assert.equal(done.askEach, false);
    assert.ok(done.window > 0, 'the first accepted card opens the window as before');
  }
});

test('Ask me each time: only the toggle writes it, a refused request writes nothing, and a failed save never errors the toggle', async () => {
  const wrote = [];
  const a = SharedMain.createSharedThreadActions({ authority: () => auth(), askEach: { get: () => false, set: (v) => wrote.push(v) } });
  assert.equal((await a.review(c, { askEach: true }, still)).askEach, true);
  assert.equal((await a.review(c, { askEach: false }, still)).askEach, false);
  for (const bad of [{ askEach: 'yes' }, { askEach: true, op: 'send' }, { end: true }]) assert.equal((await a.review(c, bad, still)).status, 'invalid');
  assert.deepEqual(wrote, [true, false]);
  const b = SharedMain.createSharedThreadActions({ authority: () => auth(), askEach: { get: () => false, set() { throw new Error('disk'); } } });
  const r = await b.review(c, { askEach: true }, still);
  assert.deepEqual([r.ok, r.askEach], [true, true], 'it still applies for this run');
});

test('Ask me each time: bound changes and the end of a thread leave the stored choice alone', async () => {
  const wrote = [];
  const a = SharedMain.createSharedThreadActions({ authority: () => auth(), askEach: { get: () => true, set: (v) => wrote.push(v) } });
  a.afterRead(c, { header: {} });
  a.forget?.(`${c.contents.id}:${c.generation}`);
  assert.deepEqual(wrote, []);
});

test('Ask me each time: main.js stores it with the preferences, off by default, coerced to a boolean, and wires it in', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /threadAskEach: false,/);
  assert.match(main, /config\.threadAskEach = saved\.threadAskEach === true;/);
  assert.match(main, /if \('threadAskEach' in partial\) next\.threadAskEach = partial\.threadAskEach === true;/);
  assert.match(main, /askEach: \{ get: \(\) => loadConfig\(\)\.threadAskEach === true, set: \(on\) => saveConfig\(\{ threadAskEach: on === true \}\) \}/);
  const thread = fs.readFileSync(path.join(__dirname, '..', 'src', 'thread-main.js'), 'utf8');
  assert.match(thread, /createSharedThreadActions\(\{ authority: sharedAuthority, askEach, now \}\)/);
});
