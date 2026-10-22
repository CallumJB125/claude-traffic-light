// Automatic mode (AGENT-BUS.md §5 "Which repos"): with no "only these" list, any
// git checkout a Claude or Codex session here works in is on the bus with no
// opt-in; the exclude list always wins; a non-empty list restricts; a folder
// that is not a git work tree, $HOME and a folder holding $HOME never are.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startBus, rid } from './bus-helpers.js';

// No policy.json key: only Preferences (busSetContext) and the sessions decide.
const auto = () => startBus({ wait: true }, { policy: () => ({}) });
const busSpec = (b) => ({ text: 'Fix it', cwd: b.h.repo.checkout, ai: 'codex', source: 'bus',
  sourceMeta: { handoffId: 'hof_0123456789abcdef', fence: 1, originTier: 'local_attested', scope: 'local' } });
const realTop = (b) => fs.realpathSync(b.h.repo.checkout);

test('automatic: a session calling from a checkout puts it on the bus with no opt-in; the engine agrees', async () => {
  const b = await auto();
  try {
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, 'no session has called from it yet');
    await assert.rejects(b.engine.createTask({ requestId: rid('auto'), spec: busSpec(b) }), (e) => e.code === 'POLICY_DENIED');
    const hello = await b.bus('hello', { provider: 'claude' });
    assert.equal(hello.policy_summary.repo_enabled, true);
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
    const offer = await b.handoff({ request_id: rid('auto') });
    assert.equal(offer.state, 'offered');
    // Remembered in bus.db, so an offer still starts after the helper restarts.
    assert.ok(b.engine.agentBus.log.state('session_repos', {})[realTop(b)] > 0);
  } finally { await b.cleanup(); }
});

test('automatic: a folder main pushes (task folder or live session) counts for its checkout, a subfolder too', async () => {
  const b = await auto();
  try {
    const sub = path.join(b.h.repo.checkout, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    await b.bus('busSetContext', { folders: [sub] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
    // A nested checkout's folder does not put the outer repo on.
    const nested = path.join(b.h.repo.checkout, 'nested');
    fs.mkdirSync(nested);
    execFileSync('git', ['init', '-q'], { cwd: nested });
    await b.bus('busSetContext', { folders: [nested] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false);
  } finally { await b.cleanup(); }
});

test('exclude always wins: over automatic mode, the "only these" list and policy.json bus_auto', async () => {
  const b = await startBus({ wait: true });
  try {
    await b.bus('busSetContext', { exclude: [b.h.repo.checkout], repos: [b.h.repo.checkout] });
    const hello = await b.bus('hello', { provider: 'claude' });
    assert.equal(hello.policy_summary.repo_enabled, false);
    assert.equal((await b.handoff({ request_id: rid('excl') })).reason, 'NO_ELIGIBLE_AGENT');
    await assert.rejects(b.engine.createTask({ requestId: rid('excl'), spec: busSpec(b) }), (e) => e.code === 'POLICY_DENIED');
    // By canonical remote too.
    b.h.repo.git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
    await b.bus('busSetContext', { exclude: ['github.com/acme/app'], repos: [] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false);
    await b.bus('busSetContext', { exclude: [] });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
  } finally { await b.cleanup(); }
});

test('"only these": a non-empty list restricts automatic mode to it', async () => {
  const b = await auto();
  try {
    await b.bus('busSetContext', { repos: [path.join(b.h.dir, 'other')] });
    assert.equal((await b.bus('hello', { provider: 'codex' })).policy_summary.repo_enabled, false, 'a calling session does not put it on');
    assert.equal((await b.handoff({ request_id: rid('only') })).reason, 'NO_ELIGIBLE_AGENT');
    await b.bus('busSetContext', { repos: [b.h.repo.checkout] });
    assert.equal((await b.handoff({ request_id: rid('only'), title: 'Listed' })).state, 'offered');
  } finally { await b.cleanup(); }
});

test('never a folder that is not a git work tree, $HOME itself or a folder holding $HOME', async () => {
  const b = await auto();
  const env = b.engine.env, home = env.HOME;
  try {
    const plain = path.join(b.h.dir, 'plain');
    fs.mkdirSync(plain);
    const fromPlain = { provider: 'claude', cwd: plain };
    assert.equal((await b.bus('hello', { provider: 'claude' }, fromPlain)).policy_summary.repo_enabled, false);
    assert.equal((await b.handoff({ request_id: rid('plain') }, fromPlain)).reason, 'NO_LOCAL_CHECKOUT');
    await b.bus('hello', { provider: 'claude' });
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), true);
    env.HOME = b.h.repo.checkout;
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, '$HOME itself');
    assert.equal((await b.handoff({ request_id: rid('home') })).reason, 'NO_ELIGIBLE_AGENT');
    env.HOME = path.join(b.h.repo.checkout, 'Users', 'me');
    assert.equal(await b.engine.busRepoAllowed(realTop(b)), false, 'a folder holding $HOME');
    assert.equal(await b.engine.busRepoAllowed(path.parse(realTop(b)).root), false, 'a filesystem root');
  } finally { env.HOME = home; await b.cleanup(); }
});
