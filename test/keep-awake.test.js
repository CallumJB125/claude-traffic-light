'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Actions = require('../src/burst-actions.js');
const KeepAwake = require('../src/keep-awake.js');
const Ipc = require('../src/keep-awake-ipc.js');
const { createFakeBurst } = require('./fixtures/fake-burst.js');

const fakeBlocker = () => {
  const live = new Set();
  let n = 0;
  return { live, starts: [], start(t) { this.starts.push(t); live.add(++n); return n; }, stop(i) { live.delete(i); }, isStarted: (i) => live.has(i) };
};
const working = [{ signal: 'tool-use' }];
const idle = [{ signal: 'stop' }, { signal: 'permission-ask' }];

test('setKeepAwake posts exactly {mode, idle_minutes} with the admin header to loopback', async () => {
  const fake = await createFakeBurst({ '/api/keep-awake': () => ({ body: { detail: 'applied' } }) });
  const r = await Actions.setKeepAwake({ url: `http://127.0.0.1:${fake.port}/`, mode: 'ac', idleMinutes: 120 });
  assert.deepEqual(r, { ok: true, detail: 'applied', needsPassword: false });
  const [req] = fake.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-claude-burst-admin'], '1');
  assert.deepEqual(JSON.parse(req.body), { mode: 'ac', idle_minutes: 120 });
  await fake.close();
});

test('setKeepAwake flags a password terminal, surfaces 400 text, and refuses bad input', async () => {
  const fake = await createFakeBurst({ '/api/keep-awake': (req, body) => (JSON.parse(body).mode === 'always' ? { status: 400, type: 'text/plain', body: 'no repo' } : { body: { script: '/tmp/x.command', detail: 'Saved.' } }) });
  const url = `http://127.0.0.1:${fake.port}/`;
  assert.equal((await Actions.setKeepAwake({ url, mode: 'off' })).needsPassword, true);
  await assert.rejects(Actions.setKeepAwake({ url, mode: 'always' }), (e) => e.code === 'http' && e.detail === 'no repo');
  const before = fake.requests.length;
  await assert.rejects(Actions.setKeepAwake({ url, mode: 'rm -rf' }), { code: 'bad_request' });
  await assert.rejects(Actions.setKeepAwake({ url, mode: 'ac', idleMinutes: 99999 }), { code: 'bad_request' });
  await assert.rejects(Actions.setKeepAwake({ url: 'http://example.com:80/', mode: 'ac' }), { code: 'no_address' });
  await assert.rejects(Actions.setKeepAwake({ url: null, mode: 'ac' }), { code: 'no_address' });
  assert.equal(fake.requests.length, before);
  await fake.close();
});

test('the blocker is held only while an AI session is working, and only prevents app suspension', () => {
  const b = fakeBlocker();
  const k = KeepAwake.createKeepAwake({ powerSaveBlocker: b });
  assert.equal(k.sync(working), false, 'not wanted: nothing held');
  k.setWanted(true);
  assert.equal(k.sync(idle), false);
  assert.equal(k.sync(working), true);
  assert.equal(k.sync(working), true);
  assert.deepEqual(b.starts, ['prevent-app-suspension']);
  assert.equal(k.sync(idle), false);
  assert.equal(b.live.size, 0);
  k.sync(working);
  k.setWanted(false);
  assert.equal(b.live.size, 0);
  assert.equal(KeepAwake.createKeepAwake({}).sync(working), false);
});

function harness({ isMac, present, pref = 'off', response = 1, burstFails = false }) {
  const handlers = {};
  const calls = [];
  let saved = pref;
  const blocker = fakeBlocker();
  const keepAwake = KeepAwake.createKeepAwake({ powerSaveBlocker: blocker });
  const posted = [];
  const ipc = Ipc.register({
    utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); },
    allowed: (e) => e.ok === true, isMac,
    burst: { snapshot: () => ({ d: { kind: present ? 'present' : 'not_installed' }, url: present ? present.url : null }) },
    keepAwake, dialog: { showMessageBox: async (o) => { calls.push(o); return { response }; } },
    getPref: () => saved, setPref: (v) => { saved = v; },
  });
  return { handlers, calls, blocker, ipc, keepAwake, get saved() { return saved; }, posted };
}

test('Burst present: consent explains the machine-wide setting, then POSTs; cancel changes nothing', async () => {
  const fake = await createFakeBurst({ '/api/keep-awake': () => ({ body: { detail: 'ok' } }) });
  const url = `http://127.0.0.1:${fake.port}/`;
  const h = harness({ isMac: true, present: { url }, response: 0 });
  assert.equal(await h.handlers['keepawake:set']({ ok: false }, { enabled: true }), null);
  assert.deepEqual(await h.handlers['keepawake:set']({ ok: true }, { enabled: true }), { ok: false, cancelled: true });
  assert.match(h.calls[0].detail, /machine-wide/);
  assert.match(h.calls[0].detail, /lid closed/);
  assert.equal(fake.requests.length, 0);
  assert.equal(h.saved, 'off');
  await fake.close();

  const fake2 = await createFakeBurst({ '/api/keep-awake': () => ({ body: { detail: 'ok' } }) });
  const g = harness({ isMac: true, present: { url: `http://127.0.0.1:${fake2.port}/` } });
  const r = await g.handlers['keepawake:set']({ ok: true }, { enabled: true, mode: 'always' });
  assert.equal(r.ok, true);
  assert.equal(r.view.via, 'burst');
  assert.match(g.calls[0].detail, /battery[^\n]*flat/);
  assert.deepEqual(JSON.parse(fake2.requests[0].body), { mode: 'always', idle_minutes: Ipc.IDLE_MINUTES });
  assert.equal(g.saved, 'always');
  assert.equal(g.keepAwake.sync(working), false, 'Burst path never starts the app blocker');
  const off = await g.handlers['keepawake:set']({ ok: true }, { enabled: false });
  assert.equal(off.ok, true);
  assert.equal(JSON.parse(fake2.requests[1].body).mode, 'off');
  assert.equal(g.saved, 'off');
  await fake2.close();
});

test('Burst refusing leaves the saved choice alone', async () => {
  const fake = await createFakeBurst({ '/api/keep-awake': () => ({ status: 400, type: 'text/plain', body: 'no scripts dir' }) });
  const h = harness({ isMac: true, present: { url: `http://127.0.0.1:${fake.port}/` } });
  const r = await h.handlers['keepawake:set']({ ok: true }, { enabled: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /no scripts dir/);
  assert.equal(h.saved, 'off');
  await fake.close();
});

for (const [name, isMac, present] of [['Burst absent on macOS', true, null], ['Windows or Linux', false, null]]) {
  test(`${name}: the app blocker, no dialog, no Burst call, honest label`, async () => {
    const h = harness({ isMac, present });
    const v = await h.handlers['keepawake:get']({ ok: true });
    assert.equal(v.via, 'app');
    assert.match(v.label, /does not keep a closed laptop awake/);
    const r = await h.handlers['keepawake:set']({ ok: true }, { enabled: true });
    assert.equal(r.ok, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.saved, 'app');
    assert.equal(h.ipc.sync(idle), false);
    assert.equal(h.ipc.sync(working), true);
    assert.equal((await h.handlers['keepawake:set']({ ok: true }, { enabled: false })).ok, true);
    assert.equal(h.blocker.live.size, 0);
    assert.deepEqual(await h.handlers['keepawake:set']({ ok: true }, { enabled: 'yes' }), { ok: false, error: 'Bad request.' });
  });
}

test('a saved Burst choice is not silently flipped when Burst stops answering', async () => {
  const h = harness({ isMac: true, present: null, pref: 'ac' });
  assert.equal((await h.handlers['keepawake:get']({ ok: true })).via, 'burst');
  assert.equal((await h.handlers['keepawake:set']({ ok: true }, { enabled: false })).ok, false);
  assert.equal(h.saved, 'ac');
  assert.equal(h.ipc.sync(working), false);
});

test('macView: hidden off macOS; sleepers listed without Burst; Burst parts only when present, never a password', async () => {
  const sleepers = [{ pid: 9, process: 'caffeinate', type: 'PreventSystemSleep', name: 'x', for: 'make' }];
  const base = (extra) => Ipc.register({ utilityHandle: () => {}, allowed: () => true, isMac: true, keepAwake: KeepAwake.createKeepAwake({ powerSaveBlocker: fakeBlocker() }), dialog: {}, getPref: () => 'ac', setPref: () => {}, listAssertions: async () => sleepers, ...extra });
  assert.equal(await base({ isMac: false }).macView(), null);
  const absent = await base({ burst: { snapshot: () => ({ d: { kind: 'not_installed' }, url: null }) } }).macView();
  assert.deepEqual(absent, { others: [{ pid: 9, process: 'caffeinate', name: 'x', for: 'make' }], burst: null });
  const reads = {
    mac: { keep_awake: { mode: 'off', idle_minutes: 0, live: { on_ac: true, sleep_disabled: false } } },
    automask: { enabled: true, rules: [{ on: true }, { on: false }, { on: true }] },
    settings: { hotspot: { ssid: 'Phone', when: 'lid-closed', online: true, password_stored: true, hotspot_password: 'hunter2' } },
  };
  const present = await base({ burst: { snapshot: () => ({ d: { kind: 'present', state: { mode: 'transparent' } }, url: 'http://127.0.0.1:1/' }), read: async (n) => reads[n] } }).macView();
  assert.match(present.burst.keepAwake.drift, /Plexiform is set to plugged in only, but Burst has it off/);
  assert.deepEqual(present.burst.hotspot, { ssid: 'Phone', when: 'lid-closed', online: true });
  assert.deepEqual(present.burst.automask, { enabled: true, rules: 2 });
  assert.match(present.burst.remote, /Remote Control keeps working/);
  assert.ok(!JSON.stringify(present).includes('hunter2'));
});
