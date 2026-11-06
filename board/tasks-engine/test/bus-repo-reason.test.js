// BACKBONE G3: repo_enabled always comes with a reason (src/bus-contract.js REPO_REASON). Automatic scope takes every
// repository (owner decision, 6 Nov): its list only adds. Scope "listed" restricts to the list and covers the listed
// repositories' worktrees; $HOME is PROTECTED; every false answer names why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { startBus } from './bus-helpers.js';

const Contract = createRequire(import.meta.url)('../../../src/bus-contract.js');
const auto = () => startBus({ wait: true }, { policy: () => ({}) });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
function worktreeOf(checkout) {
  const wt = path.join(path.dirname(checkout), `${path.basename(checkout)}-wt-${process.pid}`);
  git(checkout, 'worktree', 'add', '-q', '-b', `wt-${process.pid}-${Date.now().toString(36)}`, wt);
  return fs.realpathSync(wt);
}
const hello = async (b, cwd) => (await b.bus('hello', { provider: 'claude' }, { provider: 'claude', cwd, bound: true })).policy_summary;

test('auto scope: every repository is on the bus, with no session needed (AUTO); a worktree too', async () => {
  const b = await auto();
  try {
    const wt = worktreeOf(b.h.repo.checkout);
    let p = await hello(b, wt);
    assert.equal(p.repo_enabled, true);
    assert.equal(p.repo_why, 'AUTO');
    assert.equal(p.repo_reason, undefined);
    assert.equal((await b.handoff({}, { provider: 'claude', cwd: wt, bound: true })).state, 'offered');
    p = await hello(b, b.h.repo.checkout);
    assert.equal(p.repo_enabled, true);
    assert.equal(p.repo_why, 'AUTO');
  } finally { await b.cleanup(); }
});

test('auto scope: list entries only add (LISTED for a listed repo, AUTO for the rest); scope "listed" restricts and covers worktrees', async () => {
  const b = await auto();
  try {
    const wt = worktreeOf(b.h.repo.checkout);
    const other = path.join(b.h.dir, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q');
    // The owner's Mac on 6 Nov: Automatic with two listed repositories. The unlisted one is still on the bus.
    await b.bus('busSetContext', { scope: 'auto', repos: [other], folders: [] });
    let p = await hello(b, b.h.repo.checkout);
    assert.equal(p.repo_enabled, true);
    assert.equal(p.repo_why, 'AUTO');
    assert.equal((await hello(b, fs.realpathSync(other))).repo_why, 'LISTED');
    await b.bus('busSetContext', { scope: 'listed', repos: [other], folders: [] });
    p = await hello(b, b.h.repo.checkout);
    assert.equal(p.repo_enabled, false);
    assert.equal(p.repo_reason, 'LISTED_ONLY');
    assert.equal(p.repo_reason_text, Contract.REPO_REASON_TEXT.LISTED_ONLY);
    assert.equal((await b.handoff({}, { provider: 'claude', cwd: b.h.repo.checkout, bound: true })).repo_reason, 'LISTED_ONLY');
    await b.bus('busSetContext', { scope: 'listed', repos: [b.h.repo.checkout], folders: [] });
    p = await hello(b, wt);
    assert.equal(p.repo_enabled, true);
    assert.equal(p.repo_why, 'LISTED');
    // Excluded still wins over a listing in either scope.
    await b.bus('busSetContext', { scope: 'auto', repos: [b.h.repo.checkout], exclude: [b.h.repo.checkout] });
    assert.equal((await hello(b, b.h.repo.checkout)).repo_reason, 'EXCLUDED');
  } finally { await b.cleanup(); }
});

test('G3: excluded, $HOME, a non-git folder and a bus turned off each say why', async () => {
  const b = await auto();
  try {
    await b.bus('busSetContext', { folders: [b.h.repo.checkout], exclude: [b.h.repo.checkout] });
    assert.equal((await hello(b, b.h.repo.checkout)).repo_reason, 'EXCLUDED');
    await b.bus('busSetContext', { folders: [b.h.repo.checkout], exclude: [] });
    const home = fs.realpathSync(b.engine.env.HOME ?? os.homedir());
    assert.equal((await hello(b, home)).repo_reason, 'PROTECTED');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plain-'));
    const p = await hello(b, plain);
    assert.equal(p.repo_reason, 'NOT_GIT');
    const r = await b.handoff({}, { provider: 'claude', cwd: plain });
    assert.equal(r.reason, 'NO_LOCAL_CHECKOUT');
    assert.equal(r.repo_reason, 'NOT_GIT');
    fs.rmSync(plain, { recursive: true, force: true });
    await b.bus('busSetContext', { settings: { enabled: false } });
    assert.equal((await hello(b, b.h.repo.checkout)).repo_reason, 'BUS_OFF');
    // Every false answer above carried a reason from the contract.
    for (const reason of ['EXCLUDED', 'PROTECTED', 'NOT_GIT', 'BUS_OFF']) assert.ok(Contract.REPO_REASON[reason]);
  } finally { await b.cleanup(); }
});
