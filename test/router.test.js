// The model router is gone: what stays is the read-only Model mix card and
// the (now opt-in, inert) rule signals a routed session used to fire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const U = require('../usage.js');
const R = require('../rules.js');

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];
const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime();
const DAY = 86400000;
const tmp = (p = 'ctl-router-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('rules v6: the router signals are gone, and saved rules using them are dropped or disabled', () => {
  for (const id of ['routed-cheap', 'escalated', 'delegated-read']) assert.ok(!R.SIGNALS.some((s) => s.id === id), id);
  assert.ok(R.RULES_VERSION >= 6);
  const saved = [
    { id: 'routed', name: 'Routed cheap', enabled: true, when: { signal: ['routed-cheap'] }, then: { eyes: '#2dd4bf' } },
    { id: 'delegated', name: 'Buddy delegated a read', enabled: true, when: { signal: ['delegated-read'] }, then: { pose: 'munch' } },
    { id: 'mine', name: 'Mine', enabled: true, when: { signal: ['escalated'] }, then: { pose: 'wave' } },
    { id: 'mix', name: 'Mix', enabled: true, when: { signal: ['stop', 'routed-cheap'] }, then: { pose: 'wave' } },
    ...R.defaultRules(),
  ].map(R.normalizeRule);
  const out = R.migrateRules(saved, 5);
  assert.ok(!out.some((r) => r.id === 'routed' || r.id === 'delegated'), 'default rules using them are dropped');
  const mine = out.find((r) => r.id === 'mine');
  assert.equal(mine.enabled, false);
  assert.deepEqual(mine.when.signal, []);
  const mix = out.find((r) => r.id === 'mix');
  assert.equal(mix.enabled, true);
  assert.deepEqual(mix.when.signal, ['stop']);
  assert.equal(R.migrateRules(saved, R.RULES_VERSION), saved);
});

// ── set-status no longer carries router state ───────────────────────────────
test('set-status: a leftover CLAUDE_TRAFFIC_LIGHT_ROUTE is ignored; no route, advice or delegation fields are written', () => {
  const home = tmp();
  const r = spawnSync(process.execPath, [SET_STATUS, 'tool-use'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ROUTE: 'sonnet|light project' }, input: JSON.stringify({ session_id: 'r1', cwd: '/w/p', tool_name: 'Bash' }) });
  assert.equal(r.status, 0, r.stderr.toString());
  const d = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${HOST}-r1.json`), 'utf8'));
  assert.equal(d.signal, 'tool-use');
  for (const k of ['route', 'escalated', 'delegated', 'delegating', 'routerAdvice', 'adviceKept']) assert.equal(d[k], undefined, k);
  assert.equal(fs.existsSync(path.join(home, 'router')), false, 'nothing under router/');
});

// ── Model mix ───────────────────────────────────────────────────────────────
const turn = (over) => ({ ts: NOW - 3600000, sessionId: 's', project: 'p', model: 'claude-opus-4-1', modelKey: 'opus', subagent: false, input: 100, output: 200, cacheRead: 20000, cacheWrite: 500, cacheWrite1h: 0, ...over });

test('modelMix: per-model turns and cost today and over 7 days, oldest turns excluded', () => {
  const turns = [
    turn({}),
    turn({ model: 'claude-sonnet-4-5', modelKey: 'sonnet' }),
    turn({ ts: NOW - 3 * DAY }),
    turn({ ts: NOW - 10 * DAY }),
    turn({ model: 'gpt-x', modelKey: null }),
  ];
  const m = U.modelMix(turns, { now: NOW });
  assert.equal(m.today.turns, 2);
  assert.equal(m.week.turns, 3);
  assert.deepEqual(m.week.models.map((x) => [x.name, x.turns]), [['opus', 2], ['sonnet', 1]]);
  const opusCost = U.costOf(turn({}));
  assert.equal(m.week.models[0].cost, Math.round(2 * opusCost * 100) / 100);
  assert.ok(Math.abs(m.week.models[0].share - 2 / 3) < 1e-9);
});

test('modelMix: the recommendation counts routine Opus turns and prices them at Sonnet, as a range', () => {
  const routine = turn({});
  const heavy = turn({ output: 3000, input: 9000 });
  const m = U.modelMix([routine, routine, heavy, turn({ model: 'claude-sonnet-4-5', modelKey: 'sonnet' })], { now: NOW });
  assert.deepEqual([m.opus.turns, m.opus.routine], [3, 2]);
  const high = 2 * (U.costOf(routine) - U.costOf(routine, 'sonnet'));
  const low = 2 * Math.max(0, U.costOf(routine) - U.costOf(routine, 'sonnet') * U.SLACK);
  assert.equal(m.opus.saving.high, Math.round(high * 100) / 100);
  assert.equal(m.opus.saving.low, Math.round(low * 100) / 100);
  assert.match(m.recommendation, /^67% of your Opus turns in the last 7 days looked routine .* on Sonnet they would have cost about \$[\d.]+(–\$[\d.]+)? less\.$/);
  assert.match(U.modelMix([heavy], { now: NOW }).recommendation, /well spent/);
  assert.match(U.modelMix([], { now: NOW }).recommendation, /No Opus turns/);
});
