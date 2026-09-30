// The session state machine (hooks/session-machine.js), table by table: every
// (state, event) transition for both writers, the reader's presentation
// rules, and the flicker bugs the guards exist for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const M = require('../hooks/session-machine.js');
const Doc = require('../scripts/state-machine-doc.js');

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();

// A representative stored session per state.
const SIGNAL_OF_STATE = { working: 'tool-use', started: 'session-start', asking: 'permission-ask', limited: 'limit-hit', finished: 'stop', nudged: 'idle-nudge', failed: 'turn-failed' };
const prevFor = (state) => (state === 'absent' ? null : {
  signal: SIGNAL_OF_STATE[state], prevSignal: 'prompt-submit', signalSince: iso(-5000), updatedAt: iso(-5000),
  agentsAt: iso(-9000), workingSince: state === 'working' ? iso(-60000) : null, touchedAt: iso(-60000),
});
// Every signal each event stands for; `agent` also covers a subagent's own
// tool use (and its denied calls).
const EVENT_INPUTS = {
  prompt: [{ signal: 'prompt-submit' }],
  work: ['tool-use', 'tool-done', 'tool-failed', 'compact', 'permission-denied'].map((signal) => ({ signal })),
  agent: [{ signal: 'subagent-start' }, { signal: 'subagent-done' }, { signal: 'tool-use', fromSubagent: true }, { signal: 'tool-done', fromSubagent: true }, { signal: 'tool-failed', fromSubagent: true }, { signal: 'permission-denied', fromSubagent: true }],
  task: [{ signal: 'task-created' }, { signal: 'task-done' }],
  start: [{ signal: 'session-start' }],
  stop: [{ signal: 'stop' }],
  nudge: [{ signal: 'idle-nudge' }],
  fail: [{ signal: 'turn-failed' }],
  ask: [{ signal: 'permission-ask' }],
  limit: [{ signal: 'limit-hit' }],
  end: [{ signal: 'session-end' }],
};

// The expected machine, written out by hand (not derived from the code).
// w working, s started, a asking, l limited, f finished, n nudged, x failed,
// - absent; UPPER CASE = the stored signal was kept (a guard held).
// A denied tool call is `work`: the turn carries on, so there is no denied state.
const COLS = ['prompt', 'work', 'agent', 'task', 'start', 'stop', 'nudge', 'fail', 'ask', 'limit', 'end'];
const HOOK = {
  absent: 'w w w W s f n x a l -',
  working: 'w w w W s f n x a l -',
  started: 'w w S S s f n x a l -',
  asking: 'w w A A s f n x a l -',
  limited: 'w w L L s f n x a l -',
  finished: 'w w F F s f n x a l -',
  nudged: 'w w N N s f n x a l -',
  failed: 'w w X X s f X x a l -',
};
// A bare signal (emit.js, /signal) gets the same guards; only task counting
// (hook-only data) is skipped, so a bare task signal lands as sent.
const BARE = {
  absent: 'w w w w s f n x a l -',
  working: 'w w w w s f n x a l -',
  started: 'w w S w s f n x a l -',
  asking: 'w w A w s f n x a l -',
  limited: 'w w L w s f n x a l -',
  finished: 'w w F w s f n x a l -',
  nudged: 'w w N w s f n x a l -',
  failed: 'w w X w s f X x a l -',
};
const LETTER = { w: 'working', s: 'started', a: 'asking', l: 'limited', f: 'finished', n: 'nudged', x: 'failed', '-': 'absent' };

test('machine: the spec covers every state and event the machine has', () => {
  assert.deepEqual(Object.keys(HOOK), M.STATES);
  assert.deepEqual(COLS, M.EVENTS);
  assert.equal(M.table('hook').length, M.STATES.length * M.EVENTS.length);
});

for (const [writer, spec] of [['hook', HOOK], ['bare', BARE]]) {
  for (const from of M.STATES) {
    const cells = spec[from].split(' ');
    COLS.forEach((event, i) => {
      const cell = cells[i];
      const to = LETTER[cell.toLowerCase()];
      const kept = cell !== cell.toLowerCase();
      test(`machine[${writer}]: ${from} --${event}--> ${to}${kept ? ' (kept)' : ''}`, () => {
        for (const input of EVENT_INPUTS[event]) {
          const prev = prevFor(from);
          const t = M.step(prev, { ...input, writer }, iso(0));
          assert.equal(t.from, from);
          assert.equal(t.event, event, `${input.signal}${input.fromSubagent ? ' (subagent)' : ''}`);
          assert.equal(t.to, to, `${input.signal}: ${t.rule}`);
          assert.equal(t.held, kept, `${input.signal}: held`);
          const expected = to === 'absent' ? null : kept ? (prev ? prev.signal : 'tool-use') : input.signal;
          assert.equal(t.signal, expected, `${input.signal}: stored signal`);
          const row = M.table(writer).find((r) => r.from === from && r.event === event);
          assert.equal(row.rule, t.rule, 'table() agrees with step()');
        }
      });
    });
  }
}

test('machine: TURN_END is exactly the closed states, WAITING_ON_YOU and PROMOTABLE are subsets of it', () => {
  assert.deepEqual([...M.TURN_END].map((s) => M.stateOf({ signal: s })).sort(), [...M.CLOSED].sort());
  for (const s of M.WAITING_ON_YOU) assert.ok(M.TURN_END.has(s), s);
  for (const s of M.PROMOTABLE_TURN_END) assert.ok(M.TURN_END.has(s), s);
  for (const s of M.WAITING) assert.ok(M.WAITING_ON_YOU.has(s), s);
  for (const s of M.QUIET) assert.ok(M.TURN_END.has(s) && !M.WAITING_ON_YOU.has(s), `${s}: closed, but not waiting on you`);
  assert.equal(M.stateOf({ state: 'green' }), 'working', 'a legacy file with no signal is mid-turn to the writer');
});

// ── Clocks ────────────────────────────────────────────────────────────────
test('machine clocks: a prompt starts the working clock, a turn end stops it, work keeps it', () => {
  assert.equal(M.step(prevFor('finished'), { signal: 'prompt-submit' }, iso(0)).workingSince, iso(0));
  assert.equal(M.step(prevFor('working'), { signal: 'tool-use' }, iso(0)).workingSince, iso(-60000));
  assert.equal(M.step(null, { signal: 'tool-use' }, iso(0)).workingSince, iso(0), 'first sight of a working session');
  for (const end of M.TURN_END) assert.equal(M.step(prevFor('working'), { signal: end }, iso(0)).workingSince, null, end);
});

test('machine clocks: a denied tool call mid-turn keeps the turn and its clock (auto-mode classifier)', () => {
  const t = M.step(prevFor('working'), { signal: 'permission-denied' }, iso(0));
  assert.deepEqual([t.to, t.signal, t.workingSince], ['working', 'permission-denied', iso(-60000)], 'no green→off→green, no clock reset');
  assert.equal(t.touchedAt, prevFor('working').touchedAt, 'the classifier denying is not you');
  const back = M.step({ ...prevFor('working'), ...t }, { signal: 'tool-use' }, iso(1000));
  assert.equal(back.workingSince, iso(-60000), 'Claude carrying on is the same turn');
});

test('machine clocks: signalSince moves only when the stored signal changes', () => {
  const ask = M.step(prevFor('working'), { signal: 'permission-ask' }, iso(0));
  assert.equal(ask.signalSince, iso(0));
  assert.equal(ask.prevSignal, 'tool-use');
  const again = M.step({ ...prevFor('asking'), signalSince: iso(-300) }, { signal: 'permission-ask' }, iso(0));
  assert.equal(again.signalSince, iso(-300), 'a repeat notification does not restart the transient-ask hold');
  assert.equal(again.prevSignal, 'prompt-submit');
});

// ── Past flicker bugs, each pinned where the guard lives ──────────────────
test('flicker: a background agent finishing after the turn ended does not reopen it (9908a1c, 8f42d15)', () => {
  const prev = { ...prevFor('finished'), workingSince: iso(-90000) };
  const t = M.step(prev, { signal: 'subagent-done' }, iso(0));
  assert.equal(t.signal, 'stop', 'still "Task finished", not green');
  assert.equal(t.updatedAt, prev.updatedAt, 'updatedAt holds, so ignored-N and stale windows are not reset');
  assert.equal(t.agentsAt, iso(0), 'agentsAt stamps the bookkeeping');
  assert.equal(t.workingSince, iso(-90000), 'a closed turn keeps its clock');
  assert.equal(t.touchedAt, prev.touchedAt, 'an agent moving is not you');
  const tool = M.step(prev, { signal: 'tool-use', fromSubagent: true }, iso(0));
  assert.equal(tool.signal, 'stop', "a subagent's own tool use after the turn is bookkeeping too");
  const mid = M.step(prevFor('working'), { signal: 'subagent-start' }, iso(0));
  assert.equal(mid.signal, 'subagent-start', 'mid-turn, a subagent starting is work (v3 rules)');
});

test('flicker: the idle nudge after a failed turn keeps the failure on show (f0e808b)', () => {
  const t = M.step(prevFor('failed'), { signal: 'idle-nudge' }, iso(0));
  assert.equal(t.signal, 'turn-failed');
  assert.ok(t.held && !t.bookkeeping, 'held, but the session did move');
  assert.equal(t.updatedAt, iso(0));
  const ask = M.step(prevFor('failed'), { signal: 'permission-ask' }, iso(0));
  assert.equal(ask.signal, 'permission-ask', 'an ask or a limit still replaces a failure');
});

test('flicker: a young notification ask shows what came before it; real asks show at once (9908a1c)', () => {
  const ask = { sessionId: 's1', signal: 'permission-ask', askKind: 'notification', prevSignal: 'stop', signalSince: iso(-300), updatedAt: iso(-300) };
  assert.equal(M.presentSignal(ask, T0), 'stop');
  assert.equal(M.presentSignal({ ...ask, prevSignal: 'permission-ask' }, T0), 'tool-use');
  assert.equal(M.presentSignal({ ...ask, signalSince: iso(-M.TRANSIENT_ASK_MS) }, T0), 'permission-ask');
  assert.equal(M.presentSignal({ ...ask, askKind: 'request' }, T0), 'permission-ask');
  assert.equal(M.presentSignal({ ...ask, askKind: 'question' }, T0), 'permission-ask');
  assert.equal(M.presentSignal(ask, T0, ['s1']), 'permission-ask', 'a pending PermissionRequest');
});

test('touches: only you acting resets the ignored clock (10fe889)', () => {
  const cases = [
    [null, 'prompt-submit', {}, true],
    [null, 'permission-denied', {}, false],
    [{ signal: 'permission-ask', askKind: 'request', signalSince: iso(-5000) }, 'permission-denied', {}, true],
    [{ signal: 'permission-ask', askKind: 'notification', signalSince: iso(-300) }, 'permission-denied', {}, false],
    [null, 'session-start', { sessionSource: 'startup' }, true],
    [null, 'session-start', { sessionSource: 'compact' }, false],
    [null, 'prompt-submit', { bookkeeping: true }, false],
    [{ signal: 'permission-ask', askKind: 'notification', signalSince: iso(-300) }, 'tool-use', {}, false],
    [{ signal: 'permission-ask', askKind: 'notification', signalSince: iso(-5000) }, 'tool-use', {}, true],
    [{ signal: 'permission-ask', askKind: 'request', signalSince: iso(-10) }, 'tool-use', {}, true],
    [{ signal: 'permission-ask', askKind: 'question', signalSince: iso(-5000) }, 'stop', {}, false],
    [{ signal: 'tool-use' }, 'tool-done', {}, false],
  ];
  for (const [prev, signal, opts, want] of cases) assert.equal(M.userTouched(prev, signal, { ...opts, now: T0 }), want, `${prev ? prev.signal : '∅'} → ${signal} ${JSON.stringify(opts)}`);
  assert.equal(M.step({ ...prevFor('failed') }, { signal: 'idle-nudge' }, iso(0)).touchedAt, prevFor('failed').touchedAt, 'a held nudge is not a touch');
});

// ── Reader: every presentation rule ───────────────────────────────────────
const CTX = { now: T0, workingStaleMs: 10 * 60000, waitingStaleMs: 12 * 3600000 };
const working = (since) => [{ id: 'a', status: 'working', since: iso(since) }];
const PRESENT_CASES = [
  // [outcome, session, ctx overrides, presented, source]
  ['no-signal', { updatedAt: iso(0) }, {}, undefined, undefined],
  ['no-signal', { state: 'bogus', updatedAt: iso(0) }, {}, undefined, undefined],
  ['gone', { signal: 'tool-use', updatedAt: iso(0) }, { isGone: () => true }, undefined, undefined],
  ['held', { sessionId: 's', signal: 'permission-ask', askKind: 'notification', prevSignal: 'tool-done', signalSince: iso(-100), updatedAt: iso(-100) }, {}, 'tool-done', 'hysteresis-held'],
  ['promoted', { signal: 'stop', updatedAt: iso(-60000), agents: working(-60000) }, {}, 'tool-use', 'promoted-agents'],
  ['promoted', { signal: 'idle-nudge', updatedAt: iso(-60000), agents: working(-60000) }, {}, 'tool-use', 'promoted-agents'],
  ['promoted', { signal: 'session-start', updatedAt: iso(-60000), agents: [{ id: 'm', kind: 'teammate', status: 'working', since: iso(-60000) }] }, {}, 'tool-use', 'promoted-agents'],
  ['shown', { signal: 'permission-denied', tool: 'Bash', updatedAt: iso(-60000), agents: [{ id: 'b' }] }, {}, 'permission-denied', 'hook signal'],
  ['stale-agents', { signal: 'stop', updatedAt: iso(-7 * 3600000), agents: working(-7 * 3600000) }, {}, 'tool-use', 'promoted-agents'],
  ['promoted', { signal: 'stop', updatedAt: iso(-7 * 3600000), agentsAt: iso(-60000), agents: working(-7 * 3600000) }, {}, 'tool-use', 'promoted-agents'],
  ['stale', { signal: 'tool-use', updatedAt: iso(-11 * 60000) }, {}, 'tool-use', 'hook signal'],
  ['shown', { signal: 'stop', via: 'stop', updatedAt: iso(-11 * 60000) }, {}, 'stop', 'stop'],
  ['stale', { signal: 'stop', updatedAt: iso(-13 * 3600000) }, {}, 'stop', 'hook signal'],
  ['shown', { signal: 'session-start', updatedAt: iso(-11 * 60000) }, {}, 'session-start', 'hook signal'],
  ['stale', { signal: 'session-start', updatedAt: iso(-13 * 3600000) }, {}, 'session-start', 'hook signal'],
  ['shown', { signal: 'permission-ask', askKind: 'request', updatedAt: iso(-100), agents: working(-100) }, {}, 'permission-ask', 'hook signal'],
  ['shown', { signal: 'limit-hit', updatedAt: iso(-100), agents: working(-100) }, {}, 'limit-hit', 'hook signal'],
  ['held', { state: 'amber', updatedAt: iso(-100) }, {}, 'tool-use', 'hysteresis-held'],
  ['shown', { state: 'amber', updatedAt: iso(-5000) }, {}, 'permission-ask', 'hook signal'],
  ['shown', { signal: 'tool-use' }, {}, 'tool-use', 'hook signal'],
];

test('reader: the presentation rules are the ones the doc lists, in order', () => {
  assert.deepEqual(M.PRESENTATION.map((p) => p.id), ['no-signal', 'gone', 'held', 'promoted', 'stale-agents', 'stale', 'shown']);
  const covered = new Set(PRESENT_CASES.map((c) => c[0]));
  for (const p of M.PRESENTATION) assert.ok(covered.has(p.id), `no case for ${p.id}`);
});

for (const [outcome, session, over, presented, source] of PRESENT_CASES) {
  test(`reader: ${outcome} — ${JSON.stringify(session).slice(0, 90)}`, () => {
    const c = M.classify(session, { ...CTX, ...over });
    const live = ['held', 'promoted', 'shown'].includes(outcome);
    assert.equal(c.live, live);
    if (['no-signal', 'gone', 'stale-agents', 'stale'].includes(outcome)) assert.equal(c.dropped, outcome);
    else assert.equal(c.rule, outcome);
    if (presented !== undefined) {
      assert.equal(c.presented, presented);
      assert.equal(c.source, source);
      assert.equal(c.session.signal, presented);
    }
  });
}

test('reader: a signal-less file never asks whether its process is gone', () => {
  let asked = 0;
  M.classify({ updatedAt: iso(0) }, { ...CTX, isGone: () => { asked += 1; return true; } });
  assert.equal(asked, 0);
});

test('reader: a promoted session carries the turn it hides', () => {
  const c = M.classify({ signal: 'stop', tool: 'Bash', updatedAt: iso(0), agents: working(0) }, CTX);
  assert.deepEqual([c.session.signal, c.session.tool, c.session.turnSignal], ['tool-use', 'Agent', 'stop']);
});

// ── Doc ───────────────────────────────────────────────────────────────────
test('docs/state-machine.md is generated from the table (run node scripts/state-machine-doc.js)', () => {
  assert.equal(fs.readFileSync(Doc.OUT, 'utf8'), Doc.render());
  assert.ok(Doc.render().includes(M.mermaid()));
});
