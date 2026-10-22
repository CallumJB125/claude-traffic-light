// Automatic mode (AGENT-BUS.md §5 "Which repos"): with no "only these" list, any
// git checkout main sees a Claude or Codex session working in is on the bus with
// no opt-in; a caller's cwd alone never is; the exclude list always wins and
// covers child folders and linked worktrees; a listed scope restricts; $HOME,
// protected folders (~/.claude, ~/Library, ...) and non-git folders never are.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writePolicy } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';

// No policy.json key: only Preferences (busSetContext) and the sessions decide.
const auto = () => startBus({ wait: true }, { policy: () => ({}) });
const busSpec = (b) => ({ text: 'Fix it', cwd: b.h.repo.checkout, ai: 'codex', source: 'bus',
  sourceMeta: { handoffId: 'hof_0123456789abcdef', fence: 1, originTier: 'local_attested', scope: 'local' } });
const realTop = (b) => fs.realpathSync(b.h.repo.checkout);
const remembered = (b) => b.engine.agentBus.log.state('session_repos', {});
const gitInit = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: dir });
  return fs.realpathSync(dir);
};

test('automatic: a caller cwd alone is not enough; a session folder main pushed is, and it is remembered as a restart cache', async () => {
  const b = await auto();
  try {
    const hello = await b.bus('hello', { provider: 'claude' });
    assert.equal(hello.policy_summary.repo_enabled, false, 'a bare caller cwd does not self-authorise');
    assert.equal((await b.handoff({ request_id: rid('auto') })).reason, 'NO_ELIGIBLE_AGENT');
    assert.deepEqual(remembered(b), {}, 'nothing remembered from a refused caller');
    await assert.rejects(b.engine.createTask({ requestId: rid('auto'), spec: busSpec(b) }), (e) => e.code === 'POLICY_DENIED');
    const sub = path.join(b.h.repo.checkout, 'pkg');
    fs.mkdirSync(sub);
    await b.bus('busSetContext', { folders: [sub] });
    assert.equal((await b.bus('hello', { provider: 'claude' })).policy_summary.repo_enabled, true);
    assert.equal((await b.handoff({ request_id: rid('auto') })).state, 'offered');
    assert.ok(remembered(b)[realTop(b)] > 0);
    // The session went away: the restart cache still covers it (an offer can start after a restart).
    await b.bus('busSetContext', { folders: [] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
  } finally { await b.cleanup(); }
});

test('automatic: a nested checkout\'s folder does not put the outer repo on', async () => {
  const b = await auto();
  try {
    const nested = gitInit(path.join(b.h.repo.checkout, 'nested'));
    await b.bus('busSetContext', { folders: [nested] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false);
    assert.equal(await b.engine.busRepoAllowed(nested), true);
  } finally { await b.cleanup(); }
});

test('nothing is remembered while the bus is off or halted', async () => {
  const b = await auto();
  try {
    await b.bus('busSetContext', { settings: { enabled: false }, folders: [b.h.repo.checkout] });
    await b.bus('hello', { provider: 'codex' });
    assert.deepEqual(remembered(b), {});
    await b.bus('busSetContext', { settings: { enabled: true } });
    await b.bus('halt', {});
    await b.bus('hello', { provider: 'codex' });
    assert.deepEqual(remembered(b), {});
    await b.bus('resume', {});
    await b.bus('hello', { provider: 'codex' });
    assert.ok(remembered(b)[realTop(b)] > 0);
  } finally { await b.cleanup(); }
});

test('exclude always wins: over automatic, "only these" and bus_auto; by remote; a parent folder; a linked worktree', async () => {
  const b = await startBus({ wait: true });
  try {
    await b.bus('busSetContext', { exclude: [b.h.repo.checkout], repos: [b.h.repo.checkout], folders: [b.h.repo.checkout] });
    assert.equal((await b.bus('hello', { provider: 'claude' })).policy_summary.repo_enabled, false);
    assert.equal((await b.handoff({ request_id: rid('excl') })).reason, 'NO_ELIGIBLE_AGENT');
    await assert.rejects(b.engine.createTask({ requestId: rid('excl'), spec: busSpec(b) }), (e) => e.code === 'POLICY_DENIED');
    b.h.repo.git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
    await b.bus('busSetContext', { exclude: ['github.com/acme/app'], repos: [] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, 'by canonical remote');
    await b.bus('busSetContext', { exclude: [b.h.dir] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, 'a parent folder covers the repos inside it');
    const wt = path.join(b.h.dir, 'app-wt');
    b.h.repo.git('worktree', 'add', '-q', '-b', 'wt', wt);
    await b.bus('busSetContext', { exclude: [b.h.repo.checkout], folders: [wt] });
    writePolicy(b.h.dataDir, {});
    assert.equal(await b.engine.busRepoAllowed(fs.realpathSync(wt)), false, 'a linked worktree of an excluded repo');
    await b.bus('busSetContext', { exclude: [] });
    assert.equal(await b.engine.busRepoAllowed(fs.realpathSync(wt)), true);
  } finally { await b.cleanup(); }
});

test('"only these": a non-empty list, or scope listed with an empty one, restricts automatic mode', async () => {
  const b = await auto();
  try {
    await b.bus('busSetContext', { repos: [path.join(b.h.dir, 'other')], folders: [b.h.repo.checkout] });
    assert.equal((await b.bus('hello', { provider: 'codex' })).policy_summary.repo_enabled, false);
    assert.equal((await b.handoff({ request_id: rid('only') })).reason, 'NO_ELIGIBLE_AGENT');
    await b.bus('busSetContext', { repos: [b.h.repo.checkout] });
    assert.equal((await b.handoff({ request_id: rid('only'), title: 'Listed' })).state, 'offered');
    // Migrated pre-automatic configs: listed, nothing listed, only policy.json bus_auto keys.
    await b.bus('busSetContext', { scope: 'listed', repos: [] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false);
    writePolicy(b.h.dataDir, { repos: { [b.h.repo.checkout]: { bus_auto: true } } });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
  } finally { await b.cleanup(); }
});

test('never a non-git folder, $HOME, a folder holding $HOME or a root', async () => {
  const b = await auto();
  const env = b.engine.env, home = env.HOME;
  try {
    const plain = path.join(b.h.dir, 'plain');
    fs.mkdirSync(plain);
    const fromPlain = { provider: 'claude', cwd: plain };
    await b.bus('busSetContext', { folders: [plain, b.h.repo.checkout] });
    assert.equal((await b.bus('hello', { provider: 'claude' }, fromPlain)).policy_summary.repo_enabled, false);
    assert.equal((await b.handoff({ request_id: rid('plain') }, fromPlain)).reason, 'NO_LOCAL_CHECKOUT');
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
    env.HOME = b.h.repo.checkout;
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, '$HOME itself');
    assert.equal((await b.handoff({ request_id: rid('home') })).reason, 'NO_ELIGIBLE_AGENT');
    env.HOME = path.join(b.h.repo.checkout, 'Users', 'me');
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, 'a folder holding $HOME');
    assert.equal(await b.engine.busRepoAllowed(path.parse(realTop(b)).root), false, 'a filesystem root');
  } finally { env.HOME = home; await b.cleanup(); }
});

test('protected folders: ~/.claude/skills/x and ~/Library/x never in automatic mode; bus_auto overrides ~/Library, never ~/.claude', async () => {
  const b = await auto();
  const env = b.engine.env, home = env.HOME;
  try {
    const h = path.join(b.h.dir, 'home');
    fs.mkdirSync(h);
    const skill = gitInit(path.join(h, '.claude', 'skills', 'x'));
    const lib = gitInit(path.join(h, 'Library', 'x'));
    const dot = gitInit(path.join(h, '.local', 'state', 'x'));
    const fine = gitInit(path.join(h, 'code', 'x'));
    env.HOME = h;
    await b.bus('busSetContext', { folders: [skill, lib, dot, fine] });
    assert.equal(await b.engine.busRepoAllowed(skill), false, '~/.claude/skills/x');
    assert.equal(await b.engine.busRepoAllowed(lib), false, '~/Library/x');
    assert.equal(await b.engine.busRepoAllowed(dot), false, 'any dot-folder under $HOME');
    assert.equal(await b.engine.busRepoAllowed(fine), true, 'an ordinary checkout under $HOME');
    assert.equal((await b.bus('hello', { provider: 'claude' }, { provider: 'claude', cwd: skill })).policy_summary.repo_enabled, false);
    assert.deepEqual(remembered(b), {});
    writePolicy(b.h.dataDir, { repos: { [skill]: { bus_auto: true }, [lib]: { bus_auto: true } } });
    assert.equal(await b.engine.busRepoAllowed(lib), true, 'an explicit bus_auto key may opt ~/Library/x in');
    assert.equal(await b.engine.busRepoAllowed(skill), false, 'but never ~/.claude, ~/.codex or ~/.claude-traffic-light');
    // Plexiform's own Tasks data folder is never a target either.
    await b.bus('busSetContext', { repos: [b.h.dataDir] });
    assert.equal(await b.engine.busRepoAllowed(fs.realpathSync(b.h.dataDir)), false);
  } finally { env.HOME = home; await b.cleanup(); }
});

test('a result with no run is framed as from Plexiform, not "running in Plexiform"', async () => {
  const b = await startBus({ wait: true });
  try {
    // Claude is not startable in this harness: the handoff ends "Not started" with no task.
    const offer = await b.handoff({ request_id: rid('norun'), to: { provider: 'claude' }, provider: 'codex' });
    const r = await b.bus('wait', { handoff_id: offer.handoff_id, timeout_s: 30 });
    assert.equal(r.state, 'failed');
    assert.equal(r.task_id, null);
    assert.deepEqual(r.result.from, { provider: 'claude', tier: 'run_capability' });
    assert.match(r.result.text, /^\[Message via Plexiform from Plexiform\./);
    assert.doesNotMatch(r.result.text, /running in Plexiform/);
  } finally { await b.cleanup(); }
});
