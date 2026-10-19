'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Usage = require('../usage.js');
const ModelMix = require('../src/model-mix.js');
const Mcp = require('../mcp-server.js');

// The implementation as it stood in usage.js before the extraction, frozen
// here so the shared module is held to byte-identical output.
const legacy = (() => {
// ── Model mix ──────────────────────────────────────────────────────────────
// Read-only: which models your turns ran on and what they cost, today and
// over the last 7 days, plus one recommendation. A "routine" turn is one that
// wrote a short reply on little new context (a tool round-trip, a quick
// answer): the kind a cheaper model usually handles as well.
const ROUTINE_OUTPUT = 400;
const ROUTINE_NEW_INPUT = 4000;
const DAY_MS = 86400000;
const isRoutine = (t) => t.output <= ROUTINE_OUTPUT && t.input + t.cacheWrite <= ROUTINE_NEW_INPUT;
const family = (k) => (k === 'fable-5' ? 'fable' : k);
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

function modelMix(turns, { now = Date.now() } = {}) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const windowOf = (from) => {
    const models = {};
    let cost = 0, count = 0;
    for (const t of turns) {
      if (t.ts < from || t.ts > now) continue;
      const c = Usage.costOf(t);
      if (c == null) continue;
      const m = models[family(t.modelKey)] || (models[family(t.modelKey)] = { turns: 0, cost: 0 });
      m.turns += 1;
      m.cost += c;
      cost += c;
      count += 1;
    }
    const list = Object.entries(models).map(([name, m]) => ({ name, turns: m.turns, cost: r2(m.cost), share: count ? m.turns / count : 0 })).sort((a, b) => b.cost - a.cost);
    return { from, turns: count, cost: r2(cost), models: list };
  };
  const today = windowOf(startOfDay(now));
  const weekFrom = startOfDay(now - 6 * DAY_MS);
  const week = windowOf(weekFrom);
  let opus = 0, routine = 0, low = 0, high = 0;
  for (const t of turns) {
    if (t.ts < weekFrom || t.ts > now || t.modelKey !== 'opus') continue;
    opus += 1;
    if (!isRoutine(t)) continue;
    routine += 1;
    const cost = Usage.costOf(t);
    const sonnet = Usage.costOf(t, 'sonnet');
    low += Math.max(0, cost - sonnet * Usage.SLACK);
    high += Math.max(0, cost - sonnet);
  }
  const share = opus ? routine / opus : 0;
  const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
  const range = money(low) === money(high) ? money(high) : `${money(low)}–${money(high)}`;
  const recommendation = !opus
    ? 'No Opus turns in the last 7 days — nothing to suggest.'
    : !routine
      ? 'Your Opus turns in the last 7 days all did substantial work — Opus looks well spent.'
      : `${Math.round(share * 100)}% of your Opus turns in the last 7 days looked routine (short reply, little new context); on Sonnet they would have cost about ${range} less.`;
  return { today, week, opus: { turns: opus, routine, share, saving: { low: r2(low), high: r2(high) } }, recommendation };
}

  return modelMix;
})();

const NOW = new Date(2026, 9, 19, 15, 0).getTime();
const H = 3600000;
const turn = (o) => ({ ts: NOW - H, model: 'claude-opus-4-1', modelKey: 'opus', input: 200, output: 150, cacheRead: 30000, cacheWrite: 500, cacheWrite1h: 0, ...o });
const fixtures = [
  [],
  [turn({}), turn({ output: 9000 }), turn({ ts: NOW - 30 * H, input: 9000 })],
  [turn({}), turn({ model: 'claude-sonnet-4-5', modelKey: 'sonnet' }), turn({ model: 'claude-fable-5', modelKey: 'fable-5' }), turn({ model: 'x', modelKey: null }), turn({ ts: NOW - 9 * 24 * H }), turn({ ts: NOW + H })],
  Array.from({ length: 40 }, (_, i) => turn({ ts: NOW - i * 4 * H, output: (i * 97) % 900, cacheRead: 1000 * i, cacheWrite: (i * 311) % 6000 })),
  [turn({ output: 9000 }), turn({ input: 5000 })],
];

test('model-mix: modelMix output is byte-identical to the pre-extraction implementation', () => {
  for (const f of fixtures) {
    assert.equal(JSON.stringify(ModelMix.modelMix(f, { now: NOW })), JSON.stringify(legacy(f, { now: NOW })));
    assert.equal(JSON.stringify(Usage.modelMix(f, { now: NOW })), JSON.stringify(legacy(f, { now: NOW })), 'usage.js still answers the same');
  }
});

test('model-mix: buddy_model_mix tool output is unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  const proj = path.join(dir, '-Users-a-shop');
  fs.mkdirSync(proj);
  const line = (i, out) => JSON.stringify({ type: 'assistant', uuid: `u${i}`, requestId: `r${i}`, sessionId: 's1', cwd: '/Users/a/shop', timestamp: new Date(NOW - i * H).toISOString(), message: { id: `m${i}`, model: 'claude-opus-4-1', usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 20000 } } });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), [line(1, 50), line(2, 5000), line(3, 120)].join('\n') + '\n');
  const got = await Mcp.buddyModelMix({ now: NOW, projectsDir: dir });
  const { turns, files, skipped } = await Usage.readTurns({ since: NOW - 8 * 86400000, root: dir });
  assert.equal(JSON.stringify(got), JSON.stringify({ ...legacy(turns, { now: NOW }), transcripts: { files, turns: turns.length, overSizeCap: skipped.length } }));
  assert.equal(got.opus.turns, 3);
  assert.equal(got.opus.routine, 2);
});

test('model-mix: routineEstimate and the saving line', () => {
  const e = ModelMix.routineEstimate([turn({}), turn({}), turn({ output: 9000 }), turn({ modelKey: 'sonnet' })], { from: NOW - 24 * H, now: NOW });
  assert.equal(e.turns, 3);
  assert.equal(e.routine, 2);
  assert.ok(e.saving.high >= e.saving.low && e.saving.high > 0);
  assert.match(ModelMix.savingLine(e), /^About 67% of this week's Opus turns looked routine; Sonnet would have cost \$\d+\.\d\d(–\$\d+\.\d\d)? less\.$/);
  assert.equal(ModelMix.savingLine(ModelMix.routineEstimate([turn({ output: 9000 })], { from: 0, now: NOW })), null);
  assert.equal(ModelMix.savingLine(ModelMix.routineEstimate([], { from: 0, now: NOW })), null);
});
