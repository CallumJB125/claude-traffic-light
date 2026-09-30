// Runner connection robustness (review fixes): a hung GitHub call never stalls
// the connection's frame sequence, GitHub fetches time out, merge polls never
// stack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, fakeGitHub, runMsg, runHb } from './helpers.js';
import { createGitHub } from '../github.js';

function hangingGitHub() {
  const gh = fakeGitHub();
  gh.calls = 0;
  gh.getPull = () => { gh.calls++; return new Promise(() => {}); };
  return gh;
}

test('a hung GitHub evidence check does not hold up the heartbeats and outbox frames behind it', async () => {
  const h = await startHub({ github: hangingGitHub() });
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.send({ type: 'rpc', id: 'ev1', method: 'board_attach_evidence', ...runMsg(run), run_token: run.run_token, params: { kind: 'pr', ref: '#7', summary: 'PR' } });
    const t0 = Date.now();
    const ack = await runner.hb([runHb(run)]);
    assert.equal(ack.runs[0].current, true);
    await runner.out({ kind: 'status.update', ...runMsg(run), summary: 'still going' });
    assert.ok(Date.now() - t0 < 1000, 'answered while the rpc is still waiting on GitHub');
    assert.equal(runner.all('rpc.result', (m) => m.re === 'ev1').length, 0);
  } finally { await h.destroy(); }
});

test('GitHub fetches abort after the timeout instead of hanging', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); });
  const gh = createGitHub({ fetchImpl, timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(gh.getPull('github.com/acme/app', 1), /TimeoutError|aborted|timeout/i);
  assert.ok(Date.now() - t0 < 2000);
});

test('merge polls never overlap', async () => {
  const gh = hangingGitHub();
  const h = await startHub({ github: gh });
  try {
    const alice = await h.login('alice');
    const card = await h.createCard(alice);
    h.db.run("UPDATE cards SET run_state = 'in_review', column_name = 'in_review' WHERE id = ?", card.id);
    h.db.insert('evidence', { id: 'ev-x', card_id: card.id, run_id: null, kind: 'pr', ref: '#3', verification: 'hub_verified', created_at: h.hub.iso() });
    h.hub.pollMerges();
    h.hub.pollMerges();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gh.calls, 1);
  } finally { await h.destroy(); }
});
