'use strict';

// C1/C2: the guided setup state machine, every branch. Run with
// `node --test --experimental-test-coverage` to see src/burst-setup.js at 100% branches.
const test = require('node:test');
const assert = require('node:assert/strict');
const Setup = require('../src/burst-setup.js');

const T0 = 1_700_000_000_000;
const present = (over = {}, state = {}) => ({ kind: 'present', state: { version: '0.20.36', mode: 'base-url', active: true, caTrusted: true, hostsEntry: true, inactiveReason: '', configError: '', ...state }, ...over });
const by = (st) => Object.fromEntries(st.steps.map((s) => [s.id, s]));
const statuses = (st) => st.steps.map((s) => `${s.id}:${s.status}`).join(' ');
const run = (probe, state = Setup.initial(), now = T0) => Setup.next(state, probe, { now });

test('shape: four steps, each with id, title, whatItChanges from the README, status, primary and a non-empty detail', () => {
  const st = run({ detect: { kind: 'not_installed' } });
  assert.deepEqual(st.steps.map((s) => s.id), ['install', 'trust', 'enable', 'check']);
  for (const s of st.steps) {
    assert.equal(typeof s.title, 'string');
    assert.ok(Array.isArray(s.whatItChanges) && s.whatItChanges.length > 0, s.id);
    assert.ok(['todo', 'running', 'done', 'failed', 'skipped'].includes(s.status));
    assert.ok(s.primary === null || (typeof s.primary.kind === 'string' && typeof s.primary.label === 'string'));
    assert.ok(s.detail.length > 0, s.id);
    assert.equal(s.startedAt, null);
  }
  assert.match(Setup.CHANGES.install.join(' '), /LaunchAgent that runs the gateway/);
  assert.match(Setup.CHANGES.trust.join(' '), /\/etc\/hosts entry, a pf redirect and a trusted root CA/);
  assert.match(Setup.CHANGES.enable.join(' '), /ANTHROPIC_BASE_URL/);
  assert.equal(Setup.TIMEOUT_MS, 120000);
});

test('initial: a bad mode falls back to base-url; a state without marks is rebuilt; current/running read the view', () => {
  assert.equal(Setup.initial('nope').mode, 'base-url');
  assert.equal(Setup.initial('transparent').mode, 'transparent');
  assert.equal(Setup.initial().steps.length, 0);
  const st = Setup.next({ mode: 'transparent' }, { detect: { kind: 'not_installed' } }, { now: T0 });
  assert.equal(st.mode, 'transparent');
  assert.equal(Setup.current(st), 'install');
  assert.equal(Setup.running(st), false);
  assert.equal(Setup.current(null), null);
  assert.equal(Setup.running(null), false);
  assert.equal(Setup.current(Setup.initial()), null);
  const everything = run({ detect: present(), console: { kind: 'present' } });
  assert.equal(Setup.current(everything), null);
});

test('install step: one branch per detection kind', () => {
  const t = (detect, status, kind, re) => {
    const s = by(run({ detect })).install;
    assert.equal(s.status, status, JSON.stringify(detect));
    assert.equal(s.primary && s.primary.kind, kind, JSON.stringify(detect));
    assert.match(s.detail, re);
  };
  t(undefined, 'todo', null, /Checking/);
  t({ kind: 'checking' }, 'todo', null, /Checking/);
  t({ kind: 'not_installed' }, 'todo', 'install', /clones it from GitHub/);
  t({ kind: 'broken', state: { configError: 'bad json' } }, 'failed', 'repair', /bad json/);
  t({ kind: 'broken' }, 'failed', 'repair', /configuration could not be read\. Repair/);
  t({ kind: 'unreachable' }, 'failed', 'repair', /not answering/);
  t({ kind: 'untrusted', reason: 'Port 7788 is someone else.' }, 'failed', null, /Port 7788 is someone else\. Plexiform stops here/);
  t({ kind: 'untrusted' }, 'failed', null, /is not Burst\. Plexiform stops here/);
  t(present({}, { version: '0.18.9' }), 'todo', 'update', /older than 0\.19\.0/);
  t(present({}, { version: 'garbage' }), 'todo', 'update', /older/);
  t(present({}, { version: '0.19.0' }), 'done', null, /0\.19\.0 is installed/);
  t(present({}, { version: '1.0.0' }), 'done', null, /installed/);
  t(present({}, { version: '0.19.5' }), 'done', null, /installed/);
  assert.equal(by(run({ detect: { kind: 'present' } })).install.status, 'todo', 'present without a state is treated as unknown version');
});

test('trust step: skipped in base-url, waits for install, names CA before hosts, done when both hold', () => {
  const tr = (probe, state) => by(run(probe, state)).trust;
  assert.equal(tr({ detect: { kind: 'not_installed' } }).status, 'skipped');
  assert.match(tr({ detect: { kind: 'not_installed' } }).detail, /Base-url mode/);
  const waiting = tr({ detect: { kind: 'not_installed' } }, Setup.initial('transparent'));
  assert.equal(waiting.status, 'todo'); assert.equal(waiting.primary, null); assert.match(waiting.detail, /after install/);
  // The detected mode wins over the chosen one.
  assert.equal(tr({ detect: present({}, { mode: 'base-url' }) }, Setup.initial('transparent')).status, 'skipped');
  const ca = tr({ detect: present({}, { mode: 'transparent', caTrusted: false, hostsEntry: false }) });
  assert.equal(ca.status, 'todo'); assert.deepEqual(ca.primary, { kind: 'repair', label: 'Fix trust' }); assert.match(ca.detail, /certificate/);
  const hosts = tr({ detect: present({}, { mode: 'transparent', caTrusted: true, hostsEntry: false }) });
  assert.deepEqual(hosts.primary, { kind: 'repair', label: 'Fix hosts entry' }); assert.match(hosts.detail, /\/etc\/hosts/);
  const ok = tr({ detect: present({}, { mode: 'transparent' }) });
  assert.equal(ok.status, 'done'); assert.equal(ok.primary, null);
  // Unknown (null) trust keys are not "false": a 0.19 Burst reports nothing and is not nagged.
  assert.equal(tr({ detect: present({}, { mode: 'transparent', caTrusted: null, hostsEntry: null }) }).status, 'done');
});

test('enable step: waits for install, offers Turn on with Burst\'s own reason, done when active', () => {
  const en = (detect) => by(run({ detect })).enable;
  const w = en({ kind: 'not_installed' });
  assert.equal(w.status, 'todo'); assert.equal(w.primary, null);
  const off = en(present({}, { active: false, inactiveReason: 'Turned off from the dashboard.' }));
  assert.equal(off.status, 'todo'); assert.deepEqual(off.primary, { kind: 'enable', label: 'Turn on' }); assert.equal(off.detail, 'Turned off from the dashboard.');
  assert.match(en(present({}, { active: false })).detail, /not in Claude Code's path/);
  const on = en(present());
  assert.equal(on.status, 'done'); assert.match(on.detail, /on, base-url mode/);
});

test('check step: every console kind, the upgrade and mod notes', () => {
  const ck = (probe) => by(run(probe)).check;
  const w = ck({ detect: present({}, { active: false }) });
  assert.equal(w.status, 'todo'); assert.equal(w.primary, null); assert.match(w.detail, /after Burst is on/);
  const no = ck({ detect: present() });
  assert.equal(no.status, 'todo'); assert.deepEqual(no.primary, { kind: 'retry', label: 'Run check' });
  assert.equal(ck({ detect: present(), console: { kind: 'checking' } }).status, 'todo');
  const down = ck({ detect: present(), console: { kind: 'unreachable' } });
  assert.equal(down.status, 'failed'); assert.deepEqual(down.primary, { kind: 'repair', label: 'Start console' });
  const bad = ck({ detect: present(), console: { kind: 'untrusted', reason: 'Not the console.' } });
  assert.equal(bad.status, 'failed'); assert.equal(bad.primary, null); assert.match(bad.detail, /^Not the console\. Plexiform stops here/);
  assert.match(ck({ detect: present(), console: { kind: 'untrusted' } }).detail, /not Burst's console/);
  const off = ck({ detect: present(), console: { kind: 'off' } });
  assert.equal(off.status, 'done'); assert.match(off.detail, /switched off in its config/);
  const ok = ck({ detect: present(), console: { kind: 'present' } });
  assert.equal(ok.status, 'done'); assert.equal(ok.detail, 'Burst and its support console both answer.');
  assert.match(ck({ detect: present(), console: { kind: 'present' }, upgrade: { canUpgrade: true, upToDate: false, latestVersion: 'v0.21.0' } }).detail, /newer Burst \(v0\.21\.0\) is available/);
  assert.match(ck({ detect: present(), console: { kind: 'present' }, upgrade: { canUpgrade: true, upToDate: false } }).detail, /newer Burst is available/);
  assert.equal(ck({ detect: present(), console: { kind: 'present' }, upgrade: { canUpgrade: true, upToDate: true } }).detail, 'Burst and its support console both answer.');
  assert.equal(ck({ detect: present(), console: { kind: 'present' }, upgrade: 'junk' }).detail, 'Burst and its support console both answer.');
  assert.match(ck({ detect: present(), console: { kind: 'present' }, modStatus: { installed: true, current: false } }).detail, /mod is out of date/);
  assert.equal(ck({ detect: present(), console: { kind: 'present' }, modStatus: { installed: false, current: false } }).detail, 'Burst and its support console both answer.');
  assert.equal(ck({ detect: present(), console: { kind: 'present' }, modStatus: 7 }).detail, 'Burst and its support console both answer.');
});

test('running: start marks a step, the probe confirming it clears the mark, 120 s without confirmation fails it with Retry', () => {
  let st = run({ detect: { kind: 'not_installed' } });
  st = Setup.start(st, 'install', T0);
  st = Setup.start(st, 'bogus', T0); // ignored
  st = Setup.next(st, { detect: { kind: 'not_installed' } }, { now: T0 + 30_000 });
  const r = by(st).install;
  assert.equal(r.status, 'running'); assert.equal(r.startedAt, T0); assert.equal(r.primary, null);
  assert.match(r.detail, /Waiting for Burst to confirm… 30 s\. Follow the Terminal window/);
  assert.equal(Setup.running(st), true);
  assert.equal(statuses(st), 'install:running trust:skipped enable:todo check:todo');
  // Confirmed by the probe: done, mark cleared.
  const done = Setup.next(st, { detect: present({}, { active: false }) }, { now: T0 + 40_000 });
  assert.equal(by(done).install.status, 'done'); assert.equal(done.marks.install.startedAt, null);
  // Not confirmed in time: failed, Retry, the step's own guidance kept.
  const late = Setup.next(st, { detect: { kind: 'not_installed' } }, { now: T0 + Setup.TIMEOUT_MS });
  const f = by(late).install;
  assert.equal(f.status, 'failed'); assert.deepEqual(f.primary, { kind: 'retry', label: 'Try again' });
  assert.match(f.detail, /^Nothing changed after 120 s\. Burst is not installed/);
  assert.deepEqual(late.marks.install, { startedAt: null, failed: true });
  // The failure sticks across probes until reset…
  const still = Setup.next(late, { detect: { kind: 'not_installed' } }, { now: T0 + 500_000 });
  assert.equal(by(still).install.status, 'failed'); assert.match(by(still).install.detail, /Try again when ready\.$/);
  assert.equal(Setup.reset(still, 'nope'), still, 'reset of an unknown step is a no-op');
  assert.equal(by(Setup.next(Setup.reset(still, 'install'), { detect: { kind: 'not_installed' } }, { now: T0 + 500_000 })).install.status, 'todo');
  // …or until the probe says done anyway.
  assert.equal(by(Setup.next(late, { detect: present() }, { now: T0 + 500_000 })).install.status, 'done');
  assert.equal(late.marks.install.failed, true, 'next never mutates its input');
});

test('running check step wording, a skipped running step and a done running step clear their marks', () => {
  let st = run({ detect: present() });
  st = Setup.start(st, 'check', T0);
  st = Setup.start(st, 'trust', T0);
  st = Setup.start(st, 'enable', T0);
  st = Setup.next(st, { detect: present() }, { now: T0 + 5_000 });
  assert.equal(by(st).check.status, 'running');
  assert.equal(by(st).check.detail, 'Checking… 5 s.');
  assert.equal(by(st).trust.status, 'skipped'); assert.equal(st.marks.trust.startedAt, null);
  assert.equal(by(st).enable.status, 'done'); assert.equal(st.marks.enable.startedAt, null);
  const ok = Setup.next(st, { detect: present(), console: { kind: 'present' } }, { now: T0 + 6_000 });
  assert.equal(by(ok).check.status, 'done'); assert.equal(Setup.running(ok), false);
  const timedOut = Setup.next(st, { detect: present() }, { now: T0 + Setup.TIMEOUT_MS + 1 });
  assert.equal(by(timedOut).check.status, 'failed');
  assert.match(by(timedOut).check.detail, /^Nothing changed after 120 s\. Checks that the gateway/);
});

test('a step the probe calls failed (console down) does not need a mark, and a transparent install runs the whole ladder', () => {
  const down = run({ detect: present(), console: { kind: 'unreachable' } });
  assert.equal(statuses(down), 'install:done trust:skipped enable:done check:failed');
  assert.deepEqual(down.marks.check, { startedAt: null, failed: false });
  let st = Setup.initial('transparent');
  st = Setup.next(st, { detect: { kind: 'not_installed' } }, { now: T0 });
  assert.equal(statuses(st), 'install:todo trust:todo enable:todo check:todo');
  st = Setup.next(st, { detect: present({}, { mode: 'transparent', active: false, caTrusted: false }) }, { now: T0 });
  assert.equal(statuses(st), 'install:done trust:todo enable:todo check:todo');
  st = Setup.next(st, { detect: present({}, { mode: 'transparent', active: false }) }, { now: T0 });
  assert.equal(statuses(st), 'install:done trust:done enable:todo check:todo');
  st = Setup.next(st, { detect: present({}, { mode: 'transparent' }), console: { kind: 'present' } }, { now: T0 });
  assert.equal(statuses(st), 'install:done trust:done enable:done check:done');
  assert.equal(Setup.current(st), null);
});
