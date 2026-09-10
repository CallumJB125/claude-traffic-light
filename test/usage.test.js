const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../usage.js');

const T0 = new Date(2026, 8, 10, 12, 0, 0).getTime();
const iso = (t) => new Date(t).toISOString();
const line = (over = {}) => {
  const { usage, model = 'claude-opus-5', id = 'msg_1', requestId = 'req_1', ts = T0, ...rest } = over;
  return JSON.stringify({
    type: 'assistant', sessionId: 's1', cwd: '/Users/x/work/bondly', timestamp: iso(ts), requestId, uuid: `${id}-${Math.random()}`,
    message: { id, model, role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
    ...rest,
  });
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  for (const [rel, lines] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(''));
  }
  return root;
}

test('modelKey matches by family substring', () => {
  assert.equal(U.modelKey('claude-fable-5-1'), 'fable');
  assert.equal(U.modelKey('claude-opus-5'), 'opus');
  assert.equal(U.modelKey('claude-sonnet-5'), 'sonnet');
  assert.equal(U.modelKey('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(U.modelKey('<synthetic>'), null);
  assert.equal(U.modelKey('claude-fable-5'), 'fable-5');
  assert.equal(U.modelKey('claude-fable-5-20260101'), 'fable-5');
  assert.equal(U.modelKey('claude-opus-4-8'), 'opus');
});

test('legacy claude-fable-5 caches reads at $1/MTok, 4× Fable 5.1 (LiteLLM)', () => {
  const t = { input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0, cacheWrite1h: 0 };
  near(U.costOf({ ...t, modelKey: U.modelKey('claude-fable-5') }), 1);
  near(U.costOf({ ...t, modelKey: U.modelKey('claude-fable-5-1') }), 0.25);
  assert.equal(U.modelKey(undefined), null);
});

test('costOf prices each token class per model, with counterfactuals', () => {
  const t = { modelKey: 'opus', input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 0 };
  near(U.costOf(t), 5 + 25 + 0.5 + 6.25);
  near(U.costOf(t, 'sonnet'), 2 + 10 + 0.2 + 2.5);
  near(U.costOf(t, 'haiku'), 1 + 5 + 0.1 + 1.25);
  near(U.costOf(t, 'fable'), 10 + 50 + 0.25 + 12.5);
  assert.equal(U.costOf({ ...t, modelKey: null }), null);
});

test('1-hour cache writes cost 2× input; the rest at the 5-minute rate', () => {
  const t = { modelKey: 'sonnet', input: 0, output: 0, cacheRead: 0, cacheWrite: 3e6, cacheWrite1h: 1e6 };
  near(U.costOf(t), 2e6 * 2.5 / 1e6 + 1e6 * 2 * 2 / 1e6);
});

test('readTurns keeps the last write of a streamed message and dedupes across files', async () => {
  const root = fixture({
    '-Users-x-work-bondly/s1.jsonl': [
      JSON.stringify({ type: 'user', cwd: '/Users/x/work/bondly', sessionId: 's1', message: { role: 'user', content: 'hi' } }),
      line({ usage: { input_tokens: 10, output_tokens: 1 } }),
      line({ usage: { input_tokens: 10, output_tokens: 40 } }),
      line({ id: 'msg_2', requestId: 'req_2', usage: { input_tokens: 5, output_tokens: 5 } }),
    ],
    // a resumed session carries msg_1 over into its own file
    '-Users-x-work-bondly/s2.jsonl': [line({ usage: { input_tokens: 10, output_tokens: 40 }, sessionId: 's2' })],
  });
  const r = await U.readTurns({ root });
  assert.equal(r.files, 2);
  assert.equal(r.turns.length, 2);
  const m1 = r.turns.find((t) => t.id === 'msg_1:req_1');
  assert.equal(m1.output, 40);
  assert.equal(m1.project, 'bondly');
  assert.equal(m1.subagent, false);
});

test('readTurns reads the cache split and flags subagent transcripts', async () => {
  const root = fixture({
    'p/s1/subagents/agent-a1.jsonl': [line({ model: 'claude-haiku-4-5', cwd: undefined, usage: { cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } } })],
  });
  const [t] = (await U.readTurns({ root })).turns;
  assert.equal(t.subagent, true);
  assert.equal(t.project, 'p');
  assert.equal(t.cacheWrite, 300);
  assert.equal(t.cacheWrite1h, 200);
  assert.equal(t.modelKey, 'haiku');
});

test('readTurns re-parses only files whose mtime or size changed, and resumes appends', async () => {
  const root = fixture({
    'p/a.jsonl': [line({ usage: { output_tokens: 1 } })],
    'p/b.jsonl': [line({ id: 'msg_b', requestId: 'r_b', usage: { output_tokens: 2 } })],
  });
  const cache = new Map();
  assert.equal((await U.readTurns({ root, cache })).parsed, 2);
  assert.equal((await U.readTurns({ root, cache })).parsed, 0);
  fs.appendFileSync(path.join(root, 'p/a.jsonl'), `${line({ id: 'msg_a2', requestId: 'r_a2', usage: { output_tokens: 3 } })}\n`);
  const r = await U.readTurns({ root, cache });
  assert.equal(r.parsed, 1);
  assert.deepEqual(r.turns.map((t) => t.output).sort(), [1, 2, 3]);
});

test('readTurns drops cache entries for transcripts deleted or aged out of `since`', async () => {
  const root = fixture({
    'p/a.jsonl': [line({ usage: { output_tokens: 1 } })],
    'p/b.jsonl': [line({ id: 'msg_b', requestId: 'r_b', usage: { output_tokens: 2 } })],
    'p/c.jsonl': [line({ id: 'msg_c', requestId: 'r_c', usage: { output_tokens: 3 } })],
  });
  const cache = new Map();
  await U.readTurns({ root, cache });
  assert.equal(cache.size, 3);
  fs.rmSync(path.join(root, 'p/b.jsonl'));
  const old = new Date(T0 - 40 * 86400000);
  fs.utimesSync(path.join(root, 'p/c.jsonl'), old, old);
  const r = await U.readTurns({ root, cache, since: T0 - 30 * 86400000 });
  assert.deepEqual([...cache.keys()], [path.join(root, 'p/a.jsonl')]);
  assert.equal(r.parsed, 0, 'the surviving entry is still reused');
});

test('readTurns skips files over the size cap and files untouched since `since`', async () => {
  const root = fixture({ 'p/a.jsonl': [line({ usage: { output_tokens: 1 } })], 'p/old.jsonl': [line({ id: 'o', requestId: 'o', usage: { output_tokens: 1 } })] });
  const old = new Date(T0 - 40 * 86400000);
  fs.utimesSync(path.join(root, 'p/old.jsonl'), old, old);
  const r = await U.readTurns({ root, maxBytes: 10 });
  assert.equal(r.skipped.length, 2);
  assert.equal(r.turns.length, 0);
  const r2 = await U.readTurns({ root, since: T0 - 30 * 86400000 });
  assert.equal(r2.turns.length, 1);
});

test('spend gives Stats per-day, project and session cost matching summarise, and history only for days with turns', () => {
  const mk = (over) => ({ id: Math.random(), ts: T0, sessionId: 's1', project: 'bondly', model: 'claude-opus-5', modelKey: 'opus', input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...over });
  const turns = [
    mk({}), // $25
    mk({ sessionId: 's2', project: 'other', model: 'claude-sonnet-5', modelKey: 'sonnet' }), // $10
    mk({ ts: T0 - 2 * 86400000 }), // $25, two days ago, same session
    mk({ ts: T0 - 20 * 86400000 }), // $25, history only
  ];
  const sp = U.spend(turns, { now: T0 });
  const key = (t) => require('../stats.js').dayKey(t);
  assert.equal(sp.source, 'transcripts');
  assert.equal(Object.keys(sp.days).length, 7);
  near(sp.days[key(T0)].cost, 35);
  assert.deepEqual(sp.days[key(T0)].models, ['opus-5', 'sonnet-5']);
  near(Object.values(sp.days).reduce((a, d) => a + d.cost, 0), U.summarise(turns, { days: 7, now: T0 }).total.cost);
  assert.deepEqual(sp.projects.map((p) => [p.name, p.cost]), [['bondly', 50], ['other', 10]]);
  assert.deepEqual(sp.sessions.map((s) => [s.id, s.cost]), [['s1', 50], ['s2', 10]]);
  assert.deepEqual(Object.keys(sp.history).sort(), [key(T0 - 20 * 86400000), key(T0 - 2 * 86400000), key(T0)].sort());
  near(sp.history[key(T0 - 20 * 86400000)], 25);
});

test('summarise totals actual and counterfactual cost, savings range and unknown models', () => {
  const mk = (over) => ({ id: Math.random(), ts: T0, project: 'bondly', input: 0, output: 1e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...over });
  const turns = [
    mk({ modelKey: 'opus', model: 'claude-opus-5' }), // $25; sonnet $10; haiku $5
    mk({ modelKey: 'haiku', model: 'claude-haiku-4-5', project: 'other' }), // $5; sonnet $10 → no saving
    mk({ modelKey: null, model: 'gpt-x' }),
    mk({ modelKey: 'opus', model: 'claude-opus-5', ts: T0 - 20 * 86400000 }), // outside 7 days, inside baseline? no (14)
  ];
  const s = U.summarise(turns, { days: 7, baselineDays: 14, now: T0 });
  near(s.total.cost, 30);
  near(s.total.ifAll.sonnet, 20);
  near(s.total.ifAll.haiku, 10);
  near(s.total.savings.sonnet.high, 15);
  near(s.total.savings.sonnet.low, 25 - 10 * U.SLACK);
  near(s.total.savings.haiku.high, 20);
  assert.equal(s.unknown.turns, 1);
  assert.deepEqual(s.unknown.models, ['gpt-x']);
  assert.equal(s.byDay.length, 7);
  assert.equal(s.byDay[6].turns, 2);
  assert.deepEqual(s.byModel.map((m) => m.name), ['opus', 'haiku']);
  assert.deepEqual(s.byProject.map((p) => p.name), ['bondly', 'other']);
  assert.equal(s.baseline.turns, 2);
  near(s.baseline.mix.opus.share, 0.5);
  const s30 = U.summarise(turns, { days: 30, baselineDays: 30, now: T0 });
  assert.equal(s30.total.turns, 3);
  assert.equal(s30.baseline.turns, 3);
});
