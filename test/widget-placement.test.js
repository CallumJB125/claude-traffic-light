'use strict';
// Q8: where the widget sits when it has no saved spot, on any display, clear of the main window's header; and the
// widget bubble's size floor (text 12 px, buttons 28 px, 280 px wide).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/widget-placement.js');

const D1 = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const D2 = { id: 2, workArea: { x: 1440, y: -200, width: 1920, height: 1080 } };
const fakeScreen = (displays) => ({
  getPrimaryDisplay: () => displays[0],
  getAllDisplays: () => displays,
  getDisplayMatching: (r) => displays.map((d) => ({ d, area: Math.max(0, Math.min(r.x + r.width, d.workArea.x + d.workArea.width) - Math.max(r.x, d.workArea.x)) * Math.max(0, Math.min(r.y + r.height, d.workArea.y + d.workArea.height) - Math.max(r.y, d.workArea.y)) })).sort((a, b) => b.area - a.area)[0].d,
});
const size = { width: 100, height: 128 };

test('no main window: top-right of the primary display, 16 px in', () => {
  assert.deepEqual(P.defaultBounds(fakeScreen([D1, D2]), size), { x: 1440 - 100 - 16, y: 25 + 16, ...size });
});

test('a main window under the top-right corner: the widget slides below its title bar and controls', () => {
  const main = { x: 300, y: 60, width: 1100, height: 700 };
  const r = P.defaultBounds(fakeScreen([D1]), size, main);
  assert.equal(r.x, 1440 - 100 - 16);
  assert.equal(r.y, main.y + P.HEADER_H + P.MARGIN, 'a title-bar height plus 16 px below the window top');
});

test('a main window that does not reach the corner leaves the default spot alone', () => {
  assert.deepEqual(P.defaultBounds(fakeScreen([D1]), size, { x: 20, y: 60, width: 700, height: 600 }), { x: 1324, y: 41, ...size });
});

test('multi-display: the widget goes to the display the main window is on, not the primary', () => {
  const main = { x: 2200, y: -150, width: 1100, height: 800 };
  const r = P.defaultBounds(fakeScreen([D1, D2]), size, main);
  assert.equal(r.x, 1440 + 1920 - 100 - 16);
  assert.ok(r.y >= main.y + P.HEADER_H + P.MARGIN, 'clear of that window header');
  assert.ok(r.x >= D2.workArea.x && r.x + r.width <= D2.workArea.x + D2.workArea.width);
});

test('no room below the header: bottom-right of the display', () => {
  const main = { x: 100, y: 25, width: 1300, height: 875 };
  const r = P.defaultBounds(fakeScreen([D1]), { width: 100, height: 800 }, main);
  assert.equal(r.y, 25 + 875 - 800 - P.MARGIN);
});

test('a saved spot on a display that is gone comes back on screen, keeping its size; a visible one is kept', () => {
  const only = fakeScreen([D1]);
  const gone = { x: 3000, y: 100, width: 107, height: 137 };
  const back = P.visibleOrDefault(only, gone, null);
  assert.deepEqual([back.width, back.height], [107, 137]);
  assert.ok(back.x >= 0 && back.x + back.width <= 1440);
  const kept = { x: 500, y: 300, width: 107, height: 137 };
  assert.equal(P.visibleOrDefault(only, kept, null), kept);
});

test('the widget bubble keeps text at 12 px or more, buttons 28 px tall, 280 px wide', () => {
  const css = fs.readFileSync(path.join(__dirname, '../input-bubble.css'), 'utf8').split('/* ── The Waiting page')[0];
  const sizes = [...css.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));
  assert.ok(sizes.length >= 8);
  assert.deepEqual(sizes.filter((n) => n < 12), [], 'no widget bubble text under 12 px');
  assert.match(css, /\.ib-opt \{[^}]*min-height: 28px/);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /BUBBLE_MIN_W = 288;/, '280 px bubble plus 4 px each side');
});
