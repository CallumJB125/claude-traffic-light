import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPair, computeOverlaps, overlapsFor, teamContextBlock, overlapDelta, globToRegExp, pathMatches, patternsIntersect, textSimilarity, estimateTokens, kindOf, TEAM_CONTEXT_BUDGET_TOKENS } from '../overlap.js';

const run = (id, over = {}) => ({ run_id: id, card_key: `BDL-${id}`, owner_label: `${id}'s Claude`, repo_id: 'r1', branch: `board/BDL-${id}-r1`, touched_paths: [], planned_paths: [], ...over });
const reasons = (sigs) => sigs.map((s) => `${s.level}:${s.reason}`).sort();

test('high: same file touched by both, or planned by one and touched by the other', () => {
  assert.deepEqual(reasons(classifyPair(run('a', { touched_paths: ['src/api/deals.ts'] }), run('b', { touched_paths: ['src/api/deals.ts'] }))), ['high:same_file']);
  const p = classifyPair(run('a', { planned_paths: ['src/api/**'] }), run('b', { touched_paths: ['src/api/deals.ts'] }));
  assert.deepEqual(reasons(p), ['high:same_file']);
  assert.deepEqual(p[0].paths, ['src/api/deals.ts']);
});

test('high: same branch', () => {
  assert.deepEqual(reasons(classifyPair(run('a', { branch: 'dev' }), run('b', { branch: 'dev' }))), ['high:same_branch']);
});

test('medium: same directory (depth ≥ 2), not same file', () => {
  assert.deepEqual(reasons(classifyPair(run('a', { touched_paths: ['src/api/deals.ts'] }), run('b', { touched_paths: ['src/api/users.ts'] }))), ['medium:same_dir']);
  assert.deepEqual(classifyPair(run('a', { touched_paths: ['src/a.ts'] }), run('b', { touched_paths: ['src/b.ts'] })), [], 'depth 1 is too broad');
  assert.deepEqual(classifyPair(run('a', { touched_paths: ['README.md'] }), run('b', { touched_paths: ['LICENSE'] })), []);
});

test('medium: planned paths overlap; lockfiles; migrations', () => {
  assert.deepEqual(reasons(classifyPair(run('a', { planned_paths: ['backend/routes/**'] }), run('b', { planned_paths: ['backend/routes/applications.js'] }))), ['medium:planned_paths']);
  assert.deepEqual(reasons(classifyPair(run('a', { touched_paths: ['package-lock.json'] }), run('b', { touched_paths: ['apps/x/package-lock.json'] }))), ['medium:lockfile']);
  assert.deepEqual(reasons(classifyPair(run('a', { touched_paths: ['db/migrations/024_a.sql'] }), run('b', { touched_paths: ['db/migrations/025_b.sql'] }))), ['medium:migrations', 'medium:same_dir']);
});

test('high: touching a path the other run holds a lock on', () => {
  assert.ok(reasons(classifyPair(run('a', { locked_paths: ['x/y/z.ts'] }), run('b', { touched_paths: ['x/y/z.ts'] }))).includes('high:locked_path'));
});

test('different repos never overlap; a run never overlaps itself', () => {
  assert.deepEqual(classifyPair(run('a', { touched_paths: ['a/b/c'] }), run('b', { repo_id: 'r2', touched_paths: ['a/b/c'] })), []);
  assert.deepEqual(classifyPair(run('a'), run('a')), []);
});

test('low: text similarity only when enabled (Phase 1.5 stub)', () => {
  const a = run('a', { title: 'Fix submit payload empty body', body: 'submit posts empty body to bank' });
  const b = run('b', { title: 'Submit payload empty', body: 'bank sees empty submit body' });
  assert.deepEqual(classifyPair(a, b), []);
  assert.deepEqual(reasons(classifyPair(a, b, { text: true })), ['low:text']);
  assert.ok(textSimilarity('a b c', 'x y z') === 0);
  assert.ok(Math.abs(textSimilarity('deals api fix', 'deals api fix') - 1) < 1e-9);
});

test('glob helpers', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/c.ts'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(pathMatches('src/api', 'src/api/x.ts'), 'a literal directory covers its files');
  assert.ok(!pathMatches('src/ap', 'src/api/x.ts'));
  assert.ok(patternsIntersect('src/**', 'src/api/*.ts'));
  assert.ok(!patternsIntersect('src/**', 'lib/**'));
  assert.ok(patternsIntersect('**/*.ts', 'lib/**'), 'a leading wildcard overlaps everything');
});

test('computeOverlaps: table rows with run_a < run_b, one per reason', () => {
  const rows = computeOverlaps([
    run('z', { touched_paths: ['src/api/deals.ts'], branch: 'dev' }),
    run('a', { touched_paths: ['src/api/deals.ts'], branch: 'dev' }),
    run('m', { repo_id: 'r2', touched_paths: ['src/api/deals.ts'] }),
  ]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.run_a, 'a');
    assert.equal(r.run_b, 'z');
    assert.equal(r.kind, 'overlapping');
  }
  assert.deepEqual(rows.map((r) => r.reason).sort(), ['same_branch', 'same_file']);
});

test('exit (k): both runs see the same-file overlap', () => {
  const a = run('a', { touched_paths: ['src/api/deals.ts'] });
  const b = run('b', { touched_paths: ['src/api/deals.ts'], owner_label: "James's Claude", card_key: 'BDL-139' });
  const rows = computeOverlaps([a, b]);
  const byId = new Map([[a.run_id, a], [b.run_id, b]]);
  const fromA = overlapsFor('a', rows, byId);
  const fromB = overlapsFor('b', rows, byId);
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.equal(fromA[0].other.card_key, 'BDL-139');
  assert.equal(fromA[0].kind, 'overlapping');
  assert.equal(overlapDelta(fromA[0]), "Heads-up: BDL-139 (James's Claude) is also editing src/api/deals.ts; avoid overlapping changes or ask via board_ask_human.");
  const block = teamContextBlock({ overlaps: fromA });
  assert.match(block.text, /\[overlapping\] BDL-139 \(James's Claude\) is also editing src\/api\/deals\.ts/);
});

test('team-context block: priority order and the ~700-token budget', () => {
  const ov = (key, kind) => ({ other: { card_key: key, owner_label: 'X' }, level: kind === 'overlapping' ? 'high' : 'medium', kind, reasons: [kind === 'overlapping' ? 'same_file' : 'same_dir'], paths: ['a/b/c.ts'] });
  const block = teamContextBlock({
    overlaps: [ov('ADJ-1', 'adjacent'), ov('OVL-1', 'overlapping')],
    memories: [{ kind: 'gotcha', body: 'stale one', status: 'stale', path: 'a/b' }, { kind: 'decision', body: 'use 422', status: 'active' }],
    handoffs: [{ card_key: 'BDL-1', text: 'r3 → r4' }],
  });
  const t = block.text;
  const order = ['OVL-1', 'ADJ-1', 'use 422', 'STALE', 'handoff BDL-1'].map((s) => t.indexOf(s));
  assert.ok(order.every((i) => i > 0), t);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.equal(block.dropped, 0);

  const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'convention', body: `memory number ${i} `.repeat(5), status: 'active' }));
  const capped = teamContextBlock({ overlaps: [ov('OVL-1', 'overlapping')], memories: many });
  assert.ok(capped.tokens <= TEAM_CONTEXT_BUDGET_TOKENS);
  assert.ok(capped.dropped > 0);
  assert.match(capped.text, /OVL-1/, 'overlaps survive the cut');
  assert.equal(teamContextBlock({}).text, '');
  assert.ok(teamContextBlock({ overlaps: [ov('OVL-1', 'overlapping')] }, 5).text === '', 'budget too small for header + one line');
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(kindOf('low'), 'adjacent');
});
