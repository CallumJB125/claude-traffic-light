import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, emptyNarrative, mergeHandover, renderMarkdown, syncAges, handoffMemoryText, howToTakeOver, AGENT_WRITABLE, SECTIONS, LIMITS } from '../handover.js';

const T0 = 1_000_000_000;
const MIN = 60_000;

test('agent may write only plan/done/hypothesis/dead_ends/next/questions', () => {
  assert.deepEqual([...AGENT_WRITABLE].sort(), ['dead_ends', 'done', 'hypothesis', 'next', 'plan', 'questions']);
  for (const k of ['goal', 'done_means', 'salvage', 'files_touched', 'how_to_take_over']) {
    assert.throws(() => applyPatch(emptyNarrative(), { [k]: 'x' }), (e) => e.code === 'VALIDATION', k);
  }
  assert.throws(() => applyPatch(null, null), (e) => e.code === 'VALIDATION');
  assert.throws(() => applyPatch(null, { next: 'x' }, { written_by: 'bogus' }), (e) => e.code === 'VALIDATION');
  assert.equal(applyPatch(null, { goal: 'g' }, { writable: ['goal'], written_by: 'human' }).goal, 'g');
});

test('patch semantics: done prepends newest-first, others replace, null clears, version bumps', () => {
  let n = applyPatch(null, { done: '13:58 reproduced', hypothesis: 'h1' }, { at_ms: T0 });
  n = applyPatch(n, { done: ['14:21 root cause'], hypothesis: 'h2', next: 'fix it' }, { at_ms: T0 + MIN });
  assert.deepEqual(n.done, ['14:21 root cause', '13:58 reproduced']);
  assert.equal(n.hypothesis, 'h2');
  assert.equal(n.version, 2);
  assert.equal(n.at_ms, T0 + MIN);
  n = applyPatch(n, { next: null });
  assert.equal(n.next, null);
  const big = applyPatch(null, { done: Array.from({ length: 80 }, (_, i) => `e${i}`), hypothesis: 'x'.repeat(10_000) });
  assert.equal(big.done.length, LIMITS.done_entries);
  assert.equal(big.hypothesis.length, LIMITS.section_chars);
  const plan = applyPatch(null, { plan: [{ text: 'a', status: 'done' }, { text: 'b', status: 'weird' }] }).plan;
  assert.deepEqual(plan, [{ text: 'a', status: 'done' }, { text: 'b', status: 'todo' }]);
});

const baseInput = () => ({
  card: { key: 'BDL-142', title: 'Submit posts {}', goal: 'Send the full payload', done_means: '- 400 on empty', repo_id: 'github.com/pistorventures/bondly' },
  run: { fence: 3, run_state: 'orphaned', agent_label: "James's Claude", base_ref: 'dev', base_sha: 'e41b9d0aaaa' },
  facts: {
    at_ms: T0 + 10 * MIN,
    files_touched: [
      { path: 'apps/switch-next/lib/submit.ts', op: 'edit', at_ms: T0 + 9 * MIN },
      { path: 'apps/switch-next/hooks/useApplicationDraft.ts', op: 'read', at_ms: T0 + 2 * MIN },
      { path: 'backend/routes/applications.js', op: 'edit', at_ms: T0 + 10 * MIN },
    ],
    branch: 'board/BDL-142-r3', head_sha: '7f3a2c1ffff', commits_ahead: 1,
    commands: [{ cmd: 'npx jest x.test.js', exit: 1, duration_ms: 4200, tail: 'expected 400, received 200' }],
    plan: [{ text: 'Reproduce', status: 'done' }, { text: 'Fix', status: 'doing' }], plan_at_ms: T0,
  },
  narrative: applyPatch(null, { done: '14:21 root cause candidate', hypothesis: 'draft not re-keyed', next: 'call rekeyDraft', questions: '400 or 422?' }, { at_ms: T0 + 3 * MIN }),
  snapshot: { sha: '7f3a2c1ffff', ref: 'refs/board/BDL-142/r3', status: 'pushed', at_ms: T0 + 4 * MIN },
});

test('merge: layers, unsynced edits after the snapshot, plan precedence', () => {
  const doc = mergeHandover(baseInput());
  assert.deepEqual(doc.unsynced_paths, ['apps/switch-next/lib/submit.ts', 'backend/routes/applications.js'], 'reads never count as unsynced');
  assert.equal(doc.sections.goal, 'Send the full payload');
  assert.equal(doc.sections.hypothesis, 'draft not re-keyed');
  // Narrative (T0+3m) has no plan → TodoWrite mirror wins.
  assert.equal(doc.sections.plan[1].status, 'doing');
  const withPlan = mergeHandover({ ...baseInput(), narrative: applyPatch(null, { plan: 'narrative plan' }, { at_ms: T0 + 5 * MIN }) });
  assert.equal(withPlan.sections.plan, 'narrative plan');
  const newerFacts = mergeHandover({ ...baseInput(), narrative: applyPatch(null, { plan: 'old' }, { at_ms: T0 }), facts: { ...baseInput().facts, plan_at_ms: T0 + 1 } });
  assert.notEqual(newerFacts.sections.plan, 'old');
});

test('"last synced" per layer on one clock (exit b)', () => {
  const doc = mergeHandover(baseInput());
  assert.deepEqual(syncAges(doc, T0 + 14 * MIN), { facts_ms: 4 * MIN, narrative_ms: 11 * MIN, snapshot_ms: 10 * MIN });
  const md = renderMarkdown(doc, { now_ms: T0 + 14 * MIN });
  assert.match(md, /^Last synced: facts 4m ago · narrative 11m ago · code 7f3a2c1 10m ago \(pushed\); 2 file\(s\) modified after that are NOT synced$/m);
  const empty = renderMarkdown(mergeHandover({ card: { key: 'K-1', title: 't' } }), { now_ms: T0 });
  assert.match(empty, /Last synced: facts never · narrative never · code none/);
});

test('render follows the §7.4 template, section order included', () => {
  const md = renderMarkdown(mergeHandover(baseInput()), { now_ms: T0 + 14 * MIN });
  assert.match(md, /^# Handover · BDL-142 Submit posts \{\}\n/);
  assert.match(md, /State: orphaned · run r3 \(fence 3\) · James's Claude · repo github.com\/pistorventures\/bondly/);
  const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, SECTIONS.map(([, t]) => t));
  assert.match(md, /- \[x\] Reproduce\n- \[~\] Fix/);
  assert.match(md, /- apps\/switch-next\/lib\/submit.ts · edit \(after last snapshot\)/);
  assert.match(md, /branch board\/BDL-142-r3 · base dev@e41b9d0 · 1 commit\(s\) ahead · snapshot 7f3a2c1 \(refs\/board\/BDL-142\/r3\)/);
  assert.match(md, /- `npx jest x.test.js` · exit 1 · 4.2 s\n {2}expected 400, received 200/);
  assert.match(md, /## Salvage\n\(none\)/);
});

test('snapshot provenance: push_failed and held', () => {
  const pf = renderMarkdown(mergeHandover({ ...baseInput(), snapshot: { sha: 'abcdef1234', status: 'push_failed', at_ms: T0 } }), { now_ms: T0 + MIN });
  assert.match(pf, /code abcdef1 1m ago \(push_failed\)/);
  const held = renderMarkdown(mergeHandover({ ...baseInput(), snapshot: { sha: 'abcdef1234', status: 'held', reason: 'possible secret in .env', at_ms: T0 } }), { now_ms: T0 + MIN });
  assert.match(held, /\(held: possible secret in \.env\)/);
  assert.match(howToTakeOver(mergeHandover({ ...baseInput(), snapshot: { sha: 'abc', status: 'held', at_ms: T0 } })), /from branch board\/BDL-142-r3 \(no pushed snapshot\)/);
});

test('how to take over + handoff memory', () => {
  const how = howToTakeOver(mergeHandover(baseInput()));
  assert.match(how, /new run r4 on board\/BDL-142-r4 from snapshot 7f3a2c1 at refs\/board\/BDL-142\/r3/);
  assert.match(how, /git fetch origin 'refs\/board\/BDL-142\/\*:refs\/board\/BDL-142\/\*'/);
  assert.match(how, /Redo the 2 unsynced edit/);
  assert.equal(howToTakeOver(mergeHandover({ card: { key: 'K' } })), 'Give to Claude to start a run.');
  assert.equal(handoffMemoryText({ from_n: 3, to_n: 4, taker: 'Sam', provenance: 'checkpoint_incomplete', hypothesis: 'h', next: 'n' }), 'r3 → r4: Sam took over (checkpoint incomplete); hypothesis h; next n');
  assert.ok(handoffMemoryText({ from_n: 1, hypothesis: 'x'.repeat(5000) }).length <= 1200);
});
