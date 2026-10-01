const test = require('node:test');
const assert = require('node:assert/strict');
const ClickThrough = require('../src/click-through.js');

function rig(platform) {
  const calls = [];
  const sent = [];
  let cursor = { x: 0, y: 0 };
  let timer = null;
  const win = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 100, y: 100, width: 100, height: 128 }),
    setIgnoreMouseEvents: (...a) => calls.push(a),
    webContents: { send: (...a) => sent.push(a) },
  };
  const ct = ClickThrough.create({
    platform,
    screen: { getCursorScreenPoint: () => cursor },
    getWin: () => win,
    every: (ms, fn) => { timer = { ms, fn }; return timer; },
    stopTimer: () => { timer = null; return null; },
  });
  return { ct, calls, sent, move: (x, y) => { cursor = { x, y }; timer?.fn(); }, timer: () => timer };
}

test('click-through: macOS and Windows forward mousemoves and never poll', () => {
  for (const platform of ['darwin', 'win32']) {
    const r = rig(platform);
    r.ct.set(true);
    r.ct.set(false);
    assert.deepEqual(r.calls, [[true, { forward: true }], [false, { forward: true }]]);
    assert.equal(r.timer(), null);
  }
});

test('click-through: Linux polls the cursor while ignoring and asks for a hit test only over the window', () => {
  const r = rig('linux');
  r.ct.set(true);
  assert.deepEqual(r.calls, [[true]]);
  assert.equal(r.timer().ms, ClickThrough.POLL_MS);
  r.move(10, 10);
  assert.deepEqual(r.sent, [], 'outside the window: nothing');
  r.move(150, 170);
  r.move(150, 170);
  assert.deepEqual(r.sent, [['hit-test', 50, 70]], 'inside: one hit test per cursor move');
  r.ct.set(false);
  assert.deepEqual(r.calls, [[true], [false]]);
  assert.equal(r.timer(), null, 'polling stops once the window takes the mouse again');
});

test('click-through: inside() is half-open on the far edges', () => {
  const b = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(ClickThrough.inside({ x: 0, y: 0 }, b), true);
  assert.equal(ClickThrough.inside({ x: 10, y: 5 }, b), false);
});
