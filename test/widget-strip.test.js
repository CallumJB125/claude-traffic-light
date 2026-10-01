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

test('only the bubble and the recap hold roam, glide, the garden and resizing; the update row rides along', () => {
  assert.equal(W.blocksTravel(W.NONE), false);
  const of = (next) => W.stripBounds(base, W.NONE, next, wa).strip;
  assert.equal(W.blocksTravel(of({ kind: 'bubble', px: 100, minWidth: 230 })), true);
  assert.equal(W.blocksTravel(of({ kind: 'away', px: 64 })), true);
  assert.equal(W.blocksTravel(of({ kind: 'update', px: 72 })), false);
});

test('resizing with the update row showing resizes the widget and keeps the row under it', () => {
  const limits = { minWidth: 80, maxWidth: 320, aspect: 64 / 82 };
  const up = W.stripBounds(base, W.NONE, { kind: 'update', px: 72 }, wa);
  const r = W.resizeBase(up.bounds, up.strip, 1.25, limits, wa);
  const b = W.baseOf(r.bounds, r.strip);
  assert.equal(b.width, 125);
  assert.equal(b.height, Math.round(125 / limits.aspect));
  assert.equal(r.strip.kind, 'update');
  assert.equal(r.bounds.height, b.height + 72, 'the row keeps its height');
  assert.ok(Math.abs(b.x + b.width / 2 - (base.x + base.width / 2)) <= 0.5, 'same centre (to the pixel)');
  const none = W.resizeBase(base, W.NONE, 0.8, limits, wa);
  assert.deepEqual(none.strip, W.NONE);
  assert.equal(none.bounds.width, 80);
});

test('the widget is only told its bubble has room when the window was not clamped', () => {
  const bubble = { kind: 'bubble', px: 300 };
  assert.equal(W.shouldAck(bubble, 300, null, 300), true);
  assert.equal(W.shouldAck(bubble, 301, null, 300), false, 'asked more than the cap: may be clipped');
  assert.equal(W.shouldAck(bubble, 120, 120, 300), false, 'already acked');
  assert.equal(W.shouldAck({ kind: 'away', px: 64 }, 120, null, 300), false);
  assert.equal(W.shouldAck(W.NONE, 120, null, 300), false);
});
