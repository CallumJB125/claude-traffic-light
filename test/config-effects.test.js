const test = require('node:test');
const assert = require('node:assert/strict');
const { applyConfigSideEffects } = require('../src/config-effects.js');

const deps = () => {
  const calls = [];
  const d = new Proxy({}, { get: (_t, name) => (...a) => { calls.push([name, ...a.length ? [true] : []]); return Promise.resolve(); } });
  return { d, names: () => calls.map((c) => c[0]) };
};

test('a restore that turns remoteTailscale and askFromWidget off applies both', () => {
  const { d, names } = deps();
  applyConfigSideEffects({ remoteTailscale: true, askFromWidget: true }, { remoteTailscale: false, askFromWidget: false }, d);
  assert.ok(names().includes('syncTailnetListener'));
  assert.ok(names().includes('installHooks'));
  assert.equal(names().at(-1), 'broadcastStatus');
});

test('nothing changed: only the broadcast', () => {
  const { d, names } = deps();
  applyConfigSideEffects({ showWidget: true, voice: { a: 1 } }, { showWidget: true, voice: { a: 1 } }, d);
  assert.deepEqual(names(), ['broadcastStatus']);
});

test('each setting reaches its own side effect', () => {
  const run = (prev, next) => { const { d, names } = deps(); applyConfigSideEffects(prev, next, d); return names(); };
  assert.ok(run({ showWidget: true }, { showWidget: false }).includes('applyWidgetVisibility'));
  assert.ok(run({ showWidget: true }, { showWidget: false }).includes('createTray'));
  assert.ok(run({ menuBarMode: false }, { menuBarMode: true }).includes('createTray'));
  assert.ok(run({ voice: { a: 1 } }, { voice: { a: 2 } }).includes('applyVoiceHotkey'));
  assert.ok(run({ busyCalendar: false }, { busyCalendar: true }).includes('enableCalendar'));
  assert.ok(!run({ busyCalendar: true }, { busyCalendar: true }).includes('enableCalendar'));
});

test('a save that names a key applies its effect even when the value is the same', () => {
  const { d, names } = deps();
  applyConfigSideEffects({ showWidget: true }, { showWidget: true }, d, (k) => k === 'showWidget');
  assert.ok(names().includes('applyWidgetVisibility'));
});


test('automatic team sharing setting applies the hosting side effect',()=>{
 let calls=0;applyConfigSideEffects({teamSessionSharing:true},{teamSessionSharing:false},{syncInteractionHost:()=>calls++,broadcastStatus(){}});assert.equal(calls,1);
});
