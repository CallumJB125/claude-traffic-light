const test = require('node:test');
const assert = require('node:assert/strict');
const { trayLookAnimated, trayTimerAction } = require('../src/tray-anim.js');

test('animated lamp effects and poses need the repaint clock; a still look does not', () => {
  assert.equal(trayLookAnimated({ lampFx: 'pulse' }), true);
  assert.equal(trayLookAnimated({ lampFx: 'solid', pose: 'party' }), true);
  assert.equal(trayLookAnimated({ lampFx: 'solid', pose: 'idle' }), false);
  assert.equal(trayLookAnimated(null), false);
});

test('timer starts for an animation, stops when it ends, and never runs outside menu-bar mode', () => {
  const look = { lampFx: 'breathe' };
  assert.equal(trayTimerAction({ menuBarMode: true, look, running: false }), 'start');
  assert.equal(trayTimerAction({ menuBarMode: true, look, running: true }), 'keep');
  assert.equal(trayTimerAction({ menuBarMode: true, look: { lampFx: 'solid' }, running: true }), 'stop');
  assert.equal(trayTimerAction({ menuBarMode: false, look, running: true }), 'stop');
  assert.equal(trayTimerAction({ menuBarMode: false, look, running: false }), 'keep');
});
