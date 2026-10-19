'use strict';
// Main's lane and rings wiring (src/widget-lane-main.js), with a fake ipcMain and send.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LaneMain = require('../src/widget-lane-main.js');

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

function rig(initial = {}) {
  const state = { sessions: [], team: null, budget: [], collisions: [], git: [], spend: null, ...initial };
  let clock = 10 * MIN;
  const sent = [];
  const handles = new Map();
  const timers = [];
  const ipcMain = { handle: (ch, fn) => handles.set(ch, fn) };
  const api = LaneMain.install({
    ipcMain,
    send: (ch, v) => sent.push([ch, v]),
    allowed: (e) => e && e.widget === true,
    now: () => clock,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearInterval: () => {},
    sources: {
      state: () => ({ sessions: state.sessions, team: state.team, budget: state.budget }),
      local: (rows) => rows.filter((r) => !String(r.sessionId).startsWith('remote:')),
      collisions: { list: () => state.collisions },
      git: { active: () => state.git },
      spend: () => state.spend,
      warnAt: () => 0.8,
    },
  });
  return { state, sent, handles, timers, api, tick: () => api.tick(), advance: (ms) => { clock += ms; }, now: () => clock };
}
const lane = (sent) => sent.filter(([ch]) => ch === 'widget:lane-event').map(([, v]) => v);
const ringsSent = (sent) => sent.filter(([ch]) => ch === 'widget:rings').map(([, v]) => v);

test('what is already there at start is not announced; new things are, once', () => {
  const r = rig({ sessions: [{ sessionId: 's1', cwd: '/w/old', signal: 'permission-ask', updatedAt: iso(0) }] });
  assert.deepEqual(lane(r.sent), []);
  assert.equal(r.timers.length, 1);
  r.state.sessions.push({ sessionId: 's2', cwd: '/w/app', signal: 'permission-ask', signalSince: iso(MIN) });
  r.tick();
  r.tick();
  const evs = lane(r.sent);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'needs-you');
  assert.equal(evs[0].text, 'app needs your OK');
  assert.equal(evs[0].sessionId, 's2');
});

test('each source maps to its lane kind', () => {
  const r = rig();
  r.state.sessions = [
    { sessionId: 'f', cwd: '/w/api', signal: 'stop', signalSince: iso(1) },
    { sessionId: 'q', cwd: '/w/web', signal: 'tool-use', updatedAt: iso(2), stuck: { sinceMs: 6 * MIN, tool: 'Bash' } },
    { sessionId: 'remote:x', cwd: '/w/far', signal: 'permission-ask' },
  ];
  r.state.collisions = [{ key: 'k1', path: 'src/a.js', both_mine: false, mine: { session_id: 'f' }, other: { author: 'Sam', title: '' } }];
  r.state.git = [
    { id: 'run:1', signal: 'ci-failed', repo: 'o/r', branch: 'main' },
    { id: 'run:2', signal: 'ci-passed', repo: 'o/r', branch: 'main' },
    { id: 'run:3', signal: 'deploy-failed', repo: 'o/r', restored: true },
  ];
  r.state.team = { looks: [{ id: 'L1', from: 'Ana', question: 'is this right?' }, { id: 'L2', from: 'Bo', handling: true }], waiting: [] };
  r.state.budget = [{ runId: 'run9', text: 'Your AI run reached its budget ($5.00 of $5.00)' }];
  r.tick();
  const byKind = Object.fromEntries(lane(r.sent).map((e) => [`${e.kind}:${e.sessionId}`, e.text]));
  assert.deepEqual(byKind, {
    'finished:f': 'api finished',
    'stuck:q': 'web has gone quiet (last tool Bash)',
    'collision:collision:f': "Sam's session is also editing a.js",
    'ci-failed:ci:o/r:main': 'CI failed · o/r (main)',
    'teammate:look:L1': 'Ana asks you to look: is this right?',
    'needs-you:run:run9': 'Your AI run reached its budget ($5.00 of $5.00)',
  });
  assert.equal(r.api.lane().length, 3, 'main keeps only the last three too');
});

test('the turn ring learns the usual from closed turns and the spend ring follows the budget', () => {
  const r = rig();
  for (let i = 0; i < 3; i += 1) {
    const start = r.now();
    r.state.sessions = [{ sessionId: 'a', signal: 'tool-use', workingSince: iso(start) }];
    r.tick();
    r.advance(2 * MIN);
    r.state.sessions = [{ sessionId: 'a', signal: 'stop', signalSince: iso(r.now()) }];
    r.tick();
  }
  r.state.sessions = [{ sessionId: 'a', signal: 'tool-use', workingSince: iso(r.now()) }];
  r.advance(MIN);
  r.state.spend = { budget: { day: { spent: 9, budget: 10 } } };
  r.tick();
  const last = ringsSent(r.sent).pop();
  assert.equal(last.show, true);
  assert.equal(last.turn.fraction, 0.5);
  assert.equal(last.spend.band, 'amber');
  assert.equal(last.spend.fraction, 0.9);
  const count = ringsSent(r.sent).length;
  r.tick();
  assert.equal(ringsSent(r.sent).length, count, 'unchanged rings are not resent');
});

test('the snapshot handle answers the widget only', async () => {
  const r = rig();
  const h = r.handles.get('widget:lane-state');
  assert.equal(typeof h, 'function');
  assert.equal(await h({ widget: false }), null);
  const s = await h({ widget: true });
  assert.deepEqual(s.lane, []);
  assert.equal(s.rings.show, false);
});

test('a throwing source never stops the others', () => {
  const sent = [];
  const api = LaneMain.install({ send: (ch, v) => sent.push([ch, v]), setInterval: () => null, clearInterval: () => {}, sources: { state: () => { throw new Error('boom'); }, git: { active: () => { throw new Error('gh'); } } } });
  api.tick();
  assert.ok(sent.some(([ch]) => ch === 'widget:rings'));
});

test('main installs it in one line and preload exposes the two channels', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal((main.match(/widget-lane-main\.js/g) || []).length, 1);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /onLaneEvent: \(cb\) => ipcRenderer\.on\('widget:lane-event'/);
  assert.match(preload, /onRings: \(cb\) => ipcRenderer\.on\('widget:rings'/);
});
