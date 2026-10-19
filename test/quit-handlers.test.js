const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { onQuit } = require('../src/quit-handlers');
test('any number of quit handlers share one will-quit listener, run in order, and survive a throwing one', () => {
  const app = new EventEmitter(); const ran = [];
  for (let i = 0; i < 25; i++) onQuit(app, () => { ran.push(i); if (i === 3) throw new Error('boom'); });
  assert.equal(app.listenerCount('will-quit'), 1);
  const off = onQuit(app, () => ran.push('off')); off();
  app.emit('will-quit', {});
  assert.deepEqual(ran, [...Array(25).keys()]);
});
