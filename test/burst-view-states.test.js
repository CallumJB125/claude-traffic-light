'use strict';

// A3: statusView gives every state a non-empty detail and one `action` ({kind,label} or null),
// across the old kinds and the 0.20 ones (too_old, console_down, ca_untrusted, hosts_missing, gateway_stale).

const test = require('node:test');
const assert = require('node:assert/strict');
const View = require('../src/burst-view.js');

const NOW = 1_800_000_000_000;
const sv = (d, o = {}) => View.statusView(d, { platform: 'darwin', now: () => NOW, ...o });
const state = (over = {}) => ({ version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', until: '', rejected: [], primaryFailures: 0, caTrusted: false, hostsEntry: false, remoteControlExpected: false, ...over });
const present = (over = {}, extra = {}) => ({ kind: 'present', installed: true, capabilities: { upgradeStatus: true }, upgrade: null, state: state(over), ...extra });

// [name, detection, expected kind, expected action kind (null = nothing to do), extra checks]
const TABLE = [
  ['unsupported', { kind: 'unsupported' }, 'unsupported', null],
  ['checking', { kind: 'checking' }, 'checking', null],
  ['not installed', { kind: 'not_installed' }, 'not_installed', 'install'],
  ['unreachable, first misses', { kind: 'unreachable', installed: true, misses: 1 }, 'off', 'retry'],
  ['unreachable, many misses', { kind: 'unreachable', installed: true, misses: 3 }, 'off', 'enable'],
  ['gateway stale', { kind: 'unreachable', installed: true, misses: 2, lastGood: { at: NOW - 5 * 60 * 1000, state: state() } }, 'gateway_stale', 'repair', (v) => { assert.equal(v.dimmed, true); assert.match(v.detail, /last known state from 5 min ago/); assert.equal(v.version, '0.20.36'); assert.equal(v.active, true); assert.deepEqual(v.chip, { tone: 'amber', label: 'Not responding' }); }],
  ['untrusted', { kind: 'untrusted', installed: true, reason: 'Another program answered.' }, 'untrusted', 'off', (v) => assert.match(v.detail, /^Another program answered\. Plexiform read nothing/)],
  ['broken', { kind: 'broken', installed: true, state: { version: '0.20.36' } }, 'broken', 'repair'],
  ['too old', present({ version: '0.12.1' }), 'too_old', 'update', (v) => { assert.match(v.detail, /0\.12\.1 is older than 0\.19\.0/); assert.equal(v.canOpenDashboard, false); assert.equal(v.chip.label, 'Update needed'); }],
  ['too old, cannot self-update', present({ version: '0.12.1' }, { upgrade: { canUpgrade: false, upToDate: false } }), 'too_old', 'off', (v) => assert.match(v.detail, /update it the way you installed it/)],
  ['0.19 still works, features hidden', present({ version: '0.19.0' }), 'on', null],
  ['transparent, CA untrusted', present({ mode: 'transparent', caTrusted: false, hostsEntry: true }), 'ca_untrusted', 'repair', (v) => { assert.match(v.detail, /certificate/); assert.equal(v.active, true); }],
  ['transparent, hosts entry missing', present({ mode: 'transparent', caTrusted: true, hostsEntry: false }), 'hosts_missing', 'repair', (v) => assert.match(v.detail, /\/etc\/hosts/)],
  ['transparent, CA beats hosts when both are wrong', present({ mode: 'transparent', caTrusted: false, hostsEntry: false }), 'ca_untrusted', 'repair'],
  ['base-url mode never complains about CA or hosts', present({ mode: 'base-url', caTrusted: false, hostsEntry: false }), 'on', null],
  ['console down', present({}, { console: { kind: 'unreachable' } }), 'console_down', 'console-restart', (v) => { assert.equal(v.action.label, 'Start console'); assert.match(v.detail, /support console/); }],
  ['console off by config is not console down', present({}, { console: { kind: 'off' } }), 'on', null],
  ['on, healthy, current', present(), 'on', null, (v) => { assert.deepEqual(v.chip, { tone: 'green', label: 'Primary' }); assert.equal(v.active, true); }],
  ['on, update available', present({}, { upgrade: { canUpgrade: true, upToDate: false } }), 'on', 'update'],
  ['off (installed, not in path)', present({ active: false }), 'off', 'enable', (v) => assert.equal(v.active, false)],
];

test('A3: table of states: kind, non-empty detail and the one action', () => {
  assert.ok(TABLE.length >= 10);
  for (const [name, d, kind, action, check] of TABLE) {
    const v = sv(d);
    assert.equal(v.kind, kind, `${name}: kind`);
    assert.equal(typeof v.detail, 'string', name);
    assert.ok(v.detail.trim().length > 0, `${name}: detail must not be empty`);
    assert.ok(typeof v.headline === 'string' && v.headline, name);
    assert.ok(typeof v.active === 'boolean' && typeof v.dimmed === 'boolean', `${name}: active/dimmed`);
    if (action === null) assert.equal(v.action, null, `${name}: no action`);
    else {
      assert.equal(v.action && v.action.kind, action, `${name}: action`);
      assert.deepEqual(Object.keys(v.action).sort(), ['kind', 'label'], name);
      assert.ok(v.action.label, name);
      assert.ok(v.actions.some((a) => a.kind === action), `${name}: action is in actions`);
    }
    if (check) check(v);
  }
});

test('A3: the action never names a verb outside the known set, and non-mac has none', () => {
  const KNOWN = new Set(['install', 'enable', 'off', 'repair', 'update', 'uninstall', 'retry', 'console-restart', 'open-dashboard', 'open-browser']);
  for (const [name, d] of TABLE) { const v = sv(d); if (v.action) assert.ok(KNOWN.has(v.action.kind), `${name}: ${v.action.kind}`); }
  const w = View.statusView(present(), { platform: 'win32' });
  assert.equal(w.action, null);
  assert.equal(w.detail, View.MAC_ONLY);
});

test('ageText reads like a person', () => {
  assert.equal(View.ageText(4000), '4 s ago');
  assert.equal(View.ageText(90_000), '2 min ago');
  assert.equal(View.ageText(3 * 3600_000), '3 h ago');
  assert.equal(View.ageText(72 * 3600_000), '3 days ago');
  assert.equal(View.ageText(NaN), 'a moment ago');
});
