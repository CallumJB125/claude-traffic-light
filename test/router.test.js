// The model router is gone: what stays is the read-only Model mix card, the
// note about a leftover shim block, and the (now opt-in, inert) rule signals
// a routed session used to fire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const U = require('../usage.js');
const R = require('../rules.js');
const LeftoverShim = require('../src/leftover-shim.js');

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];
const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime();
const DAY = 86400000;
const tmp = (p = 'ctl-router-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('rules: routed-cheap fires for Sonnet/Haiku routes, escalated replaces it; both are listed', () => {
  const v = (s) => R.virtualSessions([{ signal: 'tool-use', cwd: '/w/bondly', ...s }]).map((x) => x.signal);
  assert.deepEqual(v({ route: { model: 'sonnet' } }), ['routed-cheap']);
  assert.deepEqual(v({ route: { model: 'haiku' } }), ['routed-cheap']);
  assert.deepEqual(v({ route: { model: 'opus' } }), []);
  assert.deepEqual(v({}), []);
  assert.deepEqual(v({ route: { model: 'sonnet' }, escalated: true }), ['escalated']);
  for (const id of ['routed-cheap', 'escalated']) assert.ok(R.SIGNALS.some((s) => s.id === id && s.kind === 'virtual'));
  assert.ok(!R.defaultRules().some((r) => r.when.signal.includes('routed-cheap') || r.when.signal.includes('escalated')), 'opt-in only');
  const rule = { id: 'rc', name: 'Routed cheap', when: { signal: ['routed-cheap'] }, then: { eyes: '#2dd4bf' } };
  const { look } = R.resolve([rule, ...R.defaultRules()], [{ signal: 'tool-use', tool: 'Bash', route: { model: 'sonnet' }, updatedAt: new Date().toISOString() }]);
  assert.equal(look.eyes, '#2dd4bf');
  assert.equal(look.lamp, 'green');
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

// ── Leftover shim: detected read-only, never edited ─────────────────────────
test('leftover shim: an rc block is found and the exact removal command given; nothing is edited', () => {
  const home = tmp();
  const zshrc = path.join(home, '.zshrc');
  const text = `export A=1\n\n${LeftoverShim.BEGIN}\nexport PATH='${home}/.claude-traffic-light/bin'":$PATH"\n${LeftoverShim.END}\n`;
  fs.writeFileSync(zshrc, text);
  fs.mkdirSync(path.join(home, '.claude-traffic-light', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-traffic-light', 'bin', 'claude'), '#!/bin/sh\n');
  const r = LeftoverShim.detect({ home, env: {}, platform: 'darwin' });
  assert.deepEqual(r.files, [zshrc]);
  assert.equal(r.command, `sed -i '' '/^# claude-buddy router >>>$/,/^# claude-buddy router <<<$/d' '${zshrc}' && rm -f '${home}/.claude-traffic-light/bin/claude'`);
  assert.match(r.note, /~\/\.zshrc/);
  assert.equal(fs.readFileSync(zshrc, 'utf8'), text, 'the rc file is untouched');
  assert.match(LeftoverShim.detect({ home, env: {}, platform: 'linux' }).command, /^sed -i '\/\^# claude/);
  // The command really does remove exactly the block.
  const run = spawnSync('/bin/sh', ['-c', LeftoverShim.detect({ home, env: {} }).command]);
  assert.equal(run.status, 0, run.stderr.toString());
  assert.equal(fs.readFileSync(zshrc, 'utf8'), 'export A=1\n\n');
  assert.equal(LeftoverShim.detect({ home, env: {} }), null);
});

test('leftover shim: bash, fish (XDG) and a clean home', () => {
  const home = tmp();
  assert.equal(LeftoverShim.detect({ home, env: {} }), null);
  const xdg = path.join(home, 'xdg');
  fs.mkdirSync(path.join(xdg, 'fish'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'fish', 'config.fish'), `${LeftoverShim.BEGIN}\nfish_add_path x\n${LeftoverShim.END}\n`);
  fs.writeFileSync(path.join(home, '.bashrc'), `# mine\n${LeftoverShim.BEGIN}\nexport PATH=x\n${LeftoverShim.END}\n`);
  const r = LeftoverShim.detect({ home, env: { XDG_CONFIG_HOME: xdg }, platform: 'linux' });
  assert.deepEqual(r.files, [path.join(home, '.bashrc'), path.join(xdg, 'fish', 'config.fish')]);
  assert.equal(r.shim, null);
  assert.equal(r.command.split(' && ').length, 2);
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
