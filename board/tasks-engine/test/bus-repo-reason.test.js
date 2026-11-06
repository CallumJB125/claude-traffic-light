// BACKBONE G3: repo_enabled always comes with a reason (src/bus-contract.js REPO_REASON). A linked git worktree of a
// repository a live session works in counts as that repository; the person's "only these" list still restricts and
// covers its worktrees; $HOME is PROTECTED; every false answer names why.
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
const hello = async (b, cwd) => (await b.bus('hello', { provider: 'claude' }, { provider: 'claude', cwd })).policy_summary;

test('G3: a worktree whose main checkout has a live session is on the bus (WORKTREE); without one, NO_SESSION with a sentence', async () => {
  const b = await auto();
  try {
    const wt = worktreeOf(b.h.repo.checkout);
    let p = await hello(b, wt);
    assert.equal(p.repo_enabled, false);
    assert.equal(p.repo_reason, 'NO_SESSION');
    assert.equal(p.repo_reason_text, Contract.REPO_REASON_TEXT.NO_SESSION);
    const refused = await b.handoff({}, { provider: 'claude', cwd: wt });
    assert.equal(refused.reason, 'NO_ELIGIBLE_AGENT');
    assert.equal(refused.repo_reason, 'NO_SESSION');
    // The person's session works in the main checkout.
    await b.bus('busSetContext', { folders: [b.h.repo.checkout] });
    p = await hello(b, wt);
    assert.equal(p.repo_enabled, true);
    assert.equal(p.repo_why, 'WORKTREE');
    assert.equal(p.repo_reason, undefined);
    assert.equal((await b.handoff({}, { provider: 'claude', cwd: wt })).state, 'offered');
    // The checkout itself: SESSION.
    assert.equal((await hello(b, b.h.repo.checkout)).repo_why, 'SESSION');
  } finally { await b.cleanup(); }
});

test('G3: the "only these" list restricts even in automatic mode (LISTED_ONLY), and a listed checkout covers its worktrees', async () => {
  const b = await auto();
  try {
    const wt = worktreeOf(b.h.repo.checkout);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-other-'));
    git(other, 'init', '-q');
    await b.bus('busSetContext', { scope: 'auto', repos: [other], folders: [b.h.repo.checkout] });
    let p = await hello(b, b.h.repo.checkout);
    assert.equal(p.repo_enabled, false);
    assert.equal(p.repo_reason, 'LISTED_ONLY');
    assert.match(p.repo_reason_text, /Only these repositories/);
    await b.bus('busSetContext', { scope: 'listed', repos: [b.h.repo.checkout], folders: [] });
    p = await hello(b, wt);
    assert.equal(p.repo_enabled, true);
    assert.equal(p.repo_why, 'LISTED');
    fs.rmSync(other, { recursive: true, force: true });
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
