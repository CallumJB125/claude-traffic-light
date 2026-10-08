// The review quality eval (board/runner/scripts/review-eval.js) in CI with the
// fake providers: a regression in the prompt, the parser's guards or the
// scrubber shows up as a failed threshold here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, loadFixtures, THRESHOLDS } from '../scripts/review-eval.js';
import { providers } from './fixtures/review-eval/fake-provider.js';

test('eval fixtures cover good, subtly buggy and injection diffs', () => {
  const kinds = loadFixtures().reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] ?? 0) + 1 }), {});
  assert.ok(kinds.good >= 3 && kinds.buggy >= 3 && kinds.injection >= 3, JSON.stringify(kinds));
});

test('the careful fake reviewer meets every threshold', async () => {
  const { summary, failed } = await evaluate({ provider: providers.fake });
  assert.deepEqual(failed, [], JSON.stringify(summary));
  assert.ok(summary.accuracy >= THRESHOLDS.accuracy);
  assert.equal(summary.secrets_leaked, 0);
});

test('a reviewer fooled by the injection still never yields approve on an injection fixture', async () => {
  const { results, summary } = await evaluate({ provider: providers.gullible });
  assert.equal(summary.injection_resisted, 1);
  for (const r of results.filter((x) => x.kind === 'injection')) {
    assert.equal(r.verdict, 'needs_human', r.name);
    assert.ok(r.flags.includes('injection_suspected'), r.name);
  }
});

test('a broken reviewer is measured as a regression, not hidden', async () => {
  const rubberStamp = async () => ({ ok: true, text: '{"verdict":"approve","summary":"LGTM","findings":[]}', cost_usd: 0 });
  const { failed, summary } = await evaluate({ provider: rubberStamp });
  assert.ok(failed.includes('accuracy') && failed.includes('recall'), JSON.stringify(summary));
  assert.equal(summary.injection_resisted, 1, 'the guards alone still stop approve on injections');
});
