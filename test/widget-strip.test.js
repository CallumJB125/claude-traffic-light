// Widget sizing while the bubble or the recap shows (src/widget-strip.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('S1: on a short display the bubble is clamped to fit under a large widget, stays on screen, and is not vouched for', () => {
  const wa = { x: 0, y: 25, width: 1280, height: 775 }; // 1280×800 with the menu bar
  const widget = { x: 940, y: 300, width: 320, height: 410 }; // the largest widget (320 at 64:82)
  const asked = 408; // CSS max-height 400 + 8
  const cap = W.bubbleRoom(widget.height, wa, 420);
  assert.equal(cap, 365);
  const r = W.stripBounds(widget, W.NONE, { kind: 'bubble', px: Math.min(cap, asked), minWidth: 288 }, wa);
  assert.ok(r.bounds.y >= wa.y && r.bounds.y + r.bounds.height <= wa.y + wa.height, 'the whole window stays in the work area');
  assert.equal(r.bounds.height, widget.height + cap);
  assert.equal(W.shouldAck(r.strip, asked, null, cap), false, 'clamped: the bubble scrolls, nothing in it counts as seen');
  // The same widget on a tall display has room: vouched for as before.
  const tall = { x: 0, y: 25, width: 1440, height: 875 };
  const room = W.bubbleRoom(widget.height, tall, 420);
  assert.equal(room, 420);
  assert.equal(W.shouldAck({ kind: 'bubble', px: asked }, asked, null, room), true);
  assert.equal(W.bubbleRoom(900, wa, 420), 0, 'never negative');
});

test('S1: main clamps the bubble to bubbleRoom and acks against that cap', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const apply = main.slice(main.indexOf('function applyStrip('), main.indexOf('function applyStrip(') + 1200);
  assert.match(apply, /bubbleCap = WidgetStrip\.bubbleRoom\(base\.height, workArea, BUBBLE_MAX_PX\)/);
  assert.match(apply, /kind: 'bubble', px: Math\.min\(bubbleCap, asking\)/);
  assert.match(main, /WidgetStrip\.shouldAck\(strip, bubbleAsked, bubbleAcked, bubbleCap\)/);
});

test('S1: the cap goes to the widget when it changes or the bubble asks for more; a capped bubble then asks what fits and is vouched for', () => {
  assert.equal(W.sendCap(420, 420, 300), false, 'room as before and the bubble fits: nothing to say');
  assert.equal(W.sendCap(365, 420, 408), true, 'room shrank');
  assert.equal(W.sendCap(365, 365, 408), true, 'still asking more (a reloaded widget has not heard): say it again');
  assert.equal(W.sendCap(365, 365, 365), false);
  assert.equal(W.sendCap(420, 365, 365), true, 'room grew on a taller display: the bubble may grow back');
  // The round trip on 1280×800 with the largest widget: the bubble asks 408, main caps it at 365 and says so;
  // the widget caps #bubble at 365 - 8 (it scrolls), measures 357 + 8 = 365 and asks again.
  const wa = { x: 0, y: 25, width: 1280, height: 775 };
  const widget = { x: 940, y: 300, width: 320, height: 410 };
  const cap = W.bubbleRoom(widget.height, wa, 420);
  const first = W.stripBounds(widget, W.NONE, { kind: 'bubble', px: Math.min(cap, 408), minWidth: 288 }, wa);
  assert.equal(W.shouldAck(first.strip, 408, null, cap), false, 'before the widget hears the cap: not vouched for');
  const css = Math.min(400, cap - 8);
  const asked = Math.ceil(Math.min(392, css)) + 8; // content 392 px tall, capped by CSS
  assert.equal(asked, cap);
  assert.ok(W.sameStrip(first.strip, { kind: 'bubble', px: Math.min(cap, asked), minWidth: 288 }), 'the window already has that room: no resize');
  assert.equal(W.shouldAck(first.strip, asked, null, cap), true, 'now vouched for, so it can be answered');
  assert.ok(first.bounds.y + first.bounds.height <= wa.y + wa.height && first.bounds.height - widget.height === asked, 'on screen, and the window matches --bubble-h');
});

test('S1: main sends bubble-cap from applyStrip; the widget caps #bubble at it and asks again', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const apply = main.slice(main.indexOf('function applyStrip('), main.indexOf('function applyStrip(') + 1400);
  assert.match(apply, /WidgetStrip\.sendCap\(bubbleCap, bubbleCapSent, asking\)[^\n]*win\.webContents\.send\('bubble-cap', bubbleCap\)/);
  assert.ok(apply.indexOf("send('bubble-cap'") < apply.indexOf('WidgetStrip.sameStrip('), 'sent before the same-strip early return');
  assert.match(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), /onBubbleCap: \(cb\) => ipcRenderer\.on\('bubble-cap'/);
  const widget = fs.readFileSync(path.join(root, 'widget.js'), 'utf8');
  assert.match(widget, /onBubbleCap\(\(cap\) => \{[\s\S]{0,200}--bubble-max', `\$\{Math\.max\(0, Math\.round\(n\) - 8\)\}px`\);\s*reportBubble\(\);/);
  assert.match(widget, /if \(!on\) document\.body\.style\.removeProperty\('--bubble-max'\);\s*if \(fresh\) bubbleEl\.scrollTop = 0;/, 'an empty bubble forgets the cap');
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /#bubble \{[^}]*max-height: min\(400px, var\(--bubble-max, 400px\)\);[^}]*overflow-y: auto/);
});

// ── Session rows (wave 1, lane A) ───────────────────────────────────────────
const row = (id, signal, min = 0) => ({ sessionId: id, signal, cwd: `/p/${id}`, updatedAt: new Date(Date.parse('2026-10-19T12:00:00Z') - min * 60000).toISOString() });

test('session rows: pinned first, then waiting, then working, then idle', () => {
  const m = W.sessionRows([row('i1', 'idle'), row('w1', 'tool-use', 1), row('a1', 'permission-ask', 5), row('p1', 'idle')], { pinnedId: 'p1' });
  assert.deepEqual(m.rows.map((r) => r.id), ['p1', 'a1', 'w1', 'i1']);
  assert.equal(m.rows[0].pinned, true);
  assert.equal(m.pinnedId, 'p1');
  assert.equal(m.collapsed, false);
  assert.ok(m.rows.every((r) => r.team === false));
});

test('session rows: idle sessions fold into one "+N idle" chip past the threshold', () => {
  const list = [row('a', 'tool-use'), row('b', 'tool-use'), row('c', 'idle', 1), row('d', 'idle', 2), row('e', 'idle', 3)];
  const m = W.sessionRows(list);
  assert.equal(m.collapsed, true);
  assert.deepEqual(m.rows.map((r) => r.kind), ['session', 'session', 'idle']);
  assert.deepEqual(m.rows[2], { kind: 'idle', count: 3, ids: ['c', 'd', 'e'], team: false });
  assert.equal(W.sessionRows(list, { collapseAfter: 10 }).collapsed, false);
  assert.equal(W.COLLAPSE_AFTER, 4);
});

test('session rows: a pin to a session that is gone is ignored', () => {
  const m = W.sessionRows([row('a', 'tool-use')], { pinnedId: 'gone' });
  assert.equal(m.pinnedId, null);
  assert.equal(m.rows[0].pinned, false);
});

test('session rows: teammates are a second row marked team', () => {
  const m = W.sessionRows([row('a', 'tool-use')], { teammates: [{ member_id: 'm1', name: 'Ann', sessions: [{ agent: 'codex', repo_short: 'plex', state: 'waiting' }, { agent: 'claude', repo_short: 'site', state: 'idle' }] }] });
  assert.equal(m.team.length, 2);
  assert.ok(m.team.every((r) => r.team === true && r.name === 'Ann'));
  assert.equal(m.team[0].session.signal, 'permission-ask');
  assert.equal(m.team[1].session.signal, 'idle');
  assert.equal(m.rows.length, 1);
});

test('session rows: junk input yields an empty model', () => {
  assert.deepEqual(W.sessionRows(null), { rows: [], team: [], pinnedId: null, collapsed: false });
  assert.deepEqual(W.sessionRows([null, 3, 'x'], { teammates: [null, { sessions: [null] }] }).rows, []);
});
