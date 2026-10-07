// Per-turn checkpoints, against throwaway repos in a temp folder only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const CheckpointGit = require('../src/checkpoint-git');
const { createCheckpoints, createTurnWatcher, turnStep } = require('../src/checkpoints');

const GIT = CheckpointGit.findGit();
const skip = GIT ? false : 'git not installed';
const TMP = fs.realpathSync(os.tmpdir());
const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(TMP, prefix)); made.push(d); return d; };
const HOME = tmp('cp-home-');
const ENV = { HOME, PATH: process.env.PATH, TMPDIR: TMP, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const sh = (cwd, ...args) => execFileSync(GIT, args, { cwd, env: ENV, encoding: 'utf8' });
const write = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function repo() {
  const dir = tmp('cp-repo-');
  sh(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.txt', 'one\n');
  write(dir, 'b.txt', 'bee\n');
  write(dir, '.gitignore', 'secret.env\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'init');
  return dir;
}
function ents({ turns = Infinity, days = 7, review = false } = {}) {
  return { has: (f) => f === 'checkpoints' || (f === 'checkpoints.review' && review), limits: () => ({ 'checkpoints.turns': turns, 'checkpoints.days': days }) };
}
function setup(opts = {}) {
  const rootDir = tmp('cp-root-');
  const git = CheckpointGit.createGit({ env: ENV, tmpdir: TMP });
  const cps = createCheckpoints({ rootDir, entitlements: ents(opts), git, ...opts.extra });
  cps.setConfig({ enabled: true });
  return { cps, git, rootDir };
}
const cpRefs = (dir) => sh(dir, 'for-each-ref', '--format=%(refname)', 'refs/plexiform/cp/').split('\n').filter(Boolean);

test('two turns leave two refs; index, HEAD and status are untouched', { skip }, async () => {
  const dir = repo();
  write(dir, 'a.txt', 'one staged\n'); sh(dir, 'add', 'a.txt'); // a staged change the user has
  write(dir, 'untracked.txt', 'mine\n');
  write(dir, 'secret.env', 'TOKEN=x\n');
  const head = sh(dir, 'rev-parse', 'HEAD'), idx = hash(path.join(dir, '.git/index')), status = sh(dir, 'status', '--porcelain');
  const { cps } = setup();
  const sid = 'sess-1';
  assert.deepEqual(await cps.turnStart({ sessionId: sid, cwd: dir }), { turn: 1 });
  write(dir, 'a.txt', 'turn one\n'); fs.unlinkSync(path.join(dir, 'b.txt')); write(dir, 'new/c.txt', 'sea\n');
  assert.deepEqual(await cps.turnEnd({ sessionId: sid, cwd: dir }), { turn: 1 });
  await cps.turnStart({ sessionId: sid, cwd: dir });
  write(dir, 'a.txt', 'turn two\n');
  await cps.turnEnd({ sessionId: sid, cwd: dir });

  assert.deepEqual(cpRefs(dir), ['refs/plexiform/cp/sess-1/t000001', 'refs/plexiform/cp/sess-1/t000002']);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(hash(path.join(dir, '.git/index')), idx, 'user index byte-identical');
  assert.equal(sh(dir, 'branch', '--list').trim(), '* main');
  assert.notEqual(sh(dir, 'status', '--porcelain'), status); // the working tree changed, by the "AI"
  assert.equal(sh(dir, 'stash', 'list'), '');

  const { turns } = await cps.turns(sid);
  assert.deepEqual(turns.map((t) => t.turn), [2, 1]);
  const t1 = turns[1].files.map((f) => `${f.status} ${f.path}`).sort();
  assert.deepEqual(t1, ['A new/c.txt', 'D b.txt', 'M a.txt']);
  const d = await cps.diff(sid, 1, 'a.txt');
  assert.match(d.text, /-one staged\n\+turn one/);
  // ignored files are never captured
  const tree = sh(dir, 'ls-tree', '-r', '--name-only', 'refs/plexiform/cp/sess-1/t000002');
  assert.ok(!tree.includes('secret.env') && tree.includes('untracked.txt'));
});

test('restore to before turn 1 saves a safety checkpoint first and reproduces tracked + untracked state', { skip }, async () => {
  const dir = repo();
  write(dir, 'untracked.txt', 'mine\n');
  write(dir, 'secret.env', 'keep\n');
  const { cps } = setup();
  const sid = 'sess-r';
  await cps.turnStart({ sessionId: sid, cwd: dir });
  write(dir, 'a.txt', 'changed\n'); fs.unlinkSync(path.join(dir, 'b.txt')); fs.unlinkSync(path.join(dir, 'untracked.txt')); write(dir, 'deep/x/new.txt', 'n\n');
  await cps.turnEnd({ sessionId: sid, cwd: dir });
  await cps.turnStart({ sessionId: sid, cwd: dir });
  write(dir, 'a.txt', 'changed again\n'); write(dir, 'second.txt', 's\n');
  await cps.turnEnd({ sessionId: sid, cwd: dir });
  const idx = hash(path.join(dir, '.git/index')), head = sh(dir, 'rev-parse', 'HEAD');

  const r = await cps.restore(sid, { turn: 1, which: 'before' });
  assert.equal(r.ok, true);
  assert.equal(read(dir, 'a.txt'), 'one\n');
  assert.equal(read(dir, 'b.txt'), 'bee\n');
  assert.equal(read(dir, 'untracked.txt'), 'mine\n');
  assert.equal(read(dir, 'deep/x/new.txt'), null);
  assert.ok(!fs.existsSync(path.join(dir, 'deep')), 'emptied folders are removed');
  assert.equal(read(dir, 'second.txt'), null);
  assert.equal(read(dir, 'secret.env'), 'keep\n', 'ignored files are left alone');
  assert.equal(hash(path.join(dir, '.git/index')), idx);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
  const safety = cpRefs(dir).filter((x) => x.includes('/safety-'));
  assert.equal(safety.length, 1);
  assert.equal(sh(dir, 'show', `${safety[0]}:a.txt`), 'changed again\n', 'safety holds the state before the restore');

  // undo the undo
  const back = await cps.restore(sid, { safety: r.safety });
  assert.equal(back.ok, true);
  assert.equal(read(dir, 'a.txt'), 'changed again\n');
  assert.equal(read(dir, 'second.txt'), 's\n');
  assert.equal(read(dir, 'deep/x/new.txt'), 'n\n');
  assert.equal(read(dir, 'b.txt'), null);
  assert.equal(read(dir, 'untracked.txt'), null);

  const after1 = await cps.restore(sid, { turn: 1, which: 'after' });
  assert.equal(after1.ok, true);
  assert.equal(read(dir, 'a.txt'), 'changed\n');
  assert.equal(read(dir, 'second.txt'), null);
});

test('restore refuses while a turn is running in that repo', { skip }, async () => {
  const dir = repo();
  const { cps } = setup({ extra: { isBusy: async () => true } });
  await cps.turnStart({ sessionId: 's', cwd: dir });
  await cps.turnEnd({ sessionId: 's', cwd: dir });
  assert.deepEqual(await cps.restore('s', { turn: 1, which: 'before' }), { ok: false, reason: 'busy' });
});

test('a non-git folder is skipped cleanly and nothing is written there', { skip }, async () => {
  const dir = tmp('cp-plain-');
  write(dir, 'f.txt', 'x');
  const { cps } = setup();
  assert.deepEqual(await cps.turnStart({ sessionId: 'p', cwd: dir }), { skipped: 'not-git' });
  assert.deepEqual(await cps.turnEnd({ sessionId: 'p', cwd: dir }), { skipped: 'not-git' });
  assert.deepEqual(fs.readdirSync(dir), ['f.txt']);
  assert.equal((await cps.turns('p')).skip, 'not-git');
  assert.deepEqual(await cps.turnStart({ sessionId: 'q', cwd: path.join(dir, 'missing') }), { skipped: 'not-git' });
});

test('off by default: nothing is checkpointed until switched on', { skip }, async () => {
  const dir = repo();
  const rootDir = tmp('cp-root-');
  const cps = createCheckpoints({ rootDir, entitlements: ents(), git: CheckpointGit.createGit({ env: ENV, tmpdir: TMP }) });
  assert.equal(cps.config().enabled, false);
  assert.equal(cps.config().review.enabled, false);
  assert.deepEqual(await cps.turnStart({ sessionId: 's', cwd: dir }), { skipped: 'off' });
  assert.deepEqual(cpRefs(dir), []);
});

test('a repo whose config defines filters is skipped and its filter never runs', { skip }, async () => {
  const dir = repo();
  const marker = path.join(TMP, `cp-filter-ran-${process.pid}`);
  fs.rmSync(marker, { force: true });
  sh(dir, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
  write(dir, '.gitattributes', '* filter=evil\n');
  const { cps } = setup();
  assert.deepEqual(await cps.turnStart({ sessionId: 'f', cwd: dir }), { skipped: 'filters' });
  assert.ok(!fs.existsSync(marker));
  assert.deepEqual(cpRefs(dir), []);
});

test('GC keeps the last N turns (free limit) and drops anything past the retention days', { skip }, async () => {
  const dir = repo();
  let clock = Date.now();
  const { cps } = setup({ turns: 3, extra: { now: () => clock } });
  for (let i = 0; i < 5; i++) {
    await cps.turnStart({ sessionId: 'g', cwd: dir });
    write(dir, 'a.txt', `turn ${i}\n`);
    await cps.turnEnd({ sessionId: 'g', cwd: dir });
  }
  assert.deepEqual(cpRefs(dir), ['refs/plexiform/cp/g/t000003', 'refs/plexiform/cp/g/t000004', 'refs/plexiform/cp/g/t000005']);
  clock += 8 * 86400e3;
  await cps.gcAll();
  assert.deepEqual(cpRefs(dir), []);
  assert.deepEqual(cps.sessions(), [], 'a session with no checkpoints left leaves the list');
});

test('checkpoint refs are never pushed', { skip }, async () => {
  const dir = repo();
  const remote = tmp('cp-remote-');
  sh(remote, 'init', '-q', '--bare');
  sh(dir, 'remote', 'add', 'origin', remote);
  const { cps } = setup();
  await cps.turnStart({ sessionId: 'p', cwd: dir });
  write(dir, 'a.txt', 'x\n');
  await cps.turnEnd({ sessionId: 'p', cwd: dir });
  sh(dir, 'push', '-q', 'origin', 'main');
  sh(dir, 'push', '-q', '--all', 'origin');
  sh(dir, 'push', '-q', '--tags', 'origin');
  const remoteRefs = sh(remote, 'for-each-ref', '--format=%(refname)');
  assert.ok(remoteRefs.includes('refs/heads/main'));
  assert.ok(!remoteRefs.includes('refs/plexiform'), remoteRefs);
  // and the wrapper itself can't reach a remote: no transport subcommand anywhere, and transports are off
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/checkpoint-git.js'), 'utf8');
  assert.ok(!/'(?:fetch|push|pull|clone|ls-remote)'/.test(src));
  assert.ok(CheckpointGit.SAFE_GIT.includes('protocol.allow=never'));
});

test('every process line in the checkpoint modules carries its privacy-flow tag', () => {
  for (const [file, slug] of [['src/checkpoint-git.js', 'checkpoint-git'], ['src/diff-review.js', 'diff-review']]) {
    const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').filter((l) => /\b(?:execFile|spawn)\(/.test(l) && !/^\s*\/\//.test(l));
    assert.ok(lines.length >= 1, file);
    for (const l of lines) assert.ok(l.includes(`// privacy-flow: ${slug}`), `${file}: ${l.trim()}`);
  }
});

test('turnStep: prompt starts a turn, stop ends it, a permission ask does not', () => {
  let r = turnStep(undefined, { sessionId: 's', signal: 'stop', signalSince: 't0', workingSince: null, cwd: '/r' });
  assert.deepEqual(r.events, []);
  r = turnStep(r.track, { signal: 'prompt-submit', signalSince: 't1', workingSince: 't1', cwd: '/r' });
  assert.deepEqual(r.events, ['start']);
  r = turnStep(r.track, { signal: 'permission-ask', signalSince: 't2', workingSince: null });
  assert.deepEqual(r.events, []);
  r = turnStep(r.track, { signal: 'tool-start', signalSince: 't3', workingSince: 't3' });
  assert.deepEqual(r.events, []);
  r = turnStep(r.track, { signal: 'stop', signalSince: 't4', workingSince: null });
  assert.deepEqual(r.events, ['end']);
  r = turnStep(r.track, { signal: 'stop', signalSince: 't4', workingSince: null });
  assert.deepEqual(r.events, [], 'a rewrite of the same stop is not another turn');
  r = turnStep(r.track, { signal: 'stop', signalSince: 't5', workingSince: null });
  assert.deepEqual(r.events, ['end'], 'a whole turn between two looks still ends');
  r = turnStep(r.track, { signal: 'prompt-submit', signalSince: 't6', workingSince: 't6' });
  r = turnStep(r.track, { signal: 'prompt-submit', signalSince: 't7', workingSince: 't7' });
  assert.deepEqual(r.events, ['end', 'start'], 'a new prompt without a seen stop closes the old turn');
  const mid = turnStep(undefined, { signal: 'tool-start', signalSince: 'x', workingSince: 'x' });
  assert.equal(mid.track.inTurn, true);
  assert.deepEqual(turnStep(mid.track, { signal: 'stop', signalSince: 'y' }).events, ['end']);
});

test('the watcher reads hook session files and reports turn boundaries', async () => {
  const dir = tmp('cp-sessions-');
  const seen = [];
  const file = path.join(dir, 'host-abc.json');
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'abc', cwd: '/r', signal: 'stop', signalSince: '1' }));
  const w = createTurnWatcher({ dir, pollMs: 60000, debounceMs: 5, onEvent: (ev, s) => seen.push(`${ev}:${s.sessionId}:${s.cwd}`) });
  try {
    const bump = (data) => { fs.writeFileSync(file, JSON.stringify(data)); const t = new Date(Date.now() + seen.length * 1000 + 5000); fs.utimesSync(file, t, t); w.scan(); };
    bump({ sessionId: 'abc', cwd: '/r', signal: 'prompt-submit', signalSince: '2', workingSince: '2' });
    assert.deepEqual(w.working(), [{ sessionId: 'abc', cwd: '/r' }]);
    bump({ sessionId: 'abc', cwd: '/r', signal: 'stop', signalSince: '3' });
    bump({ sessionId: 'abc', cwd: '/r', signal: 'prompt-submit', signalSince: '4', workingSince: '4' });
    fs.unlinkSync(file); w.scan();
    assert.deepEqual(seen, ['start:abc:/r', 'end:abc:/r', 'start:abc:/r', 'end:abc:/r']);
  } finally { w.close(); }
});

test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
