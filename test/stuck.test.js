const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../hooks/session-machine.js');
const Stuck = require('../src/stuck.js');

const MIN = 60000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (min) => new Date(NOW - min * MIN).toISOString();
const ctx = { now: NOW, workingStaleMs: 6 * MIN, waitingStaleMs: 4 * 60 * MIN, stuckMs: 5 * MIN };
const session = (signal, min, extra = {}) => ({ sessionId: 's1', signal, updatedAt: ago(min), tool: 'Bash', ...extra });

test('a working session quiet past the threshold is flagged with its last tool and age', () => {
  const c = M.classify(session('tool-use', 7), ctx);
  assert.equal(c.live, true);
  assert.equal(c.rule, 'stuck');
  assert.deepEqual(c.session.stuck, { sinceMs: 7 * MIN, tool: 'Bash' });
  assert.equal(c.session.signal, 'tool-use');
});

test('under the threshold it is plain working; any newer event clears the flag', () => {
  assert.equal(M.classify(session('tool-use', 4), ctx).session.stuck, undefined);
  assert.equal(M.classify(session('tool-done', 0.1), ctx).rule, 'shown');
});

test('reconciled with the working window: stuck outlives the 6 min close, then closes', () => {
  assert.equal(M.classify(session('tool-use', 6.5), ctx).live, true);
  assert.equal(M.classify(session('tool-use', 14), ctx).live, true);
  const gone = M.classify(session('tool-use', 16), ctx);
  assert.equal(gone.live, false);
  assert.equal(gone.dropped, 'stale');
});

test('off (0) keeps the original working window', () => {
  const off = { ...ctx, stuckMs: 0 };
  assert.equal(M.classify(session('tool-use', 5.5), off).live, true);
  assert.equal(M.classify(session('tool-use', 5.5), off).session.stuck, undefined);
  assert.equal(M.classify(session('tool-use', 7), off).live, false);
});

test('never fires for waiting-on-you, quiet or finished sessions', () => {
  for (const sig of ['permission-ask', 'limit-hit', 'idle-nudge', 'stop', 'turn-failed', 'session-start']) {
    const c = M.classify(session(sig, 30), ctx);
    assert.equal(c.session && c.session.stuck, undefined, sig);
    assert.equal(c.live, true, `${sig} keeps the waiting window`);
  }
});

test('a missing or future clock is not stuck', () => {
  assert.equal(M.stuckOf({}, 'tool-use', NOW, 5 * MIN), null);
  assert.equal(M.stuckOf({ updatedAt: ago(-3) }, 'tool-use', NOW, 5 * MIN), null);
});

test('summary leads with the oldest quiet session', () => {
  const sessions = [{ stuck: { sinceMs: 6 * MIN, tool: 'Read' } }, { stuck: { sinceMs: 7 * MIN, tool: 'Bash' } }, {}];
  const s = Stuck.summary(sessions);
  assert.equal(s.count, 2);
  assert.equal(s.text, 'Stuck? last tool Bash · since 7m');
  assert.equal(Stuck.summary([{}]), null);
});

test('the lamp goes amber only over green', () => {
  const s = Stuck.summary([{ stuck: { sinceMs: 7 * MIN, tool: null } }]);
  assert.equal(Stuck.applyStuck({ lamp: 'green' }, s).lamp, 'amber');
  assert.equal(Stuck.applyStuck({ lamp: 'red' }, s).lamp, 'red');
  assert.equal(Stuck.applyStuck({ lamp: 'green' }, null).lamp, 'green');
  assert.equal(s.text, 'Stuck? since 7m');
});
