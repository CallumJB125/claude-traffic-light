'use strict';

// C1/C2 in the page: the optimiser's empty state draws the guided setup with one primary
// button per step, starts a step only after main's consent-guarded action succeeded,
// polls burst:setup-progress only while a step is running, and shows the timeout + Retry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Setup = require('../src/burst-setup.js');
const { createOptimiser } = require('../buddy-window/optimiser.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 20));
const T0 = 1_700_000_000_000;

function page({ act = async () => ({ ok: true }), progress } = {}) {
  const dom = new JSDOM(read('optimiser.html'), { runScripts: 'outside-only', url: 'file:///synthetic/optimiser.html' });
  const w = dom.window;
  const calls = { act: [], progress: [], intervals: [] };
  w.setInterval = (fn, ms) => { const id = calls.intervals.length + 1; calls.intervals.push({ id, fn, ms, live: true }); return id; };
  w.clearInterval = (id) => { const i = calls.intervals.find((x) => x.id === id); if (i) i.live = false; };
  let push;
  w.optimiserApi = {
    onState: (cb) => { push = cb; }, ready: () => {}, refresh: () => {}, openBrowser: async () => {}, openDocs: () => {},
    act: async (k) => { calls.act.push(k); return act(k); },
    setupProgress: async (req) => { calls.progress.push(JSON.parse(JSON.stringify(req))); return progress(req); }, // plain Node objects: JSDOM's realm would fail deepEqual
  };
  w.eval(read('optimiser.js'));
  return { dom, d: w.document, push: (s) => push(s), calls, live: () => calls.intervals.filter((i) => i.live && i.ms === 5000) }; // the 15 s tools poll is not ours
}
const notInstalled = (state = Setup.initial(), now = T0) => Setup.next(state, { detect: { kind: 'not_installed' } }, { now });
const empty = (steps) => ({ mode: 'empty', reason: 'not_installed', headline: 'Not installed', detail: 'x', chip: null, actions: [{ kind: 'install', label: 'Turn on Burst…', primary: true }], docs: true, canBrowser: false, setup: steps });

test('empty state: four steps, one primary button, what-it-changes from the README, no poll while idle; the legacy row drops actions a step owns', () => {
  const p = page({ progress: async () => ({ ok: true, steps: [] }) });
  p.push(empty(notInstalled().steps));
  const d = p.d;
  assert.equal(d.getElementById('setup').hidden, false);
  const items = [...d.querySelectorAll('.step')];
  assert.deepEqual(items.map((li) => li.dataset.step), ['install', 'trust', 'enable', 'check']);
  assert.deepEqual(items.map((li) => li.dataset.status), ['todo', 'skipped', 'todo', 'todo']);
  assert.deepEqual(items.map((li) => li.querySelectorAll('button').length), [1, 0, 0, 0], 'exactly one button, on the step that is next');
  assert.equal(items[0].querySelector('button').textContent, 'Install Burst');
  assert.equal(items[0].querySelector('button').className, 'primary');
  assert.match(items[0].querySelector('details').textContent, /LaunchAgent that runs the gateway/);
  assert.match(items[1].querySelector('h4').textContent, /not needed/);
  assert.equal(d.querySelectorAll('#actions button').length, 0, 'install is the step\'s button now, not a second one below');
  assert.equal(p.live().length, 0, 'nothing is running, so nothing polls');
  // A view model without setup (older main, or a non-Burst empty state) keeps the legacy row untouched.
  p.push({ ...empty(null), setup: null });
  assert.equal(d.getElementById('setup').hidden, true);
  assert.equal(d.querySelectorAll('#actions button').length, 1);
  assert.equal(d.querySelector('#actions button').className, 'primary');
  p.dom.window.close();
});

test('Install: consent-guarded act first; only on ok does the page mark the step started, then polls at 5 s until the probe says done', async () => {
  let state = notInstalled();
  let detect = { kind: 'not_installed' };
  let now = T0;
  const progress = async (req) => {
    if (req.start) state = Setup.start(state, req.step, now);
    if (req.retry) state = Setup.reset(state, req.step);
    state = Setup.next(state, { detect }, { now });
    return { ok: true, steps: state.steps, running: Setup.running(state) };
  };
  const p = page({ progress });
  p.push(empty(state.steps));
  p.d.querySelector('.step[data-step="install"] button').click();
  await settle();
  assert.deepEqual(p.calls.act, ['install']);
  assert.deepEqual(p.calls.progress, [{ step: 'install', start: true }]);
  assert.equal(p.d.getElementById('note').textContent, 'Started in Terminal. This page updates when Burst answers.');
  assert.equal(p.d.querySelector('.step[data-step="install"]').dataset.status, 'running');
  assert.equal(p.d.querySelectorAll('.step button').length, 0, 'no button while a step runs');
  assert.equal(p.live().length, 1); assert.equal(p.live()[0].ms, 5000);
  // Two ticks later the installer finished: done, the next step offers Turn on, the poll stops.
  now += 10000;
  detect = { kind: 'present', state: { version: '0.20.36', mode: 'base-url', active: false, caTrusted: true, hostsEntry: true } };
  await p.live()[0].fn(); await settle();
  assert.deepEqual(p.calls.progress.at(-1), {});
  assert.deepEqual([...p.d.querySelectorAll('.step')].map((li) => li.dataset.status), ['done', 'skipped', 'todo', 'todo']);
  assert.equal(p.d.querySelector('.step[data-step="enable"] button').textContent, 'Turn on');
  assert.equal(p.live().length, 0, 'done: the poll is cleared');
  p.dom.window.close();
});

test('Cancel at the consent dialog starts nothing; a failed act shows main\'s reason', async () => {
  const p = page({ act: async () => ({ ok: false, cancelled: true }), progress: async () => { throw new Error('must not be asked'); } });
  p.push(empty(notInstalled().steps));
  p.d.querySelector('.step[data-step="install"] button').click();
  await settle();
  assert.deepEqual(p.calls.progress, []);
  assert.equal(p.d.getElementById('note').textContent, 'Cancelled. Nothing changed.');
  assert.equal(p.d.querySelector('.step[data-step="install"]').dataset.status, 'todo');
  const q = page({ act: async () => ({ ok: false, reason: 'Could not start Terminal.' }), progress: async () => { throw new Error('must not be asked'); } });
  q.push(empty(notInstalled().steps));
  q.d.querySelector('.step[data-step="install"] button').click();
  await settle();
  assert.equal(q.d.getElementById('note').textContent, 'Could not start Terminal.');
  p.dom.window.close(); q.dom.window.close();
});

test('120 s without confirmation: the step fails with the timeout text and a Try again that resets it to its real action', async () => {
  let state = Setup.start(notInstalled(), 'install', T0);
  let now = T0 + 1000;
  const progress = async (req) => {
    if (req.retry) state = Setup.reset(state, req.step);
    state = Setup.next(state, { detect: { kind: 'not_installed' } }, { now });
    return { ok: true, steps: state.steps };
  };
  const p = page({ progress });
  p.push(empty(Setup.next(state, { detect: { kind: 'not_installed' } }, { now }).steps));
  assert.equal(p.d.querySelector('.step[data-step="install"]').dataset.status, 'running');
  assert.equal(p.live().length, 1);
  now = T0 + Setup.TIMEOUT_MS + 1;
  await p.live()[0].fn(); await settle();
  const li = p.d.querySelector('.step[data-step="install"]');
  assert.equal(li.dataset.status, 'failed');
  assert.match(li.querySelector('p').textContent, /^Nothing changed after 120 s\./);
  assert.equal(li.querySelector('button').textContent, 'Try again');
  assert.equal(p.live().length, 0);
  li.querySelector('button').click();
  await settle();
  assert.deepEqual(p.calls.act, [], 'retry never runs Terminal by itself');
  assert.deepEqual(p.calls.progress.at(-1), { step: 'install', retry: true });
  assert.equal(p.d.querySelector('.step[data-step="install"]').dataset.status, 'todo');
  assert.equal(p.d.querySelector('.step[data-step="install"] button').textContent, 'Install Burst');
  p.dom.window.close();
});

test('the check step\'s Run check starts the step without Terminal; a non-ok progress answer shows its reason; leaving the empty state clears the list', async () => {
  const detect = { kind: 'present', state: { version: '0.20.36', mode: 'base-url', active: true, caTrusted: true, hostsEntry: true } };
  const st = Setup.next(Setup.initial(), { detect }, { now: T0 });
  const p = page({ progress: async () => ({ ok: false, reason: 'Burst did not answer in time.' }) });
  p.push(empty(st.steps));
  assert.equal(p.d.querySelector('.step[data-step="check"] button').textContent, 'Run check');
  p.d.querySelector('.step[data-step="check"] button').click();
  await settle();
  assert.deepEqual(p.calls.act, []);
  assert.deepEqual(p.calls.progress, [{ step: 'check', start: true }]);
  assert.equal(p.d.getElementById('note').textContent, 'Burst did not answer in time.');
  p.push({ mode: 'ready', headline: 'Usage optimiser', detail: '', chip: null, actions: [], docs: false, canBrowser: true, setup: null });
  assert.equal(p.d.getElementById('setup').hidden, true);
  assert.equal(p.d.querySelectorAll('.step').length, 0);
  p.dom.window.close();
});

test('controller payload: setup steps ride along with every empty state Burst can fix, never with ready, loading or unsupported', () => {
  const steps = notInstalled().steps;
  const mk = (d, b) => createOptimiser({ newView: () => { throw new Error('no view'); }, harden: () => {}, dispose: () => {}, openExternal: () => {}, burst: () => b, win: () => null, isContent: () => false, isSelected: () => false, bounds: () => ({ x: 0, width: 1, height: 1 }), sendState: () => {}, navChanged: () => {}, platform: 'darwin', setTimer: () => 1, clearTimer: () => {} });
  const b = (d) => ({ snapshot: () => ({ d, url: null }), refresh: async () => {}, act: async () => ({ ok: true }), setupView: () => steps });
  assert.equal(mk(null, null).payload().setup, null, 'loading');
  const o = mk(null, b({ kind: 'not_installed' }));
  return o.refresh().then(() => {
    assert.deepEqual(o.payload().setup, steps);
    const old = mk(null, { snapshot: () => ({ d: { kind: 'not_installed' }, url: null }), refresh: async () => {}, act: async () => ({ ok: true }) });
    return old.refresh().then(() => {
      assert.equal(old.payload().setup, null, 'a burst api without setupView (older main) is tolerated');
      const bad = mk(null, { ...b({ kind: 'not_installed' }), setupView: () => { throw new Error('x'); } });
      return bad.refresh().then(() => {
        assert.equal(bad.payload().setup, null, 'a throwing setupView never breaks the page');
        const un = mk(null, b({ kind: 'unsupported' }));
        return un.refresh().then(() => assert.equal(un.payload().setup, null, 'unsupported has no Burst to set up'));
      });
    });
  });
});
