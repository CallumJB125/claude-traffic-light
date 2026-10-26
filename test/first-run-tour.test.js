const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/first-run-tour.js');
const Main = require('../src/first-run-tour-main.js');
const C = require('../tour-coachmark.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('model: five steps in order, each with a target, a short body and a primary action', () => {
  assert.deepEqual(T.STEPS.map((s) => s.id), ['widget', 'waiting', 'spend', 'rules', 'sound']);
  for (const s of T.STEPS) {
    assert.ok(s.target.window && s.target.selector && s.title && s.primary, s.id);
    assert.ok((s.body.match(/[.!?](\s|$)/g) || []).length <= 2, `${s.id}: at most two sentences`);
  }
  assert.equal(T.STEPS[2].target.page, 'usage');
  assert.equal(T.STEPS[3].target.window, 'lights');
  assert.equal(T.STEPS.at(-1).title, 'Try a sound when Claude finishes', 'the tour ends on a sound, not Team');
  assert.ok(!T.STEPS.some((s) => /team/i.test(`${s.title} ${s.body} ${s.primary}`)), 'no step sells Team');
  assert.match(T.STEPS[3].body, /when Claude is working, turn the lamp green/, 'the rules step gives a real example');
  assert.equal(T.view(T.start(1)).skip, 'Skip tour');
});

test('model: advance, skip, finish, never repeats, restart', () => {
  assert.equal(T.parse(undefined).status, 'not-started');
  assert.equal(T.parse({ status: 'bogus' }).status, 'not-started');
  assert.equal(T.parse({ status: 'running', step: 99 }).step, 0);
  assert.equal(T.shouldAutoStart(undefined), true);
  let s = T.start(10);
  assert.deepEqual(s, { status: 'running', step: 0, at: 10 });
  s = T.advance(s, { now: 11 });
  assert.equal(s.step, 1);
  assert.equal(T.advance(s, { from: 0 }), s, 'a stale Next does nothing');
  for (let i = 0; i < 3; i++) s = T.advance(s);
  assert.equal(s.step, 4);
  s = T.advance(s);
  assert.equal(s.status, 'finished');
  assert.equal(T.shouldAutoStart(s), false);
  assert.equal(T.advance(s), s);
  const skipped = T.skip(T.advance(T.start()));
  assert.deepEqual([skipped.status, skipped.step], ['skipped', 1]);
  assert.equal(T.shouldAutoStart(T.parse(JSON.parse(JSON.stringify(skipped)))), false);
  assert.equal(T.view(skipped), null);
  assert.deepEqual([T.restart(5).status, T.restart(5).step], ['running', 0]);
  assert.equal(T.finish(T.start()).status, 'finished');
});

test('model: steps whose target is absent are skipped; all absent finishes', () => {
  const missing = (i) => i === 1 || i === 2;
  assert.equal(T.advance(T.start(), { missing }).step, 3);
  assert.equal(T.settle(T.start(), { missing: (i) => i === 0 }).step, 1);
  assert.equal(T.settle(T.start(), { missing: () => true }).status, 'finished');
  const s = T.start();
  assert.equal(T.settle(s, { missing: () => false }), s);
});

function fakeClock() {
  let t = 0, id = 0; const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
    clearTimeout: (i) => timers.delete(i),
    tick(ms) { const end = t + ms; for (;;) { const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); t = due[1].at; due[1].fn(); } t = end; },
    now: () => t,
  };
}

test('trigger: starts a few seconds after setup closes, always within 30 s, and can be cancelled', () => {
  let c = fakeClock(), began = null;
  T.scheduleStart({ ...c, begin: () => { began = c.now(); } });
  c.tick(60_000);
  assert.ok(began !== null && began <= 30_000, `began at ${began}`);
  assert.equal(began, T.DELAY_MS);
  c = fakeClock(); began = null;
  T.scheduleStart({ ...c, ready: () => false, begin: () => { began = c.now(); } });
  c.tick(60_000);
  assert.ok(began !== null && began <= T.DEADLINE_MS, `not ready yet still begins by the deadline: ${began}`);
  c = fakeClock(); began = null;
  const cancel = T.scheduleStart({ ...c, begin: () => { began = c.now(); } });
  cancel(); c.tick(60_000);
  assert.equal(began, null);
});

test('placement: beside the target, never over it, inside the viewport', () => {
  const view = { width: 800, height: 600 }, box = { width: 300, height: 140 };
  const cases = [
    { left: 100, top: 40, width: 200, height: 60 },
    { left: 300, top: 500, width: 200, height: 60 },
    { left: 10, top: 100, width: 120, height: 400 },
    { left: 640, top: 50, width: 150, height: 520 },
  ];
  const sides = [];
  for (const t of cases) {
    const p = C.place(t, box, view);
    sides.push(p.side);
    const r = { left: p.left, top: p.top, ...box };
    assert.equal(C.overlaps(r, t), false, JSON.stringify(t));
    assert.ok(r.left >= C.MARGIN && r.top >= C.MARGIN && r.left + r.width <= view.width - C.MARGIN + 0.5 && r.top + r.height <= view.height - C.MARGIN + 0.5, JSON.stringify(p));
  }
  assert.deepEqual(sides, ['below', 'above', 'right', 'left']);
  assert.equal(C.place(null, box, view).side, 'centre');
  const huge = C.place({ left: 0, top: 0, width: 800, height: 600 }, box, view);
  assert.deepEqual([huge.side, huge.covers], ['centre', true]);
});

test('coachmark: text stays text, Enter advances, Esc skips, Tab stays inside, absent target is reported', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><button id="before">x</button><div id="t">target</div></body>', { pretendToBeVisual: true });
  const { window } = dom; const doc = window.document;
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 10, top: 10, width: 50, height: 20, right: 60, bottom: 30 }; };
  const acts = [];
  const cm = C.create(doc, { onAction: (k, id) => acts.push([k, id]), waitMs: 150 });
  cm.show({ id: 'widget', index: 1, total: 5, title: '<img src=x onerror=alert(1)>', body: 'b', primary: 'Next', skip: 'Skip tour', selector: '#t' });
  const card = doc.querySelector('.tour-card');
  assert.ok(card && doc.querySelector('.tour-ring'));
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('.tour-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(doc.activeElement.className, 'tour-next');
  const key = (k, o = {}) => doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  key('Tab'); assert.equal(doc.activeElement.className, 'tour-skip');
  key('Tab'); assert.equal(doc.activeElement.className, 'tour-next');
  key('Tab', { shiftKey: true }); assert.equal(doc.activeElement.className, 'tour-skip');
  key('Enter'); assert.deepEqual(acts, [], 'Enter on Skip is the button, not Next');
  doc.querySelector('.tour-next').focus(); key('Enter');
  key('Escape');
  assert.deepEqual(acts, [['next', 'widget'], ['skip', 'widget']]);
  cm.show(null);
  assert.equal(doc.querySelector('.tour-card'), null);
  cm.show({ id: 'team', index: 5, total: 5, title: 't', body: 'b', primary: 'Open Team', selector: '#nope' });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(acts.at(-1), ['missing', 'team']);
  cm.show({ id: 'waiting', highlight: '#t' });
  assert.ok(doc.querySelector('.tour-ring') && !doc.querySelector('.tour-card'), 'the widget only gets the ring');
  window.close();
});

function harness({ connected = false, widgetShown = true } = {}) {
  const c = fakeClock();
  const handlers = {}, sent = [], opened = [];
  let cfg = {};
  let demoOn = false;
  const wc = (name) => ({ isDestroyed: () => false, isLoading: () => false, send: (ch, p) => sent.push([name, ch, p]) });
  const bw = (name) => ({ isDestroyed: () => false, webContents: wc(name) });
  const widget = bw('widget'), lights = bw('lights');
  const api = Main.install({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    config: () => cfg, saveConfig: (p) => { cfg = { ...cfg, ...p }; return cfg; },
    demo: { active: () => demoOn, start: () => { demoOn = true; } },
    hasConnectedTool: () => connected,
    windows: { widget: () => widget, widgetShown: () => widgetShown, lights: () => lights, openLights: () => opened.push('lights'), openPage: (id) => opened.push(id), sendToPage: (id, ch, p) => { sent.push([id, ch, p]); return true; } },
    allowed: { widget: (e) => e === 'widget', lights: (e) => e === 'lights', page: (e, id) => e === id },
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
  });
  const last = (name) => [...sent].reverse().find(([n]) => n === name)?.[2];
  return { c, handlers, sent, opened, api, last, cfg: () => cfg, demo: () => demoOn, invoke: (ch, e, ...a) => handlers[ch](e, ...a) };
}

test('main: setup closing starts the tour on the demo within 30 s; steps go to the right windows', () => {
  const h = harness();
  assert.equal(h.api.onboardingClosed(), true);
  assert.equal(h.cfg().tourState, undefined);
  h.c.tick(30_000);
  assert.equal(h.cfg().tourState.status, 'running');
  assert.equal(h.demo(), true, 'no AI tool connected: the demo fixtures');
  assert.equal(h.last('home').id, 'widget');
  assert.equal(h.last('home').pointsTo, 'widget');
  assert.equal(h.last('widget').highlight, '#housing');
  assert.deepEqual(h.invoke('tour:action', 'home', 'next', 'widget').step, 1);
  assert.equal(h.last('widget').demoInput.id, Main.DEMO_INPUT.id);
  assert.equal(h.invoke('tour:action', 'widget', 'answered', 'waiting').step, 2);
  assert.equal(h.last('widget').demoInput, null, 'the demo question leaves the widget');
  assert.equal(h.last('usage').selector, '#mix');
  assert.equal(h.last('widget').highlight, '#rings');
  h.invoke('tour:action', 'usage', 'next', 'spend');
  assert.ok(h.opened.includes('lights'));
  assert.equal(h.last('lights').selector, '#rule-list');
  h.invoke('tour:action', 'lights', 'next', 'rules');
  assert.equal(h.last('lights').id, 'sound');
  assert.equal(h.last('lights').selector, '#rule-template, #wish-chime-done');
  const r = h.invoke('tour:action', 'lights', 'next', 'sound');
  assert.equal(r.status, 'finished');
  assert.ok(!h.opened.includes('team'), 'finishing never opens Team');
  assert.equal(h.last('lights'), null);
  assert.equal(h.api.onboardingClosed(), false, 'never repeats on its own');
});

test('main: skip any time, stale or foreign actions ignored, restart only from Help, live data when connected', () => {
  const h = harness({ connected: true });
  h.api.onboardingClosed(); h.c.tick(10_000);
  assert.equal(h.demo(), false);
  assert.equal(h.invoke('tour:action', 'stranger', 'next', 'widget'), null);
  assert.equal(h.invoke('tour:action', 'home', 'explode', 'widget'), null);
  assert.deepEqual(h.invoke('tour:action', 'home', 'next', 'rules'), { ok: false });
  assert.equal(h.invoke('tour:action', 'home', 'next', 'widget').step, 1);
  assert.equal(h.last('widget').demoInput, null, 'live data: no made-up question');
  assert.equal(h.invoke('tour:action', 'home', 'skip', 'waiting').status, 'skipped');
  assert.equal(h.api.onboardingClosed(), false);
  assert.equal(h.invoke('tour:restart', 'home'), null);
  assert.deepEqual(h.invoke('tour:restart', 'help'), { ok: true });
  assert.deepEqual([h.cfg().tourState.status, h.cfg().tourState.step], ['running', 0]);
});

test('main: a hidden widget skips the widget steps; a missing page target is passed over', () => {
  const h = harness({ widgetShown: false });
  h.api.onboardingClosed(); h.c.tick(30_000);
  assert.equal(h.cfg().tourState.step, 2, 'widget and waiting steps skipped');
  assert.equal(h.last('usage').id, 'spend');
  assert.equal(h.invoke('tour:action', 'usage', 'missing', 'spend').step, 3);
  assert.equal(h.last('lights').id, 'rules');
});

test('wiring: one install line in main, preloads, pages, Help and CONTRACT rows', () => {
  const main = read('main.js');
  assert.equal((main.match(/require\('\.\/src\/first-run-tour-main\.js'\)\.install\(/g) || []).length, 1);
  assert.match(main, /FirstRunTour\.onboardingClosed\(\)/);
  for (const f of ['preload.js', 'home-preload.js', 'lights-preload.js']) assert.match(read(f), /exposeInMainWorld\('tourApi'/, f);
  assert.match(read('help-preload.js'), /tourRestart: \(\) => ipcRenderer\.invoke\('tour:restart'\)/);
  for (const f of ['index.html', 'home.html', 'lights.html']) {
    const html = read(f);
    assert.ok(html.includes('tour-coachmark.js') && html.includes('tour-host.js') && html.includes('tour-coachmark.css'), f);
  }
  assert.match(read('help.html'), /Take the tour again/);
  const contract = read('board/CONTRACT.md');
  for (const ch of ['tour:step', 'tour:action', 'tour:restart']) assert.ok(contract.includes(`| \`${ch}\``), ch);
  for (const f of ['tour-coachmark.js', 'tour-host.js', 'src/first-run-tour.js', 'src/first-run-tour-main.js']) assert.doesNotMatch(read(f), /innerHTML|insertAdjacentHTML|outerHTML/, f);
});

test('C-T: the demo question\'s id is refused by the answer paths and never names a request file', () => {
  const Main = require('../src/first-run-tour-main.js');
  assert.equal(Main.isDemoId(Main.DEMO_INPUT.id), true);
  assert.equal(Main.isDemoId('h-real-1'), false);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  const handler = (name) => src.slice(src.indexOf(`ipcMain.handle('${name}'`)).split('\nipcMain.handle(', 2)[0];
  for (const name of ['answer-input', 'home:answer-input']) {
    const body = handler(name);
    assert.ok(body.indexOf('TourMain.isDemoId') > 0 && body.indexOf('TourMain.isDemoId') < body.indexOf('readRequests()'), `${name} refuses the demo id before any request is read`);
    assert.ok(body.indexOf('TourMain.isDemoId') < body.indexOf('writeAnswer'), `${name}: before writeAnswer`);
  }
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'widget.js'), 'utf8'), /tourInput && id === tourInput\.id \? tourAnswered\(\)/, 'the widget answers the demo itself');
});
