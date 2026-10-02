'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const create = source.slice(source.indexOf('function createWindow() {'), source.indexOf('\nlet settingsWin =', source.indexOf('function createWindow() {')));
const guard = source.slice(source.indexOf('function guardRenderer(w, name, recreate) {'), source.indexOf('\n// Quitting must', source.indexOf('function guardRenderer(w, name, recreate) {')));
function fixture() {
  const windows = [], deferred = [], reveals = [], changes = [];
  let config = { showWidget: true }, broadcasts = 0, saves = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.dead = false; this.visible = false; this.webContents = new EventEmitter(); this.webContents.send = (...args) => changes.push(['send', this, ...args]); this.webContents.reloadIgnoringCache = () => { throw Error('unavailable renderer'); }; windows.push(this); }
    isDestroyed() { return this.dead; }
    isVisible() { if (this.dead) throw Error('disposed window'); return this.visible; }
    isMinimized() { if (this.dead) throw Error('disposed window'); return false; }
    showInactive() { this.visible = true; changes.push(['show', this]); }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setAspectRatio() {} loadFile() {}
    destroy() { if (this.destroyFailure) throw Error('disposal refused'); this.dead = true; if (this.goneOnDestroy) this.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); this.emit('closed'); }
  }
  const c = { BrowserWindow: Window, readBounds: () => null, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1000, height: 800 } }) }, WIDGET_ASPECT: 64 / 82, MIN_WIDTH: 32, MAX_WIDTH: 300, path, __dirname: '/synthetic', loadConfig: () => config, setTimeout: f => reveals.push(f), queueMicrotask: f => deferred.push(f), saveBounds: () => { saves++; }, glideTimer: null, setMotionPaused: (...args) => changes.push(['pause', ...args]), widgetMotion: { paused: false }, stateMemo: {}, broadcastStatus: () => { broadcasts++; }, console: { log() {} }, win: null };
  vm.createContext(c); vm.runInContext(create + '\n' + guard, c);
  return { c, windows, changes, reveals, make() { c.createWindow(); return c.win; }, flush() { while (deferred.length) deferred.shift()(); }, live: () => windows.filter(w => !w.dead).length, counts: () => ({ broadcasts, saves }), config(value) { config = value; } };
}
const gone = w => w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
test('repeated entry keeps one live current widget', () => { const f = fixture(); const w = f.make(); assert.equal(f.make(), w); assert.equal(f.windows.length, 1); });
test('current failed reload disposes old window before deferred replacement', () => { const f = fixture(); const old = f.make(); gone(old); assert.equal(f.live(), 0); f.flush(); assert.equal(f.live(), 1); assert.notEqual(f.c.win, old); });
test('obsolete destroyed renderer cannot orphan replacement', () => { const f = fixture(); const old = f.make(); old.destroy(); const next = f.make(); gone(old); f.flush(); assert.equal(f.c.win, next); assert.equal(f.live(), 1); });
test('obsolete closed callback cannot clear current widget', () => { const f = fixture(); const old = f.make(); old.destroy(); const next = f.make(); old.emit('closed'); assert.equal(f.c.win, next); assert.equal(f.live(), 1); });
test('synchronous destroy renderer event and broadcast recovery converge once', () => { const f = fixture(); const old = f.make(); old.goneOnDestroy = true; old.destroy(); f.c.win = null; const next = f.make(); f.flush(); assert.equal(f.c.win, next); assert.equal(f.live(), 1); assert.equal(f.windows.length, 2); });
test('disposal failure retains owner and refuses a second live window', () => { const f = fixture(); const old = f.make(); old.destroyFailure = true; gone(old); f.flush(); assert.equal(f.c.win, old); assert.equal(f.live(), 1); assert.equal(f.windows.length, 1); });
test('obsolete reveal and load cannot show or send to a replacement', () => { const f = fixture(); const old = f.make(); old.destroy(); const next = f.make(); f.changes.length = 0; f.reveals[0](); old.webContents.emit('did-finish-load'); assert.deepEqual(f.changes, []); assert.equal(next.visible, false); assert.equal(f.counts().broadcasts, 0); });
test('obsolete visibility, position and restore events do not affect current window', () => { const f = fixture(); const old = f.make(); old.destroy(); f.make(); f.changes.length = 0; for (const e of ['show', 'hide', 'restore', 'minimize', 'resize', 'move']) old.emit(e); assert.deepEqual(f.changes, []); assert.equal(f.counts().saves, 0); });
test('current finished load reveals once, broadcasts and synchronizes motion', () => { const f = fixture(); const w = f.make(); w.webContents.emit('did-finish-load'); f.reveals[0](); assert.equal(w.visible, true); assert.equal(f.changes.filter(a => a[0] === 'show').length, 1); assert.equal(f.counts().broadcasts, 1); assert.ok(f.changes.some(a => a[0] === 'send' && a[1] === w && a[2] === 'motion-paused')); });
test('hidden widget config still prevents reveal and current close releases owner', () => { const f = fixture(); f.config({ showWidget: false }); const w = f.make(); w.webContents.emit('did-finish-load'); f.reveals[0](); assert.equal(w.visible, false); w.destroy(); assert.equal(f.c.win, null); assert.equal(f.live(), 0); });
