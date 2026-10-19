const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLowPowerMode, resolveLowPower } = require('../src/low-power.js');
const { applyConfigSideEffects } = require('../src/config-effects.js');

test('auto is on for Windows and for battery, off for a plugged-in Mac or Linux', () => {
  assert.equal(resolveLowPower({ mode: 'auto', platform: 'win32', onBattery: false }), true);
  assert.equal(resolveLowPower({ mode: 'auto', platform: 'darwin', onBattery: true }), true);
  assert.equal(resolveLowPower({ mode: 'auto', platform: 'darwin', onBattery: false }), false);
  assert.equal(resolveLowPower({ mode: 'auto', platform: 'linux', onBattery: false }), false);
});

test('an explicit on or off wins over the platform and the battery', () => {
  assert.equal(resolveLowPower({ mode: 'on', platform: 'darwin', onBattery: false }), true);
  assert.equal(resolveLowPower({ mode: 'off', platform: 'win32', onBattery: true }), false);
});

test('a missing or unknown preference is auto; booleans map to on/off', () => {
  assert.equal(normalizeLowPowerMode(undefined), 'auto');
  assert.equal(normalizeLowPowerMode('bogus'), 'auto');
  assert.equal(normalizeLowPowerMode(true), 'on');
  assert.equal(normalizeLowPowerMode(false), 'off');
  assert.equal(resolveLowPower({ platform: 'win32' }), true);
});

test('changing the preference reaches applyLowPower', () => {
  const calls = [];
  const d = new Proxy({}, { get: (_t, name) => () => { calls.push(name); } });
  applyConfigSideEffects({ lowPower: 'auto' }, { lowPower: 'on' }, d);
  assert.ok(calls.includes('applyLowPower'));
});
