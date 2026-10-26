const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const Cli = require('../src/cli.js');
const pkg = require('../package.json');

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function fixture({ sessions = {}, requests = [], handovers = {}, config = { seasonal: false } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-cli-'));
  temps.push(home);
  const root = path.join(home, '.claude-traffic-light');
  for (const d of ['sessions', 'requests', 'handovers']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  for (const [name, data] of Object.entries(sessions)) fs.writeFileSync(path.join(root, 'sessions', `${name}.json`), JSON.stringify(data));
  for (const r of requests) fs.writeFileSync(path.join(root, 'requests', `${r.id}.json`), JSON.stringify(r));
  for (const [key, text] of Object.entries(handovers)) fs.writeFileSync(path.join(root, 'handovers', `${key}.md`), text);
  fs.mkdirSync(path.join(home, 'projects'));
  return { home, root };
}
const session = (id, extra = {}) => ({ sessionId: id, host: 'h', cwd: `/w/${id}`, signal: 'tool-use', tool: 'Bash', updatedAt: iso(1000), ...extra });
const LIVE = { look: { lamp: 'green', pose: 'typing' }, sessions: [], spend: null };

async function cli(argv, { home, live = null, health } = {}) {
  let out = '', err = '';
  const code = await Cli.run({
    argv, env: {}, home, cwd: home, now: NOW,
    out: (s) => { out += s; }, err: (s) => { err += s; },
    fetchLive: async () => live,
    health: health || (async () => ({ ok: true, problems: 0, checks: [{ id: 'last-hook', label: 'Last hook event', status: 'ok', detail: '2 min ago' }] })),
    projectsDir: path.join(home, 'projects'),
  });
  return { code, out, err, json: () => JSON.parse(out) };
}

test('parseArgs: commands, flags, values and their errors', () => {
  assert.equal(Cli.parseArgs([]).command, 'help');
  assert.equal(Cli.parseArgs(['status', '--help']).command, 'help');
  const a = Cli.parseArgs(['spend', '--today', '--json']);
  assert.deepEqual([a.command, a.json, a.flags.today], ['spend', true, true]);
  const h = Cli.parseArgs(['handover', 'abc123', '--out', 'x.md', '--force']);
  assert.deepEqual([h.positional, h.values.out, h.flags.force], [['abc123'], 'x.md', true]);
  assert.equal(Cli.parseArgs(['handover', 'abc', '--out=y.md']).values.out, 'y.md');
  assert.throws(() => Cli.parseArgs(['nope']), /unknown command/);
  assert.throws(() => Cli.parseArgs(['spend', '--today', '--week']), /not both/);
  assert.throws(() => Cli.parseArgs(['status', '--all']), /unknown option --all/);
  assert.throws(() => Cli.parseArgs(['sessions', 'extra']), /unexpected argument/);
  assert.throws(() => Cli.parseArgs(['handover', 'a', 'b']), /one session id/);
  assert.throws(() => Cli.parseArgs(['handover', 'a', '--out']), /needs a value/);
});

test('bad arguments exit 2 with usage on stderr; help exits 0', async () => {
  const { home } = fixture();
  const bad = await cli(['frobnicate'], { home });
  assert.equal(bad.code, Cli.EXIT.ERROR);
  assert.match(bad.err, /unknown command "frobnicate"[\s\S]*Usage: plexiform/);
  assert.equal(bad.out, '');
  const help = await cli(['--help'], { home });
  assert.equal(help.code, 0);
  assert.match(help.out, /Exit codes: 0 ok, 1 Plexiform is not running/);
});

test('status --json: shape, what needs you, and app running', async () => {
  const { home } = fixture({ sessions: {
    a: session('a'),
    b: session('b', { signal: 'permission-ask', askKind: 'question', cwd: '/w/proj-b' }),
  } });
  const r = await cli(['status', '--json'], { home, live: LIVE });
  assert.equal(r.code, 0);
  const j = r.json();
  assert.equal(j.ok, true);
  assert.equal(j.command, 'status');
  assert.deepEqual(j.app, { running: true, port: 47172 });
  assert.equal(j.source, 'app');
  assert.equal(j.light, 'green');
  assert.equal(j.sessionCount, 2);
  assert.equal(j.waiting.count, 1);
  assert.deepEqual(Object.keys(j.waiting.sessions[0]).sort(), ['ageMs', 'askKind', 'cwd', 'project', 'sessionId', 'signal', 'source', 'tool', 'updatedAt']);
  assert.equal(j.waiting.sessions[0].sessionId, 'b');
  assert.equal(j.waiting.sessions[0].project, 'proj-b');
  assert.equal(j.readyForReview, 0);
  assert.equal(j.note, undefined);
});

test('not running: status, sessions, waiting and doctor answer from disk and exit 1', async () => {
  const { home } = fixture({ sessions: { a: session('a', { signal: 'stop' }) } });
  for (const cmd of ['status', 'sessions', 'waiting', 'doctor']) {
    const r = await cli([cmd, '--json'], { home, live: null });
    assert.equal(r.code, Cli.EXIT.NOT_RUNNING, cmd);
    const j = r.json();
    assert.equal(j.ok, true, cmd);
    assert.equal(j.app.running, false, cmd);
    assert.match(j.note, /not running: read from .* on disk/, cmd);
  }
  const human = await cli(['status'], { home, live: null });
  assert.equal(human.code, 1);
  assert.match(human.out, /Nothing needs you\.\n1 session finished its turn without needing anything: ready for review\./);
  assert.match(human.out, /Plexiform is not running: read from ~\/\.claude-traffic-light on disk\./);
  assert.match((await cli(['status', '--short'], { home })).out, / · 1 session · 1 ready for review · app not running\n$/);
});

test('not running with no data folder says so', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-cli-empty-'));
  temps.push(home);
  const r = await cli(['sessions'], { home });
  assert.equal(r.code, 1);
  assert.match(r.out, /No running sessions\.\nPlexiform is not running, and there is no data folder at ~\/\.claude-traffic-light\./);
  assert.equal(fs.existsSync(path.join(home, '.claude-traffic-light')), false);
});

test('sessions --all includes ignored files with the reason', async () => {
  const { home } = fixture({ sessions: { a: session('a'), old: session('old', { updatedAt: iso(3600000) }) } });
  const live = (await cli(['sessions', '--json'], { home, live: LIVE })).json();
  assert.deepEqual(live.sessions.map((s) => s.sessionId), ['a']);
  const all = (await cli(['sessions', '--all', '--json'], { home, live: LIVE })).json();
  assert.deepEqual(all.sessions.map((s) => [s.sessionId, s.live]), [['a', true], ['old', false]]);
  assert.match(all.sessions[1].dropped, /stale/);
});

test('waiting: permission requests and asking sessions', async () => {
  const { home } = fixture({
    sessions: { q: session('q', { signal: 'permission-ask', askKind: 'question' }) },
    requests: [{ id: 'r1', sessionId: 'q', cwd: '/w/q', tool: 'Bash', summary: 'rm -rf build', createdAt: iso(5000) }],
  });
  const j = (await cli(['waiting', '--json'], { home, live: LIVE })).json();
  assert.equal(j.count, 1, 'the request belongs to the asking session: counted once');
  assert.equal(j.requests.length, 1);
  assert.equal(j.sessions[0].sessionId, 'q');
  assert.deepEqual(Object.keys(j.requests[0]).sort(), ['ageMs', 'cwd', 'hookWaitsMsMore', 'id', 'project', 'sessionId', 'summary', 'tool']);
  assert.equal((await cli(['waiting', '--short'], { home, live: LIVE })).out, '1 needs you\n');
});

test('status and waiting agree on what needs you; finished turns are ready for review', async () => {
  const { home } = fixture({
    sessions: {
      ask: session('ask', { signal: 'permission-ask', askKind: 'permission' }),
      q: session('q', { signal: 'permission-ask', askKind: 'question' }),
      done: session('done', { signal: 'stop', updatedAt: iso(3 * 3600000) }),
      nudged: session('nudged', { signal: 'idle-nudge' }),
      busy: session('busy'),
    },
    requests: [
      { id: 'r1', sessionId: 'ask', cwd: '/w/ask', tool: 'Bash', summary: 'npm test', createdAt: iso(5000) },
      { id: 'r2', sessionId: 'elsewhere', cwd: '/w/x', tool: 'Edit', summary: 'edit a file', createdAt: iso(5000) },
    ],
  });
  const st = (await cli(['status', '--json'], { home, live: LIVE })).json();
  const wt = (await cli(['waiting', '--json'], { home, live: LIVE })).json();
  assert.equal(st.waiting.count, 3);
  assert.equal(wt.count, st.waiting.count);
  assert.deepEqual(wt.sessions, st.waiting.sessions);
  assert.deepEqual(wt.requests, st.waiting.requests);
  assert.deepEqual(st.waiting.sessions.map((s) => s.sessionId).sort(), ['ask', 'q']);
  assert.equal(st.readyForReview, 2);
  assert.equal(wt.readyForReview, 2);
  const short = (await cli(['status', '--short'], { home, live: LIVE })).out;
  assert.match(short, / · 3 need you · 2 ready for review\n$/);
  assert.equal((await cli(['waiting', '--short'], { home, live: LIVE })).out, '3 need you\n');
  const human = (await cli(['status'], { home, live: LIVE })).out;
  assert.doesNotMatch(human, /Needs you:[^]*finished its turn/);
  assert.match(human, /2 sessions finished their turns without needing anything: ready for review\./);

  const calm = fixture({ sessions: { done: session('done', { signal: 'stop' }) } });
  assert.match((await cli(['status', '--short'], { home: calm.home, live: LIVE })).out, / · 1 ready for review\n$/);
  assert.equal((await cli(['waiting', '--short'], { home: calm.home, live: LIVE })).out, 'Nothing needs you\n');
});

test('spend --today: JSON has today only and needs no app', async () => {
  const { home } = fixture();
  const r = await cli(['spend', '--today', '--json'], { home, live: null });
  assert.equal(r.code, 0);
  const j = r.json();
  assert.equal(j.command, 'spend');
  assert.equal(j.app, undefined);
  assert.equal(j.today.spent, 0);
  assert.equal(j.week, undefined);
  assert.ok(Array.isArray(j.runaway));
  assert.match((await cli(['spend', '--week', '--short'], { home })).out, /^This week: \$0\.00\n$/);
});

test('handover: lists, prints by session prefix, writes with --out, refuses to overwrite', async () => {
  const { home } = fixture({ handovers: { 'claude-code-abc123def': '# Handover\nfacts\n', 'codex-zzz999': '# Other\n' } });
  const list = (await cli(['handover', '--json'], { home })).json();
  assert.deepEqual(list.handovers.map((h) => h.key).sort(), ['claude-code-abc123def', 'codex-zzz999']);
  const shown = await cli(['handover', 'abc123'], { home });
  assert.equal(shown.code, 0);
  assert.equal(shown.out, '# Handover\nfacts\n');
  const w = await cli(['handover', 'abc123', '--out', 'h.md', '--json'], { home });
  assert.equal(w.json().written, path.join(home, 'h.md'));
  assert.equal(fs.readFileSync(path.join(home, 'h.md'), 'utf8'), '# Handover\nfacts\n');
  assert.equal((await cli(['handover', 'abc123', '--out', 'h.md'], { home })).code, 2);
  assert.equal((await cli(['handover', 'abc123', '--out', 'h.md', '--force'], { home })).code, 0);
  const missing = await cli(['handover', 'nothere'], { home });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no handover for "nothere"/);
  assert.equal((await cli(['handover', '../etc'], { home })).code, 2);
});

test('doctor: app and hook state from the health checks', async () => {
  const { home } = fixture();
  const r = await cli(['doctor', '--json'], { home, live: LIVE, health: async () => ({ ok: false, problems: 1, checks: [{ id: 'last-hook', label: 'Last hook event', status: 'warn', detail: 'None recorded yet.', next: 'Fix the hooks first.' }] }) });
  assert.equal(r.code, 0);
  const j = r.json();
  assert.deepEqual(j.hook, { status: 'warn', detail: 'None recorded yet.' });
  assert.equal(j.healthy, false);
  assert.equal(j.dataDirExists, true);
  const human = await cli(['doctor'], { home, live: LIVE });
  assert.match(human.out, /^App: {3}running \(port 47172\)\nHook: {2}ok · 2 min ago/);
});

// Coordination-only use (plan-orchestrator "Product principle"): the wrapper is optional. No other command mentions
// it, prompts, or reaches the Tasks helper; only help lists it.
test('the run wrapper never nags: other commands neither mention it nor connect to Tasks', async () => {
  const { home } = fixture({ sessions: { a: session('a') } });
  let connected = 0;
  const seen = [];
  for (const argv of [['status'], ['sessions'], ['waiting'], ['doctor'], ['spend'], ['handover'], ['status', '--json']]) {
    let out = '', err = '';
    const code = await Cli.run({
      argv, env: {}, home, cwd: home, now: NOW, out: (x) => { out += x; }, err: (x) => { err += x; },
      fetchLive: async () => LIVE, health: async () => ({ ok: true, problems: 0, checks: [] }), projectsDir: path.join(home, 'projects'),
      tty: true, prompt: async () => { throw new Error(`${argv.join(' ')} prompted`); }, connectTasks: async () => { connected++; throw new Error('connected'); },
    });
    seen.push(code);
    assert.doesNotMatch(out + err, /plexiform run|\brun\b.*wrapper/i, argv.join(' '));
  }
  assert.equal(connected, 0);
  assert.ok(seen.every((c) => c === 0 || c === 1), String(seen));
  assert.match((await cli(['help'], { home })).out, /plexiform run/);
});

test('errors inside a command exit 2 with a JSON error', async () => {
  const { home } = fixture();
  const r = await cli(['doctor', '--json'], { home, health: async () => { throw new Error('boom'); } });
  assert.equal(r.code, 2);
  assert.deepEqual(r.json(), { ok: false, command: 'doctor', error: 'boom' });
});

test('the port comes from the app\'s port file when there is one', () => {
  const { root } = fixture();
  assert.equal(Cli.portOf(root, {}), 47172);
  assert.equal(Cli.portOf(root, { CLAUDE_TRAFFIC_LIGHT_PORT: '5000' }), 5000);
  fs.writeFileSync(path.join(root, 'port'), '47999');
  assert.equal(Cli.portOf(root, { CLAUDE_TRAFFIC_LIGHT_PORT: '5000' }), 47999);
});

test('packaging: bin entry, build files and the unpacked launcher', () => {
  assert.equal(pkg.bin.plexiform, 'bin/plexiform.js');
  assert.ok(pkg.build.files.includes('bin/**/*'));
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'bin' && r.to === 'bin'));
  const config = require('../electron-builder.config.js');
  assert.ok(config.files.includes('bin/**/*'));
  for (const f of ['bin/plexiform', 'bin/plexiform.js']) assert.ok(fs.statSync(path.join(__dirname, '..', f)).mode & 0o111, `${f} is executable`);
});

test('the launcher runs through a symlink and exits 1 when the app is not running', () => {
  const { home } = fixture();
  const link = path.join(home, 'plexiform');
  fs.symlinkSync(path.join(__dirname, '..', 'bin', 'plexiform'), link);
  const r = spawnSync(link, ['sessions', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_TRAFFIC_LIGHT_HOME: path.join(home, '.claude-traffic-light'), CLAUDE_TRAFFIC_LIGHT_PORT: '1' } });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).app.running, false);
});

test('raycast scripts carry their metadata and call the CLI', () => {
  const dir = path.join(__dirname, '..', 'raycast');
  for (const [file, title] of [['plexiform-status.sh', 'Plexiform Status'], ['plexiform-needs-me.sh', 'Needs Me'], ['plexiform-spend-today.sh', 'Spend Today']]) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(text, /^#!\/bin\/bash\n/);
    assert.match(text, /# @raycast\.schemaVersion 1\n/);
    assert.match(text, new RegExp(`# @raycast\\.title ${title}\\n`));
    assert.match(text, /# @raycast\.mode (inline|compact|fullOutput)\n/);
    assert.match(text, /"\$PLEXIFORM" /);
    assert.ok(fs.statSync(path.join(dir, file)).mode & 0o111, `${file} is executable`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
});

test('waiting: a Codex permission wait with no request file counts once, as Home Needs you does', async () => {
  const s = session('c1', { source: 'codex', signal: 'permission-ask', askKind: 'request', signalSince: iso(1000) });
  const { home } = fixture({ sessions: { c1: s } });
  const j = (await cli(['waiting', '--json'], { home, live: LIVE })).json();
  assert.equal(j.count, 1);
  const inputs = require('../src/pending-inputs.js').collect({ sessions: [s], now: NOW });
  assert.equal(require('../src/home-main.js').needs(inputs, NOW).total, j.count);
});
