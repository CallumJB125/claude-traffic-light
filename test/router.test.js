const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const Router = require('../router.js');
const RI = require('../router-install.js');
const U = require('../usage.js');
const R = require('../rules.js');

const ROUTER = path.join(__dirname, '..', 'router.js');
const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];
const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime();
const DAY = 86400000;
const tmp = (p = 'ctl-router-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// ── decide ──────────────────────────────────────────────────────────────────
const light = { projects: { bondly: { sessions: 5, medianTurns: 12, escalations: 0, lastEscalationAt: null } } };
const heavy = { projects: { bondly: { sessions: 5, medianTurns: 90, escalations: 0, lastEscalationAt: null } } };
const escalated = (ago) => ({ projects: { bondly: { sessions: 5, medianTurns: 12, escalations: 1, lastEscalationAt: NOW - ago } } });
const d = (over = {}) => Router.decide({ cwd: '/Users/x/work/bondly', args: [], env: {}, history: light, config: {}, now: NOW, ...over });

test('decide (a): your own --model / -m / --model=, the off switch and ANTHROPIC_MODEL are left alone', () => {
  for (const args of [['--model', 'opus'], ['-m', 'haiku'], ['--model=sonnet'], ['-p', 'hi', '--model', 'opus']]) assert.equal(d({ args }).model, null, args.join(' '));
  assert.equal(d({ env: { CLAUDE_TRAFFIC_LIGHT_ROUTER: 'off' } }).model, null);
  assert.equal(d({ env: { CLAUDE_TRAFFIC_LIGHT_ROUTER: 'OFF' } }).reason, 'CLAUDE_TRAFFIC_LIGHT_ROUTER=off');
  assert.equal(d({ env: { ANTHROPIC_MODEL: 'claude-opus-5' } }).model, null);
  assert.equal(d({ args: ['-p', 'use the --model flag'] }).model, 'sonnet', 'a prompt that mentions --model is not the flag');
});

test('decide (a): resuming, subcommands, --help and --version are not new sessions', () => {
  for (const args of [['--resume'], ['-r', 'abc'], ['--continue'], ['-c'], ['mcp', 'list'], ['update'], ['--version'], ['-h']]) assert.equal(d({ args }).model, null, args.join(' '));
  assert.equal(d({ args: ['update the readme'] }).model, 'sonnet', 'a prompt starting with a subcommand word is still a prompt');
});

test('decide (b): a per-project override wins over every policy; auto falls through; names match case-insensitively', () => {
  assert.equal(d({ config: { routerProjects: { bondly: 'haiku' }, routerPolicy: 'quality' } }).model, 'haiku');
  assert.equal(d({ config: { routerProjects: { Bondly: 'opus' }, routerPolicy: 'frugal' } }).model, 'opus');
  assert.match(d({ config: { routerProjects: { bondly: 'opus' } } }).reason, /bondly is set to Opus/);
  assert.equal(d({ config: { routerProjects: { bondly: 'auto' } } }).model, 'sonnet');
  assert.equal(d({ config: { routerProjects: { bondly: 'haiku' } }, args: ['--model', 'opus'] }).model, null, '--model still beats the override');
});

test('decide (c) balanced: light project → Sonnet; heavy, unknown or recently escalated → Opus', () => {
  const l = d();
  assert.deepEqual([l.model, l.policy], ['sonnet', 'balanced']);
  assert.match(l.reason, /light project \(median 12 turns over 5 sessions\), no escalations in 7d/);
  assert.equal(d({ history: heavy }).model, 'opus');
  assert.equal(d({ history: null }).model, 'opus');
  assert.equal(d({ cwd: '/elsewhere/new-thing' }).model, 'opus');
  const e = d({ history: escalated(2 * DAY) });
  assert.equal(e.model, 'opus');
  assert.match(e.reason, /switched up/);
  assert.equal(d({ history: escalated(8 * DAY) }).model, 'sonnet', 'the lesson lasts 7 days');
  assert.equal(d({ config: { routerLightTurns: 10 } }).model, 'opus', 'the light threshold is configurable');
});

test('decide (c) frugal: Sonnet unless the project escalated in the last 7 days', () => {
  assert.equal(d({ config: { routerPolicy: 'frugal' }, history: heavy }).model, 'sonnet');
  assert.equal(d({ config: { routerPolicy: 'frugal' }, history: null }).model, 'sonnet');
  assert.equal(d({ config: { routerPolicy: 'frugal' }, history: escalated(DAY) }).model, 'opus');
});

test('decide (c) quality: Opus, even for a light project', () => {
  assert.equal(d({ config: { routerPolicy: 'quality' } }).model, 'opus');
  assert.equal(d({ config: { routerPolicy: 'nonsense' } }).policy, 'balanced');
});

test('decide (d): short -p prompts → Haiku under frugal, Sonnet otherwise; long or fenced prompts use the policy', () => {
  assert.equal(d({ config: { routerPolicy: 'frugal' }, args: ['-p', 'what is 2+2'] }).model, 'haiku');
  assert.equal(d({ config: { routerPolicy: 'balanced' }, args: ['--print', 'what is 2+2'], history: heavy }).model, 'sonnet');
  assert.equal(d({ config: { routerPolicy: 'quality' }, args: ['-p', 'what is 2+2'] }).model, 'sonnet');
  assert.equal(d({ config: { routerPolicy: 'quality' }, args: ['-p', 'x'.repeat(400)] }).model, 'opus');
  assert.equal(d({ config: { routerPolicy: 'frugal' }, args: ['-p', 'fix\n```js\nx\n```'] }).model, 'sonnet');
  assert.equal(d({ config: { routerPolicy: 'balanced' }, args: ['-p'], history: heavy }).model, 'opus', 'a prompt piped on stdin is unknown, not short');
  assert.equal(d({ config: { routerPolicy: 'frugal' }, args: ['-p', '--output-format', 'json', 'hi'] }).model, 'haiku');
});

test('summariseArgs keeps flags but at most 80 characters of prompt text', () => {
  const s = Router.summariseArgs(['-p', 'y'.repeat(200), '--output-format', 'json', '--append-system-prompt', 'secret stuff']);
  assert.ok(s.includes('--output-format json'));
  assert.ok(!s.includes('secret'));
  assert.ok(s.length < 140, s);
  assert.ok(!s.includes('y'.repeat(81)));
});

test('CLI: prints JSON, or model|reason with --sh, and appends a decision line', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ routerPolicy: 'frugal' }));
  const run = (...a) => spawnSync(process.execPath, [ROUTER, 'decide', ...a], { encoding: 'utf8', env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_ROUTER: '', ANTHROPIC_MODEL: '' } });
  const j = JSON.parse(run('--home', home, '--cwd', '/w/bondly', '--', '-p', 'hi').stdout);
  assert.deepEqual(j, { model: 'haiku', reason: 'short one-shot prompt (-p)', policy: 'frugal' });
  assert.equal(run('--sh', '--home', home, '--cwd', '/w/bondly', '--', '--model', 'opus').stdout, '|you picked the model (--model)\n');
  const lines = fs.readFileSync(path.join(home, 'router', 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['args_summary', 'at', 'cwd', 'model', 'policy', 'reason']);
  assert.equal(Router.readDecisions(path.join(home, 'router', 'decisions.jsonl'))[0].model, null, 'newest first');
});

// ── install / uninstall ─────────────────────────────────────────────────────
function opts(home, shell = '/bin/zsh', extra = {}) {
  return { home, root: path.join(home, '.claude-traffic-light'), shellPath: shell, env: {}, platform: 'darwin', routerScript: ROUTER, electron: process.execPath, ...extra };
}

test('install: zsh — shim written executable, block appended once, idempotent both ways', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=1\n');
  const r = RI.install(opts(home));
  assert.equal(r.installed, true);
  assert.equal(r.shell, 'zsh');
  assert.equal(r.rcFile, path.join(home, '.zshrc'));
  assert.ok(fs.statSync(r.shim).mode & 0o111, 'executable');
  const once = fs.readFileSync(r.rcFile, 'utf8');
  assert.ok(once.startsWith('export FOO=1\n'));
  assert.ok(once.includes(`export PATH='${r.binDir}'":$PATH"`));
  assert.equal(RI.install(opts(home)).rcChanged, false, 'second install changes nothing');
  assert.equal(fs.readFileSync(r.rcFile, 'utf8'), once);
  assert.equal(once.split(RI.BEGIN).length, 2);
  const off = RI.uninstall(opts(home));
  assert.equal(off.installed, false);
  assert.equal(fs.existsSync(r.shim), false);
  assert.equal(fs.readFileSync(r.rcFile, 'utf8'), 'export FOO=1\n', 'rc back to how it was');
  assert.deepEqual(RI.uninstall(opts(home)).rcChanged, [], 'second uninstall changes nothing');
});

test('install: a missing rc is created; bash on macOS prefers .bash_profile, Linux .bashrc', () => {
  const zhome = tmp();
  assert.equal(RI.install(opts(zhome)).rcHasBlock, true);
  const bhome = tmp();
  fs.writeFileSync(path.join(bhome, '.bashrc'), '# rc\n');
  assert.equal(RI.install(opts(bhome, '/bin/bash')).rcFile, path.join(bhome, '.bashrc'), 'only .bashrc exists → use it');
  const phome = tmp();
  fs.writeFileSync(path.join(phome, '.bash_profile'), '# profile\n');
  fs.writeFileSync(path.join(phome, '.bashrc'), '# rc\n');
  assert.equal(RI.install(opts(phome, '/usr/local/bin/bash')).rcFile, path.join(phome, '.bash_profile'));
  const lhome = tmp();
  assert.equal(RI.install(opts(lhome, '/bin/bash', { platform: 'linux' })).rcFile, path.join(lhome, '.bashrc'));
});

test('install: fish uses fish_add_path in config.fish; uninstall strips every rc it finds', () => {
  const home = tmp();
  const r = RI.install(opts(home, '/opt/homebrew/bin/fish'));
  assert.equal(r.rcFile, path.join(home, '.config', 'fish', 'config.fish'));
  assert.match(fs.readFileSync(r.rcFile, 'utf8'), /fish_add_path --path --move --prepend '/);
  // The user changed shells since switching on: the old block still goes.
  fs.writeFileSync(path.join(home, '.zshrc'), `a\n${RI.rcBlock('zsh', r.binDir)}b\n`);
  const off = RI.uninstall(opts(home, '/bin/zsh'));
  assert.equal(off.rcChanged.length, 2);
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'a\nb\n');
});

test('install: an unknown shell still writes the shim, touches no rc; baseline is frozen once', () => {
  const home = tmp();
  const r = RI.install(opts(home, '/bin/tcsh', { baseline: { mix: { opus: { share: 1 } }, projects: {} } }));
  assert.equal(r.shell, null);
  assert.equal(r.shimExists, true);
  assert.equal(r.installed, false);
  const frozen = RI.readFrozen(opts(home));
  assert.equal(frozen.mix.opus.share, 1);
  RI.install(opts(home, '/bin/tcsh', { baseline: { mix: { sonnet: { share: 1 } } } }));
  assert.equal(RI.readFrozen(opts(home)).mix.opus.share, 1, 'switching on again keeps the first baseline');
  RI.uninstall(opts(home));
  assert.ok(RI.readFrozen(opts(home)), 'switching off keeps it too');
});

test('install: a symlinked rc stays a symlink', () => {
  const home = tmp();
  const real = path.join(home, 'dotfiles-zshrc');
  fs.writeFileSync(real, 'x\n');
  fs.symlinkSync(real, path.join(home, '.zshrc'));
  RI.install(opts(home));
  assert.ok(fs.lstatSync(path.join(home, '.zshrc')).isSymbolicLink());
  assert.ok(RI.hasBlock(fs.readFileSync(real, 'utf8')));
});

// ── the shim, end to end ────────────────────────────────────────────────────
function shimWorld(extra = {}) {
  const home = tmp('ctl-shim-');
  const o = opts(home, '/bin/zsh', extra);
  const r = RI.install(o);
  const fakeBin = path.join(home, 'real bin');
  fs.mkdirSync(fakeBin);
  const out = path.join(home, 'argv.txt');
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\n{ for a in "$@"; do printf '%s\\n' "$a"; done; printf 'ROUTE=%s\\n' "\${CLAUDE_TRAFFIC_LIGHT_ROUTE:-}"; } > '${out}'\n`);
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  const nodeDir = path.dirname(process.execPath);
  const run = (args, { env = {}, pathDirs = [r.binDir, fakeBin, nodeDir, '/usr/bin', '/bin'], cwd = home } = {}) => {
    fs.rmSync(out, { force: true });
    const res = spawnSync(r.shim, args, { cwd, encoding: 'utf8', env: { HOME: home, PATH: pathDirs.join(':'), ...env } });
    const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n') : null;
    return { ...res, argv: lines && lines.slice(0, -1), route: lines && lines[lines.length - 1].slice(6) };
  };
  return { home, o, r, run, fakeBin, nodeDir };
}

test('shim: prepends --model <pick>, exports the route, logs the decision', () => {
  const w = shimWorld();
  fs.writeFileSync(path.join(w.o.root, 'config.json'), JSON.stringify({ routerPolicy: 'frugal' }));
  const res = w.run(['-p', 'hello there']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.argv, ['--model', 'haiku', '-p', 'hello there']);
  assert.equal(res.route, 'haiku|short one-shot prompt (-p)');
  const log = fs.readFileSync(path.join(w.o.root, 'router', 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.equal(log[0].model, 'haiku');
  assert.equal(log[0].cwd, w.home);
});

test('shim: your own --model passes straight through with no route exported', () => {
  const w = shimWorld();
  const res = w.run(['--model', 'opus', 'do the thing'], { env: { CLAUDE_TRAFFIC_LIGHT_ROUTE: 'sonnet|stale from a parent session' } });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.argv, ['--model', 'opus', 'do the thing']);
  assert.equal(res.route, '');
});

test('shim: reads history.json for the project, keyed by $PWD', () => {
  const w = shimWorld();
  const proj = path.join(w.home, 'bondly');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(w.o.root, 'router', 'history.json'), JSON.stringify({ projects: { bondly: { sessions: 3, medianTurns: 8, escalations: 0 } } }));
  const res = w.run([], { cwd: proj });
  assert.deepEqual(res.argv, ['--model', 'sonnet']);
  assert.match(res.route, /^sonnet\|light project/);
});

test('shim: with no real claude on PATH it fails loudly', () => {
  const w = shimWorld();
  const res = w.run(['x'], { pathDirs: [w.r.binDir, w.nodeDir, '/usr/bin', '/bin'] });
  assert.equal(res.status, 127);
  assert.match(res.stderr, /can't find the real claude/);
});

test('shim: if the router cannot run, claude still starts, unrouted', () => {
  const w = shimWorld({ routerScript: '/nonexistent/router.js' });
  const res = w.run(['hi']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.argv, ['hi']);
  assert.equal(res.route, '');
});

test('shim: with no node on PATH it runs the router through the app binary (ELECTRON_RUN_AS_NODE)', () => {
  const w = shimWorld();
  const res = w.run(['-p', 'hi'], { pathDirs: [w.r.binDir, w.fakeBin, '/usr/bin', '/bin'] });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.argv, ['--model', 'sonnet', '-p', 'hi']);
});

// ── usage: history, escalations, frozen-baseline savings ───────────────────
const turn = (over) => ({ ts: NOW - DAY, sessionId: 's1', project: 'bondly', modelKey: 'sonnet', subagent: false, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...over });

test('projectHistory: sessions, median turns, subagent share and escalations per project', () => {
  const turns = [
    turn({ sessionId: 'a', ts: NOW - 3 * DAY }), turn({ sessionId: 'a', ts: NOW - 3 * DAY + 1 }),
    turn({ sessionId: 'b' }), turn({ sessionId: 'b', ts: NOW - DAY + 1 }), turn({ sessionId: 'b', ts: NOW - DAY + 2, modelKey: 'opus' }), turn({ sessionId: 'b', ts: NOW - DAY + 3, modelKey: 'opus' }),
    turn({ sessionId: 'b', subagent: true, modelKey: 'haiku' }),
    turn({ sessionId: 'c', modelKey: 'opus' }), turn({ sessionId: 'c', ts: NOW - DAY + 5, modelKey: 'sonnet' }),
    turn({ sessionId: 'old', ts: NOW - 9 * DAY }),
    turn({ sessionId: 'x', project: 'other', modelKey: 'opus' }),
  ];
  const h = U.projectHistory(turns, { now: NOW });
  const b = h.projects.bondly;
  assert.equal(b.sessions, 3);
  assert.equal(b.medianTurns, 2);
  assert.equal(b.subagentShare, Math.round((1 / 9) * 1000) / 1000);
  assert.equal(b.escalations, 1, 'sonnet→opus counts; opus→sonnet (c) does not');
  assert.equal(b.lastEscalationAt, NOW - DAY + 2);
  assert.deepEqual(Object.keys(h.escalated), ['b']);
  assert.deepEqual([h.escalated.b.from, h.escalated.b.to], ['sonnet', 'opus']);
  assert.equal(h.projects.other.escalations, 0);
  // …and the router learns from it.
  assert.equal(Router.decide({ cwd: '/w/bondly', history: h, config: { routerPolicy: 'frugal' }, now: NOW }).model, 'opus');
});

test('projectMix and sinceRouting: spend since switch-on vs the frozen mix, as a range', () => {
  const before = [turn({ modelKey: 'opus', ts: NOW - 5 * DAY }), turn({ modelKey: 'opus', ts: NOW - 5 * DAY }), turn({ modelKey: 'sonnet', ts: NOW - 5 * DAY }), turn({ modelKey: 'opus', project: 'other', ts: NOW - 5 * DAY })];
  const mix = U.projectMix(before, { now: NOW - 4 * DAY });
  assert.equal(mix.bondly.turns, 3);
  assert.ok(Math.abs(mix.bondly.mix.opus.share - 2 / 3) < 1e-9);
  const frozen = { mix: { opus: { share: 1 } }, projects: mix };
  // After: one bondly turn on Sonnet ($2 at 1M input); at the frozen mix
  // it would have been 2/3 × $5 + 1/3 × $2 = $4.
  const s = U.sinceRouting([...before, turn({ ts: NOW - DAY })], { since: NOW - 2 * DAY, frozen, now: NOW });
  assert.equal(s.turns, 1);
  assert.equal(s.actual, 2);
  assert.equal(s.atBaseline, 4);
  assert.equal(s.saved.high, 2);
  assert.equal(s.saved.low, Math.round((4 / U.SLACK - 2) * 1e4) / 1e4);
  // A project with no frozen mix of its own uses the overall one; a turn
  // that cost more than its baseline counts against the saving in full.
  const t = U.sinceRouting([turn({ project: 'fresh', modelKey: 'opus' })], { since: NOW - 2 * DAY, frozen: { mix: { sonnet: { share: 1 } } }, now: NOW });
  assert.equal(t.saved.low, -3);
  assert.equal(t.saved.high, -3);
});

// ── rules: the routing virtual signals ──────────────────────────────────────
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

// ── hooks: the route rides in on the environment ────────────────────────────
test('set-status: stores the route from CLAUDE_TRAFFIC_LIGHT_ROUTE and carries it (and escalated) through', () => {
  const home = tmp('ctl-state-');
  const file = path.join(home, 'sessions', `${HOST}-r1.json`);
  const hook = (signal, env) => {
    const r = spawnSync(process.execPath, [SET_STATUS, signal], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ROUTE: '', ...env }, input: JSON.stringify({ session_id: 'r1', cwd: '/w/bondly' }) });
    assert.equal(r.status, 0, r.stderr.toString());
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  assert.deepEqual(hook('session-start', { CLAUDE_TRAFFIC_LIGHT_ROUTE: 'sonnet|light project, no escalations in 7d' }).route, { model: 'sonnet', reason: 'light project, no escalations in 7d' });
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...s, escalated: true }));
  const later = hook('prompt-submit', {});
  assert.equal(later.route.model, 'sonnet', 'carried through a hook without the env');
  assert.equal(later.escalated, true);
  const home2 = tmp('ctl-state-');
  const r = spawnSync(process.execPath, [SET_STATUS, 'session-start'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home2, CLAUDE_TRAFFIC_LIGHT_ROUTE: 'gpt|nope' }, input: JSON.stringify({ session_id: 'r2' }) });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home2, 'sessions', `${HOST}-r2.json`), 'utf8')).route, undefined, 'only real models');
});
