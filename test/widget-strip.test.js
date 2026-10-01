// Widget sizing while the bubble or the recap shows (src/widget-strip.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/widget-strip.js');

const base = { x: 1000, y: 200, width: 100, height: 128 };
const wa = { x: 0, y: 25, width: 1440, height: 875 };

test('the bubble adds its height and the width to read it, split evenly so Claude stays put', () => {
  const r = W.stripBounds(base, W.NONE, { kind: 'bubble', px: 180, minWidth: 230 }, wa);
  assert.deepEqual(r.bounds, { x: 935, y: 200, width: 230, height: 308 });
  assert.equal(r.bounds.x + r.bounds.width / 2, base.x + base.width / 2, 'same centre');
  assert.deepEqual(W.baseOf(r.bounds, r.strip), base, 'the base comes back exactly');
});

test('changing height or kind is computed from the base: no creep, and back to the exact base', () => {
  let cur = base;
  let strip = W.NONE;
  for (const next of [{ kind: 'bubble', px: 180, minWidth: 230 }, { kind: 'bubble', px: 90, minWidth: 230 }, { kind: 'away', px: 64 }, { kind: 'bubble', px: 64, minWidth: 230 }, { kind: null }]) {
    const r = W.stripBounds(cur, strip, next, wa);
    cur = r.bounds;
    strip = r.strip;
    assert.deepEqual(W.baseOf(cur, strip), base, JSON.stringify(next));
  }
  assert.deepEqual(cur, base);
  assert.deepEqual(strip, W.NONE);
});

test('a recap and a bubble of the same height are different strips (the bubble widens)', () => {
  const away = W.stripBounds(base, W.NONE, { kind: 'away', px: 64 }, wa);
  assert.equal(away.bounds.width, 100);
  assert.equal(W.sameStrip(away.strip, { kind: 'bubble', px: 64, minWidth: 230 }), false);
  assert.equal(W.sameStrip(away.strip, { kind: 'away', px: 64 }), true);
  assert.equal(W.sameStrip(W.NONE, { kind: null }), true);
});

test('near the bottom or right edge the grown rect moves up or left to stay on screen', () => {
  const low = { x: 1380, y: 800, width: 100, height: 128 };
  const r = W.stripBounds(low, W.NONE, { kind: 'bubble', px: 200, minWidth: 230 }, wa);
  assert.equal(r.bounds.y + r.bounds.height, wa.y + wa.height, 'bottom on the work area');
  assert.equal(r.bounds.x + r.bounds.width, wa.x + wa.width, 'right edge on the work area');
  assert.deepEqual(W.baseOf(r.bounds, r.strip), low, 'and the widget goes back where it was');
  const back = W.stripBounds(r.bounds, r.strip, { kind: null }, wa);
  assert.deepEqual(back.bounds, low);
});

test('a widget already wider than the bubble needs no extra width', () => {
  const wide = { x: 100, y: 100, width: 300, height: 384 };
  const r = W.stripBounds(wide, W.NONE, { kind: 'bubble', px: 100, minWidth: 230 }, wa);
  assert.deepEqual(r.bounds, { x: 100, y: 100, width: 300, height: 484 });
});
