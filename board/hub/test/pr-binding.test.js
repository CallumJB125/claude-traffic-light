// D90: a PR is hub_verified only when it is the card's own work (same-repo head,
// the run's base branch), and the merge poll re-checks that binding every cycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.js';

async function setup(h) {
  const alice = await h.login('alice');
  const runner = await h.runner(await h.enroll(alice));
  const run = await h.startRun(alice, runner);
  return { alice, runner, run };
}
const attach = (runner, run, n) => runner.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: `#${n}` });
async function inReview(runner, run, evidenceId) {
  const nt = await runner.rpc(run, 'board_attach_evidence', { kind: 'no_tests_reason', ref: 'docs only' });
  const r = await runner.rpc(run, 'board_complete', { summary: 's', evidence_ids: [evidenceId, nt.result.evidence_id] });
  assert.deepEqual(r.result, { state: 'in_review' });
}
const merged = { state: 'closed', merged: true, merged_by: 'alice', merged_at: '2026-09-30T10:05:00Z' };

test('a legit same-repo PR is verified and its binding stored', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch });
    const r = await attach(runner, run, 5);
    assert.equal(r.result.verification, 'hub_verified');
    const ev = h.db.get('SELECT * FROM evidence WHERE id = ?', r.result.evidence_id);
    assert.deepEqual([ev.pr_head_repo_id, ev.pr_base_repo_id, ev.pr_base_ref], [100, 100, 'main']);
  } finally { await h.destroy(); }
});

test('L1: a verified PR is stored as the hub’s canonical URL, not the runner’s text; a self-reported one keeps its text', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(6, { head_ref: run.branch });
    const r = await runner.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: 'https://evil.example/mallory/app/pull/6' });
    assert.equal(r.result.verification, 'hub_verified');
    assert.equal(h.db.get('SELECT ref FROM evidence WHERE id = ?', r.result.evidence_id).ref, 'https://github.com/acme/app/pull/6');
    const row = h.db.all("SELECT payload FROM journal WHERE kind = 'evidence.create'").map((x) => JSON.parse(x.payload)).find((p) => p.evidence_id === r.result.evidence_id);
    assert.equal(row.ref, 'https://github.com/acme/app/pull/6');
    const self = await runner.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: '#404' });
    assert.equal(self.result.verification, 'self_reported');
    assert.equal(h.db.get('SELECT ref FROM evidence WHERE id = ?', self.result.evidence_id).ref, '#404');
  } finally { await h.destroy(); }
});

test('a fork PR with the matching branch is self_reported', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch, head_repo_id: 999, head_repo: 'mallory/app' });
    const r = await attach(runner, run, 5);
    assert.equal(r.result.verification, 'self_reported');
    assert.equal(h.db.get('SELECT pr_base_ref FROM evidence WHERE id = ?', r.result.evidence_id).pr_base_ref, null);
  } finally { await h.destroy(); }
});

test('right branch but a different base_ref is not verified', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch, base_ref: 'release' });
    assert.equal((await attach(runner, run, 5)).result.verification, 'self_reported');
  } finally { await h.destroy(); }
});

test('a deleted head repo (null) is not verified', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch, head_repo_id: null, head_repo: null });
    assert.equal((await attach(runner, run, 5)).result.verification, 'self_reported');
  } finally { await h.destroy(); }
});

test('poll ignores a merged fork PR (card stays in_review) and still moves a legit one', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch });
    const ev = await attach(runner, run, 5);
    await inReview(runner, run, ev.result.evidence_id);
    h.github.setPull(5, { head_ref: run.branch, head_repo_id: 999, ...merged });
    await h.hub.pollMerges();
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'in_review');
    h.github.setPull(5, { head_ref: run.branch, ...merged });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'done');
  } finally { await h.destroy(); }
});

test('poll re-check catches a PR retargeted after verification, and a closed-unmerged unbound PR', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch });
    const ev = await attach(runner, run, 5);
    await inReview(runner, run, ev.result.evidence_id);
    h.github.setPull(5, { head_ref: run.branch, base_ref: 'other', ...merged });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'in_review');
    h.github.setPull(5, { head_ref: run.branch, base_ref: 'other', state: 'closed', merged: false });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'in_review', 'pr_closed is not applied for an unbound PR either');
    h.github.setPull(5, { head_ref: 'someone-elses', ...merged });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'in_review');
  } finally { await h.destroy(); }
});

test('evidence rows from before the binding columns: base re-derived from the run, fork still refused', async () => {
  const h = await startHub();
  try {
    const { runner, run } = await setup(h);
    h.github.setPull(5, { head_ref: run.branch });
    const ev = await attach(runner, run, 5);
    await inReview(runner, run, ev.result.evidence_id);
    h.db.run('UPDATE evidence SET pr_head_repo_id = NULL, pr_base_repo_id = NULL, pr_base_ref = NULL WHERE id = ?', ev.result.evidence_id);
    h.github.setPull(5, { head_ref: run.branch, head_repo_id: 999, ...merged });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'in_review');
    h.github.setPull(5, { head_ref: run.branch, base_ref: 'other', ...merged });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'in_review');
    h.github.setPull(5, { head_ref: run.branch, ...merged });
    await h.hub.pollMerges();
    assert.equal(h.card(run.card_id).run_state, 'done');
  } finally { await h.destroy(); }
});
