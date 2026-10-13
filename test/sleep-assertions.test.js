'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sleepers = require('../src/sleep-assertions.js');

const OUT = `Assertion status system-wide:
   PreventSystemSleep             1
Listed by owning process:
   pid 34884(caffeinate): [0x00034570000190d2] 38:44:03 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting on behalf of 'claude' (pid 34411)
   pid 58281(caffeinate): [0x00048f2d00079ce4] 07:11:56 PreventSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting on behalf of '/Users/x/cycle.sh' (pid 58280)
   pid 335(powerd): [0x00044fc100018b2d] 11:42:33 PreventSystemSleep named: "Powerd - Prevent sleep while display is on"
   pid 88(Some App): [0x0000a1b2000190c6] 00:00:05 PreventSystemSleep named: "sync"
   pid 89(other): [0x0000a1b2000190c7] 00:00:05 PreventSystemSleepFoo named: "not this"
`;

test('parse lists PreventSystemSleep holders and ignores idle-sleep noise and powerd', () => {
  assert.deepEqual(Sleepers.parse(OUT), [
    { pid: 58281, process: 'caffeinate', type: 'PreventSystemSleep', name: 'caffeinate command-line tool', for: 'cycle.sh' },
    { pid: 88, process: 'Some App', type: 'PreventSystemSleep', name: 'sync' },
  ]);
  assert.deepEqual(Sleepers.parse(''), []);
  assert.deepEqual(Sleepers.parse(null), []);
  assert.deepEqual(Sleepers.parse('   pid 1(caffeinate): [0x1] 00:00:01 PreventUserIdleSystemSleep named: "x"\n'), []);
});

test('listAssertions parses on macOS and never spawns elsewhere', async () => {
  let ran = 0;
  const run = async () => { ran++; return OUT; };
  assert.equal((await Sleepers.listAssertions({ platform: 'darwin', run })).length, 2);
  assert.deepEqual(await Sleepers.listAssertions({ platform: 'linux', run }), []);
  assert.deepEqual(await Sleepers.listAssertions({ platform: 'win32', run }), []);
  assert.equal(ran, 1);
});
