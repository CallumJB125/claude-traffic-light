'use strict';
// QoL2b (plan-qol2b, approved with B-M1, B-S1, B-S2): the widget remembers where it sat on each display and goes back
// when that display returns; Overview's My sessions rows say how long a session has waited on you.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/widget-display-spots.js');
const { createOverviewService } = require('../src/overview-service.js');
const { createSessionDirectory } = require('../src/session-directory.js');
const SidebarRows = require('../src/overview-sidebar-rows.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── displays ───────────────────────────────────────────────────────────────
const disp = (id, label, x, w = 1920, h = 1080) => ({ id, label, size: { width: w, height: h }, bounds: { x, y: 0, width: w, height: h }, workArea: { x, y: 25, width: w, height: h - 25 } });
const LAPTOP = disp(1, 'Built-in Retina Display', 0, 1512, 982);
const DELL = disp(7, 'DELL U2720Q', 1512);
function fakeScreen(list) {
  const s = {
    list: [...list],
    getAllDisplays: () => s.list,
    getPrimaryDisplay: () => s.list[0],
    getDisplayMatching: (r) => s.list.find((d) => { const cx = r.x + r.width / 2, cy = r.y + r.height / 2; return cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height; }) || s.list[0],
  };
  return s;
}

test('keys: id with size first; the label with size only when exactly one saved spot has it', () => {
  assert.deepEqual(S.keyOf(DELL), { id: '7|1920x1080', label: 'DELL U2720Q|1920x1080' });
  assert.deepEqual(S.keyOf({ id: 3, label: '', size: { width: 10, height: 20 } }), { id: '3|10x20', label: null });
  assert.equal(S.keyOf(null), null);
  let file = S.remember(null, DELL, { x: 2000, y: 100, width: 100, height: 80 }, 1);
  // Reconnected under a new id: the label finds it.
  assert.deepEqual(S.spotFor(file, { ...DELL, id: 99 }), { x: 2000, y: 100, width: 100, height: 80 });
  // Two identical monitors share a label: neither is guessed.
  file = S.remember(file, { ...DELL, id: 8 }, { x: 3000, y: 100, width: 100, height: 80 }, 2);
  assert.equal(S.spotFor(file, { ...DELL, id: 99 }), null);
  assert.deepEqual(S.spotFor(file, DELL), { x: 2000, y: 100, width: 100, height: 80 });
  // Another size is another monitor.
  assert.equal(S.spotFor(file, { ...DELL, id: 99, size: { width: 2560, height: 1440 } }), null);
});

test('the file: the last bounds stay at the top level (older builds read them as before), with at most 8 spots, oldest dropped', () => {
  let file = { x: 5, y: 6, width: 100, height: 80 }; // v1
  assert.equal(S.spotFor(file, DELL), null, 'a v1 file has no per-display spots');
  for (let i = 0; i < 10; i += 1) file = S.remember(file, { ...DELL, id: 100 + i }, { x: 2000 + i, y: 10, width: 100, height: 80 }, i);
  assert.equal(file.spots.length, S.MAX_SPOTS);
  assert.deepEqual(file.spots.map((s) => s.id.split('|')[0]), ['102', '103', '104', '105', '106', '107', '108', '109']);
  assert.deepEqual({ x: file.x, y: file.y, width: file.width, height: file.height }, { x: 2009, y: 10, width: 100, height: 80 });
  assert.equal(file.v, 2);
  // Saving the same display again replaces its spot rather than adding one.
  const again = S.remember(file, { ...DELL, id: 109 }, { x: 1, y: 2, width: 100, height: 80 }, 99);
  assert.equal(again.spots.length, S.MAX_SPOTS);
  assert.deepEqual(S.spotFor(again, { ...DELL, id: 109 }), { x: 1, y: 2, width: 100, height: 80 });
  // Junk spots are ignored, never thrown on.
  assert.equal(S.spotFor({ spots: [null, { id: '7|1920x1080', bounds: { x: 'a' } }, 7] }, DELL), null);
  // main.js reads only the top-level rect, so a v2 file opens where a v1 file did.
  assert.match(read('main.js'), /saved = \{ x: saved\.x, y: saved\.y, width: saved\.width, height: saved\.height \};/);
});

function keeperRig({ displays = [LAPTOP, DELL], start = { x: 2000, y: 100, width: 100, height: 80 }, busy = () => false } = {}) {
  const screen = fakeScreen(displays);
  let t = 1000, file = null, timers = [];
  const widget = { ...start };
  const moves = [];
  const k = S.createKeeper({
    screen, read: () => file, write: (f) => { file = f; }, bounds: () => ({ ...widget }), busy,
    move: (p) => { moves.push(p); Object.assign(widget, p); },
    commit: () => k.save({ ...widget }),
    now: () => t, setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; }, clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
  });
  const advance = (ms) => { t += ms; const due = timers.filter((h) => h.at <= t); timers = timers.filter((h) => h.at > t); due.forEach((h) => h.fn()); };
  // The OS or the person moves the widget: the window emits `move`.
  const osMove = (p) => { Object.assign(widget, p); k.moveEvent(); };
  return { k, screen, widget, moves, advance, osMove, file: () => file };
}

test('B-M1: unplugging the display moves the widget to its spot on the one left, the system nudge saves nothing, and replugging puts it back', () => {
  const r = keeperRig();
  r.k.save({ x: 300, y: 300, width: 100, height: 80 }); // its spot on the laptop, from earlier
  Object.assign(r.widget, { x: 2000, y: 100 });
  r.k.save({ ...r.widget }); // now on the Dell
  const before = JSON.stringify(r.file().spots);
  // macOS slides it onto the laptop first, then Electron reports the removal.
  r.osMove({ x: 1400, y: 100 });
  r.screen.list = [LAPTOP];
  r.k.displayRemoved(DELL);
  assert.deepEqual(r.moves.at(-1), { x: 300, y: 300 }, 'its own laptop spot, not wherever the system put it');
  r.osMove({ x: 300, y: 300 }); // our own move's event, inside the settle window
  r.advance(5000);
  assert.equal(JSON.stringify(r.file().spots), before, 'no spot was overwritten');
  assert.equal(r.k.state().movedSince, false);
  // The Dell comes back (under a new id after the reconnect): the widget goes back to its Dell spot.
  r.advance(5000);
  r.screen.list = [LAPTOP, DELL];
  r.k.displayAdded({ ...DELL, id: 42 });
  assert.deepEqual(r.moves.at(-1), { x: 2000, y: 100 });
});

test('replugging does not move the widget if the person moved it after it was re-homed', () => {
  const r = keeperRig();
  r.k.save({ ...r.widget });
  r.screen.list = [LAPTOP];
  r.k.displayRemoved(DELL);
  r.advance(2000);
  r.osMove({ x: 50, y: 400 }); // the person drags it
  r.advance(1500);
  assert.equal(r.k.state().movedSince, true);
  assert.deepEqual(S.spotFor(r.file(), LAPTOP), { x: 50, y: 400, width: 100, height: 80 }, 'their move is saved once it stands');
  const n = r.moves.length;
  r.screen.list = [LAPTOP, DELL];
  r.k.displayAdded(DELL);
  assert.equal(r.moves.length, n);
});

test('a move is saved only once it has stood; a display change cancels it; another display going leaves the widget alone', () => {
  const r = keeperRig({ start: { x: 300, y: 300, width: 100, height: 80 } });
  r.k.seen({ ...r.widget });
  r.osMove({ x: 310, y: 310 });
  r.k.metricsChanged(); // Dock or scale change before the move stood
  r.advance(3000);
  assert.equal(r.file(), null, 'the pending save was cancelled');
  // The Dell goes while the widget sits on the laptop: nothing moves.
  r.screen.list = [LAPTOP];
  r.k.displayRemoved(DELL);
  assert.deepEqual(r.moves, []);
  assert.equal(r.k.state().rehomedFrom, null);
});

test('never during a glide, roam, garden run or strip change; a widget left off every display still comes back on screen', () => {
  const busy = keeperRig({ busy: () => true });
  busy.k.save({ ...busy.widget });
  busy.screen.list = [LAPTOP];
  busy.k.displayRemoved(DELL);
  assert.deepEqual(busy.moves, []);
  // No saved spot and nothing recorded: off every display → the default spot, through visibleOrDefault.
  const lost = keeperRig({ start: { x: 5000, y: 100, width: 100, height: 80 } });
  lost.screen.list = [LAPTOP];
  lost.k.displayRemoved(disp(9, 'Old', 4000));
  assert.equal(lost.moves.length, 1);
  const p = lost.moves[0];
  assert.ok(p.x >= 0 && p.x + 100 <= 1512, JSON.stringify(p));
});

test('main.js wiring: the move handler defers to the keeper, display events go through it after stopping a glide', () => {
  const main = read('main.js');
  assert.match(main, /w\.on\('move', \(\) => \{ if \(current\(\) && !glideTimer\) spots\(\)\.moveEvent\(\); \}\);/);
  assert.match(main, /screen\.on\('display-removed', \(_e, d\) => \{ stopGlide\(\); spots\(\)\.displayRemoved\(d\); \}\);/);
  assert.match(main, /screen\.on\('display-added', \(_e, d\) => \{ stopGlide\(\); spots\(\)\.displayAdded\(d\); \}\);/);
  assert.match(main, /screen\.on\('display-metrics-changed', \(\) => spots\(\)\.metricsChanged\(\)\);/);
  assert.match(main, /busy: \(\) => !!glideTimer \|\| !!gardenRun \|\| roamState\.busy \|\| applyingStrip,/);
  assert.match(main, /function saveBounds\(\) \{\n  if \(!win \|\| gardenRun \|\| roamState\.busy\) return;[\s\S]{0,200}spots\(\)\.save\(WidgetStrip\.baseOf\(win\.getBounds\(\), strip\)\);\n\}/);
});

// ── Overview: how long a session has waited ────────────────────────────────
const T = Date.parse('2026-11-05T12:00:00Z');
const iso = (msAgo) => new Date(T - msAgo).toISOString();
async function overviewRow(raw) {
  const svc = createOverviewService({ sessions: () => [{ sessionId: 'sess-1', cwd: '/p/app', updatedAt: iso(1000), ...raw }], work: async () => ({ sources: [], capture: [] }), now: () => T });
  return (await svc.snapshot()).sessions[0];
}

test('Overview: a local row waiting on you carries waiting_ms from signalSince; nothing otherwise', async () => {
  const waiting = await overviewRow({ signal: 'permission-ask', signalSince: iso(4 * 60000) });
  assert.equal(waiting.bucket, 'needs');
  assert.equal(waiting.waiting_ms, 4 * 60000);
  assert.ok(waiting.age_ms < 60000, 'last observed is a different clock');
  assert.equal('waiting_ms' in (await overviewRow({ signal: 'tool-use', signalSince: iso(4 * 60000) })), false);
  assert.equal('waiting_ms' in (await overviewRow({ signal: 'permission-ask' })), false, 'never from updatedAt');
  assert.equal('waiting_ms' in (await overviewRow({ signal: 'permission-ask', signalSince: new Date(T + 5000).toISOString() })), false, 'a future stamp');
  assert.equal('waiting_ms' in (await overviewRow({ signal: 'permission-ask', signalSince: 'soon' })), false);
});

test('the directory carries it for a needs row only, and an owned session takes it from its own hook report', () => {
  const d = createSessionDirectory({ now: () => T });
  const caps = { open: { enabled: false, label: 'Open', reason: 'x' }, message: { enabled: false, label: 'Message', reason: 'x' } };
  const row = (over) => ({ id: 'w-1', handle: null, label: 'Session', provider: { id: 'claude', label: 'Claude Code', kind: 'integrated' }, device: { label: 'This device', local: true }, board: { label: 'Unassigned', kind: 'unknown' }, project: 'app', status: 'Needs you', bucket: 'needs', freshness: 'recent', age_ms: 2000, task: { status: 'unknown', title: 'Task not reported', key: null }, children: [], capabilities: caps, ...over });
  assert.equal(d.mine({ work: [row({ waiting_ms: 240000 })] })[0].waitingMs, 240000);
  assert.equal(d.mine({ work: [row({ waiting_ms: 240000, status: 'Working on it', bucket: 'working' })] })[0].waitingMs, null);
  for (const bad of [-1, 1.5, '240000', null]) assert.equal(d.mine({ work: [row({ waiting_ms: bad })] })[0].waitingMs, null, String(bad));
  assert.match(read('src/session-directory.js'), /owned\.bucket = observed\.bucket; owned\.waitingMs = observed\.waitingMs \?\? null;/);
});

test('the My sessions tag: " · 4m" from a minute, only for a recent row waiting on you', () => {
  const src = read('overview-directory.js');
  const from = src.indexOf('  const waitShort = ');
  const fns = new Function(`${src.slice(from, src.indexOf('\n', src.indexOf('  const stateText = ', from)))}\nreturn { waitShort, stateText };`)();
  const recent = { freshness: 'recent' };
  assert.equal(fns.stateText({ state: 'Needs you', input: true, waitingMs: 4 * 60000 }, recent), 'Needs you · 4m');
  assert.equal(fns.stateText({ state: 'Needs you', input: true, waitingMs: 59000 }, recent), 'Needs you');
  assert.equal(fns.stateText({ state: 'Needs you', input: true, waitingMs: 3 * 3600000 }, recent), 'Needs you · 3h');
  assert.equal(fns.stateText({ state: 'Idle', input: false, waitingMs: 4 * 60000 }, recent), 'Idle');
  assert.equal(fns.stateText({ state: 'Needs you', input: true, waitingMs: 4 * 60000 }, { freshness: 'stale' }), 'Needs you · Stale', 'a stale row never claims a live wait');
  assert.equal(fns.stateText({ state: 'Needs you', input: true, waitingMs: null }, recent), 'Needs you');
});

test('B-S2: the chat-first sidebar rows never carry waiting_ms', () => {
  assert.equal(SidebarRows.KEYS.includes('waiting_ms'), false);
  assert.equal(SidebarRows.TEAM_KEYS.includes('waiting_ms'), false);
});
