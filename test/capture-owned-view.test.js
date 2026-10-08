
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { captureOwnedView } = require('../src/capture-owned-view');
const { fromPage } = require('../src/utility-pages');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const image = { isEmpty: () => false, toPNG: () => Buffer.from('owned png') };
const contents = overrides => ({ isDestroyed: () => false, executeJavaScript: async () => true, capturePage: async () => image, ...overrides });
test('capture awaits two frame readiness before native page, with hidden capture visibility unchanged', async () => {
  const ready = deferred(); const calls = [];
  const wc = contents({ executeJavaScript: code => { assert.match(code, /requestAnimationFrame.*requestAnimationFrame/); return ready.promise; },
    capturePage: async (...args) => { calls.push(args); return image; } });
  const pending = captureOwnedView(wc, () => true);
  assert.equal(calls.length, 0); ready.resolve(true);
  assert.equal(await pending, image); assert.deepEqual(calls, [[undefined, { stayHidden: true }]]);
});
test('stale view between readiness and capture is refused before any native capture', async () => {
  const ready = deferred(); let current = true, captures = 0;
  const pending = captureOwnedView(contents({ executeJavaScript: () => ready.promise, capturePage: async () => { captures++; return image; } }), () => current);
  current = false; ready.resolve(true); assert.equal(await pending, null); assert.equal(captures, 0);
});
test('one cutoff includes readiness, refuses late native capture and includes image completion', async () => {
  const ready = deferred(); let captures = 0;
  assert.equal(await captureOwnedView(contents({ executeJavaScript: () => ready.promise, capturePage: async () => { captures++; return image; } }), () => true, { deadlineMs: 10 }), null);
  ready.resolve(true); await new Promise(r => setImmediate(r)); assert.equal(captures, 0);
  const capture = deferred();
  assert.equal(await captureOwnedView(contents({ capturePage: () => capture.promise }), () => true, { deadlineMs: 10 }), null);
  capture.resolve(image);
});
test('native surface errors and destroyed or empty views resolve fixed absence', async () => {
  for (const wc of [null, contents({ isDestroyed: () => true }), contents({ executeJavaScript: async () => { throw Error('private readiness'); } }),
    contents({ capturePage: async () => { throw Error('UnknownVizError private'); } }), contents({ capturePage: async () => ({ isEmpty: () => true }) })]) {
    assert.equal(await captureOwnedView(wc, () => true), null);
  }
});
test('late image never returns after current view changes', async () => {
  const capture = deferred(); let current = true;
  const pending = captureOwnedView(contents({ capturePage: () => capture.promise }), () => current);
  await new Promise(r => setImmediate(r)); current = false; capture.resolve(image); assert.equal(await pending, null);
});
function actualHandlers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handlers = new Map(), wc = { mainFrame: {}, isDestroyed: () => false }; let current = wc;
  const context = { Buffer, feedbackCaptureEpoch: 0, feedbackShot: null, feedbackSenderOk: e => fromPage(e, current),
    feedbackTargets: () => [{ id: 'main', label: 'Main app page', capture: context.capture }], capture: async () => image,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
  const begin = source.indexOf("ipcMain.handle('feedback-screenshot'");
  const end = source.indexOf("ipcMain.handle('feedback-preview'", begin);
  vm.runInNewContext(source.slice(begin, end), context);
  return { context, handlers, wc, event: { sender: wc, senderFrame: wc.mainFrame }, replace: () => { current = { mainFrame: {}, isDestroyed: () => false }; } };
}
test('actual feedback handler native rejection is fixed DTO and preserves exact sender guard', async () => {
  const f = actualHandlers(); let calls = 0;
  f.context.capture = async () => { calls++; throw Error('UnknownVizError secret'); };
  const screenshot = f.handlers.get('feedback-screenshot');
  for (const e of [{}, { sender: f.wc, senderFrame: {} }, { sender: {}, senderFrame: f.wc.mainFrame }]) assert.equal(await screenshot(e, 'main'), null);
  assert.equal(calls, 0);
  const result = await screenshot(f.event, 'main'); assert.deepEqual(JSON.parse(JSON.stringify(result)), { error: 'Could not capture that window. Try again.' });
  assert.equal(f.context.feedbackShot, null);
});
test('actual feedback handler refuses image after clear, newer capture or sender replacement', async () => {
  for (const action of ['clear', 'newer', 'sender']) {
    const f = actualHandlers(), capture = deferred();
    f.context.capture = () => capture.promise;
    const screenshot = f.handlers.get('feedback-screenshot'); const pending = screenshot(f.event, 'main');
    if (action === 'clear') f.handlers.get('feedback-clear-screenshot')(f.event);
    if (action === 'sender') f.replace();
    if (action === 'newer') { f.context.capture = async () => image; assert.match((await screenshot(f.event, 'main')).dataUrl, /^data:image/); }
    capture.resolve(image); assert.equal(await pending, null);
    if (action !== 'newer') assert.equal(f.context.feedbackShot, null);
  }
});
