// The host side's in-flight caps (src/remote-interaction.js): at most 8
// long-poll watches and 16 requests in hand at once; past either, the device
// answers 'busy' at once instead of queueing. Stub provider, no hub.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRemoteInteractionHost } = require('../src/remote-interaction.js');

const T = { timeout: 10_000 };
const USER = 'u-1';

function stubAdapter() {
  let opened = 0;
  return {
    label: 'Stub', capabilities: { newTurn: true, steer: false, interrupt: false, ack: true, echo: false, stream: false, existingSessions: false },
    on: () => () => {}, alive: () => true,
    // The first session opens; every later launch hangs (a slow provider).
    open: () => (opened++ === 0 ? Promise.resolve({ target: 'stub-target-1' }) : new Promise(() => {})),
  };
}

const frame = (op, args = {}) => ({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: USER, from: 'phone', op, args });

test('MAX_WATCHES (8) and MAX_HANDLING (16): over either cap the answer is busy, not queued', T, async () => {
  const host = createRemoteInteractionHost({ userId: USER, adapters: { stub: stubAdapter() }, boardCurrent: (b) => b === null });
  try {
    const launched = await host.handle(frame('launch', { provider: 'stub' }));
    assert.equal(launched.ok, true, JSON.stringify(launched));
    const session = launched.state.session;
    const watches = Array.from({ length: 8 }, () => host.handle(frame('watch', { session, after: 1_000 })));
    const ninth = await host.handle(frame('watch', { session, after: 1_000 }));
    assert.equal(ninth.ok, false);
    assert.match(ninth.error, /busy/);
    // 8 watches + 8 stuck launches = 16 in hand: the 17th request is refused at once.
    for (let i = 0; i < 8; i++) host.handle(frame('launch', { provider: 'stub' }));
    const over = await host.handle(frame('list'));
    assert.equal(over.ok, false);
    assert.match(over.error, /busy/);
    assert.equal(watches.length, 8); // parked until a change or WATCH_MAX_MS (unref'd timers)
  } finally { host.close(); }
});
