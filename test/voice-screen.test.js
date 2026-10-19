const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const VS = require('../src/voice-screen.js');
const VoiceCapture = require('../src/voice-capture-main.js');
const PointerOverlay = require('../src/pointer-overlay-main.js');
const VoiceOffer = require('../src/voice-offer.js');
const V = require('../src/voice.js');
const ROOT = path.join(__dirname, '..');

// ── Prompt and args ───────────────────────────────────────────────────────
test('the screen prompt names the file and its size; args allow Read on that one file only', () => {
  const p = VS.prompt({ question: 'where is wifi?', imagePath: '/tmp/plexiform-voice-ab/screen.png', width: 2880, height: 1800 });
  assert.match(p, /\/tmp\/plexiform-voice-ab\/screen\.png \(2880 x 1800 pixels/);
  assert.match(p, /Question: where is wifi\?/);
  assert.match(VS.prompt({ question: 'x', imagePath: '/a.png', width: 1, height: 1, point: false }), /Do not add any POINT tags/);
  const a = VS.claudeArgs('/tmp/plexiform-voice-ab/screen.png');
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(at('--tools'), 'Read');
  assert.equal(at('--allowedTools'), 'Read(//tmp/plexiform-voice-ab/screen.png)');
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--setting-sources'), '');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence'));
  assert.equal(at('--max-budget-usd'), '0.10');
  assert.match(at('--system-prompt'), /\[POINT:x,y:label\]/);
  assert.throws(() => VS.claudeArgs('relative.png'));
  assert.throws(() => VS.claudeArgs('/tmp/../etc/passwd'));
});

// ── Parse ────────────────────────────────────────────────────────────────
test('POINT tags are parsed strictly, clamped, capped at three, and never spoken', () => {
  const img = { width: 2000, height: 1000 };
  const r = VS.parse('Click Wi-Fi in the menu bar. [POINT:1800,12:Wi-Fi] [POINT:9999,-5:off] [POINT:10,20:x:screen2] [POINT:5,5:four]', img);
  assert.equal(r.text, 'Click Wi-Fi in the menu bar.');
  assert.deepEqual(r.points, [{ x: 1800, y: 12, label: 'Wi-Fi' }, { x: 10, y: 20, label: 'x' }, { x: 5, y: 5, label: 'four' }]);
  const clamp = VS.parse('Here [POINT:5000,3000:edge]', img);
  assert.deepEqual(clamp.points, [{ x: 1999, y: 999, label: 'edge' }]);
  for (const bad of ['[POINT:a,b:x]', '[POINT:1;2]', '[POINT 3,4]', '[POINT:1,2', '[POINT:NaN,1]', '[POINT:1e9,1]']) {
    const p = VS.parse(`Look ${bad} there.`, img);
    assert.deepEqual(p.points, [], bad);
    assert.doesNotMatch(p.text, /POINT/, bad);
  }
  assert.doesNotMatch(VS.parse('[POINT:1,1:<b>x</b>]', img).points[0].label, /[<>]/);
  assert.equal(VS.parse('a [POINT:1,1:' + 'x'.repeat(70) + ']', img).points[0].label.length, VS.MAX_LABEL);
  assert.deepEqual(VS.parse('no size [POINT:1,1:x]', {}).points, []);
  assert.equal(VS.parse('Plain answer.', img).text, 'Plain answer.');
});

// ── Coordinates ──────────────────────────────────────────────────────────
test('screenshot pixels map to global points on Retina and on an offset second display', () => {
  const retina = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
  assert.deepEqual(VS.imageSize(retina), { width: 2880, height: 1800 });
  assert.deepEqual(VS.toGlobal({ x: 2880, y: 1800, label: 'c' }, retina, { width: 2880, height: 1800 }), { x: 1439, y: 899, label: 'c', displayId: 1 });
  assert.deepEqual(VS.toGlobal({ x: 1000, y: 400, label: 'a' }, retina, { width: 2880, height: 1800 }), { x: 500, y: 200, label: 'a', displayId: 1 });
  const left = { id: 2, bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.deepEqual(VS.toGlobal({ x: 100, y: 50, label: 'b' }, left, { width: 1920, height: 1080 }), { x: -1820, y: -150, label: 'b', displayId: 2 });
  // A thumbnail smaller than asked for still maps by its real size.
  assert.deepEqual(VS.toGlobal({ x: 960, y: 540, label: 'm' }, left, { width: 960, height: 540 }), { x: -1920 + 1919, y: -200 + 1079, label: 'm', displayId: 2 });
});

// ── Capture lifecycle (fakes) ────────────────────────────────────────────
function fakeFs() {
  const files = new Map();
  const dirs = new Set();
  let n = 0;
  return {
    files, dirs,
    mkdtempSync(prefix) { const d = `${prefix}${n += 1}`; dirs.add(d); return d; },
    realpathSync: (p) => p,
    chmodSync() {},
    writeFileSync(p, data, opts) { files.set(p, { data, mode: opts && opts.mode }); },
    rmSync(p) { dirs.delete(p); for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k); },
  };
}
const display = { id: 7, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
function rig({ status = 'granted', ask, sources } = {}) {
  const fs2 = fakeFs();
  const calls = { getSources: [], ask: [] };
  const thumb = { isEmpty: () => false, toPNG: () => Buffer.from('png'), getSize: () => ({ width: 2880, height: 1800 }) };
  const cap = VoiceCapture.create({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: (k) => { assert.equal(k, 'screen'); return status; } },
    desktopCapturer: { getSources: async (o) => { calls.getSources.push(o); return sources || [{ display_id: '7', thumbnail: thumb }]; } },
    screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => display },
    fs: fs2, path, tmpdir: '/tmp', randomHex: () => 'abc',
    askClaude: (o) => { calls.ask.push(o); const seen = { file: [...fs2.files.entries()] }; calls.ask[calls.ask.length - 1].seen = seen; return ask(o); },
    spawn: () => { throw new Error('no spawn in tests'); }, env: {},
  });
  return { cap, fs: fs2, calls };
}

test('a granted capture writes a 0600 file in a plexiform-voice dir, hands only its path to claude, and deletes it', async () => {
  const { cap, fs: f, calls } = rig({ ask: () => ({ promise: Promise.resolve('Top right. [POINT:2800,10:Wi-Fi]'), cancel() {} }) });
  const r = await cap.ask({ question: 'where is wifi' });
  assert.equal(r.text, 'Top right.');
  assert.deepEqual(r.points, [{ x: 1400, y: 5, label: 'Wi-Fi', displayId: 7 }]);
  assert.deepEqual(calls.getSources[0].thumbnailSize, { width: 2880, height: 1800 });
  const [[file, meta]] = calls.ask[0].seen.file;
  assert.match(file, /^\/tmp\/plexiform-voice-abc-\d+\/screen\.png$/);
  assert.equal(meta.mode, 0o600);
  assert.ok(calls.ask[0].args.includes(`Read(/${file})`));
  assert.match(calls.ask[0].prompt, new RegExp(file.replace(/[/.]/g, '\\$&')));
  assert.equal(f.files.size, 0, 'screenshot removed');
  assert.equal(f.dirs.size, 0, 'folder removed');
});

test('the screenshot is deleted on error, on cancel and on timeout too', async () => {
  for (const ask of [
    () => ({ promise: Promise.reject(new Error('boom')), cancel() {} }),
    () => { let res; const p = new Promise((r) => { res = r; }); return { promise: p, cancel: () => res(null) }; },
    () => ({ promise: Promise.resolve(null), cancel() {} }), // askClaude's own timer resolves null
  ]) {
    const { cap, fs: f } = rig({ ask });
    let cancel = null;
    const pending = cap.ask({ question: 'q', onCancel: (fn) => { cancel = fn; } });
    await new Promise((r) => setImmediate(r));
    if (cancel) cancel();
    const r = await pending;
    assert.equal(r.text, null);
    assert.equal(f.files.size, 0);
    assert.equal(f.dirs.size, 0);
  }
});

test('without Screen Recording permission nothing is captured or written and the user is told how', async () => {
  for (const status of ['denied', 'restricted', 'not-determined']) {
    const { cap, fs: f, calls } = rig({ status, ask: () => assert.fail('claude must not be asked with a screen') });
    const r = await cap.ask({ question: 'q' });
    assert.equal(r.permission, true);
    assert.equal(f.files.size + f.dirs.size, 0);
    assert.equal(calls.ask.length, 0);
    // not-determined only triggers macOS's own prompt with a 1×1 request.
    assert.equal(calls.getSources.length, status === 'not-determined' ? 1 : 0);
  }
  assert.match(VoiceCapture.PERMISSION_TEXT, /System Settings, Privacy and Security, Screen Recording/);
});

test('pointing off: the answer is spoken without points', async () => {
  const { cap } = rig({ ask: () => ({ promise: Promise.resolve('Here. [POINT:1,1:x]'), cancel() {} }) });
  const r = await cap.ask({ question: 'q', point: false });
  assert.equal(r.text, 'Here.');
  assert.deepEqual(r.points, []);
});

// ── Pointer overlay ──────────────────────────────────────────────────────
function overlayRig({ reduced = false } = {}) {
  const made = [];
  class FakeWin {
    constructor(o) { this.opts = o; this.destroyed = false; this.ignore = null; this.sent = []; this.webContents = Object.assign(new EventEmitter(), { send: (ch, p) => this.sent.push([ch, p]) }); made.push(this); }
    setIgnoreMouseEvents(v) { this.ignore = v; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile(f) { this.file = f; }
    showInactive() { this.shown = 'inactive'; }
    show() { throw new Error('the overlay must never take focus'); }
    focus() { throw new Error('the overlay must never take focus'); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const timers = [];
  const d1 = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
  const d2 = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } };
  const o = PointerOverlay.create({
    BrowserWindow: FakeWin, htmlPath: 'pointer-overlay.html', preloadPath: 'p.js', reducedMotion: () => reduced,
    screen: { getDisplayNearestPoint: (p) => (p.x >= 1440 ? d2 : d1) },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  return { o, made, timers };
}

test('the pointer overlay is click-through, never focusable, one window per display, closed by 6 s', () => {
  const { o, made, timers } = overlayRig();
  assert.equal(o.show({ from: { x: 100, y: 100 }, points: [{ x: 50, y: 60, label: 'a' }, { x: 1500, y: 20, label: 'b' }] }), 2);
  for (const w of made) {
    assert.equal(w.opts.focusable, false);
    assert.equal(w.opts.transparent, true);
    assert.equal(w.opts.frame, false);
    assert.equal(w.opts.alwaysOnTop, true);
    assert.equal(w.opts.webPreferences.spellcheck, false);
    assert.equal(w.ignore, true);
    w.webContents.emit('did-finish-load');
    assert.equal(w.shown, 'inactive');
  }
  const [, plan1] = made[0].sent[0];
  assert.deepEqual(plan1.from, { x: 100, y: 100 });
  assert.equal(plan1.reduced, false);
  const [, plan2] = made[1].sent[0];
  assert.equal(plan2.from, null, 'the widget is not on the second display');
  assert.deepEqual(plan2.points, [{ x: 60, y: 20, label: 'b' }], 'local to its display');
  assert.ok(plan1.ms < PointerOverlay.MAX_MS);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms <= 6000);
  timers[0].fn();
  assert.ok(made.every((w) => w.destroyed));
  assert.equal(o.open, 0);
});

test('reduced motion: the plan says appear, no flight; no points means no window', () => {
  const { o, made } = overlayRig({ reduced: true });
  assert.equal(o.show({ from: null, points: [] }), 0);
  assert.equal(made.length, 0);
  o.show({ from: { x: 1, y: 1 }, points: [{ x: 5, y: 5, label: 'x' }] });
  made[0].webContents.emit('did-finish-load');
  assert.equal(made[0].sent[0][1].reduced, true);
  o.show({ from: { x: 1, y: 1 }, points: [{ x: 6, y: 6, label: 'y' }] });
  assert.equal(made[0].destroyed, true, 'a new answer replaces the old overlay');
  o.close();
  assert.ok(made.every((w) => w.destroyed));
});

test('the overlay page never listens for clicks and honours the reduced plan', () => {
  const page = fs.readFileSync(path.join(ROOT, 'pointer-overlay.js'), 'utf8');
  assert.doesNotMatch(page, /addEventListener\(['"](click|mousedown|pointerdown)/);
  assert.match(page, /plan\.reduced/);
  const html = fs.readFileSync(path.join(ROOT, 'pointer-overlay.html'), 'utf8');
  assert.match(html, /pointer-events: none/);
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.files;
  for (const f of ['pointer-overlay.html', 'pointer-overlay.js', 'pointer-overlay-preload.js']) assert.ok(files.includes(f), f);
});

// ── Agent mode ───────────────────────────────────────────────────────────
test('"Plexiform, build …" is an agent intent; questions and wake-less commands are not', () => {
  assert.deepEqual(V.parseIntent('Plexiform, build a settings page.'), { intent: 'agent', task: 'Build a settings page', text: 'plexiform build a settings page' });
  assert.equal(V.parseIntent('hey plexiform please fix the login bug').task, 'Fix the login bug');
  assert.equal(V.parseIntent('Plexiform research overlays').task, 'Research overlays');
  assert.equal(V.parseIntent('Plexiform, what is blocked?').intent, 'blocked');
  assert.equal(V.parseIntent('build a thing').intent, 'unknown');
  assert.equal(V.parseIntent('Plexiform, do').intent, 'unknown');
  assert.match(V.answer(V.parseIntent('Plexiform fix the tests'), {}), /^Start a task: Fix the tests\? Press Start/);
});

test('an offered task never starts without Start on the current offer, and only once', () => {
  let t = 0;
  let id = 0;
  const o = VoiceOffer.create({ now: () => t, newId: () => `id${id += 1}` });
  const a = o.offer('Fix the tests');
  assert.equal(o.take(a.id, 'cancel'), null);
  assert.equal(o.take(a.id, 'start'), null, 'cancelled is gone');
  const b = o.offer('Build it');
  const c = o.offer('Build it better');
  assert.equal(o.take(b.id, 'start'), null, 'a stale offer');
  assert.equal(o.take(c.id, 'start'), 'Build it better');
  assert.equal(o.take(c.id, 'start'), null, 'once');
  const d = o.offer('Late');
  t += VoiceOffer.TTL_MS + 1;
  assert.equal(o.take(d.id, 'start'), null, 'expired');
  assert.equal(o.take(undefined, 'start'), null);
  assert.equal(o.offer('   '), null);
});

test('main wires agent mode through a widget-only confirm and the Tasks composer, never tasks:create', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('voice-offer'"), main.indexOf("ipcMain.handle('tasks:voice-draft'"));
  assert.match(h, /if \(!widgetOnly\(e\)\) return \{ ok: false \}/);
  assert.match(h, /voiceOffers\.take/);
  assert.doesNotMatch(h, /\.create\(|tasks:create/);
  assert.match(main, /ipcMain\.handle\('tasks:voice-draft', \(e\) => \{\n  if \(!tasksSenderOk\(e\)\) return null;/);
  const reply = main.slice(main.indexOf('async function voiceReply'), main.indexOf('function startListening'));
  assert.match(reply, /intent\.intent === 'agent'[\s\S]*voiceOffers\.offer/);
  const widget = fs.readFileSync(path.join(ROOT, 'widget.js'), 'utf8');
  assert.match(widget, /voiceOffer\(offer, action\)/);
});

test('voice config: screen off by default, pointing on, and the preset is a known hold key', () => {
  assert.deepEqual(V.normalizeConfig({}), { hotkey: null, longPress: true, askClaude: false, screen: false, point: true });
  assert.equal(V.normalizeConfig({ screen: 'yes' }).screen, false);
  assert.equal(V.normalizeConfig({ screen: true, point: false }).point, false);
  assert.equal(V.hotkey(V.PRESET_HOTKEY).keyCode, 49);
});
