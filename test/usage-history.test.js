const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const History = require('../usage-history.js');
const Usage = require('../usage.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-history-'));
const at = (s) => new Date(s).getTime();
let n = 0;
const turn = (over = {}) => ({
  id: `msg_${(n += 1)}:req`, ts: at('2026-09-22T10:15:00'), sessionId: 'sess-a', cwd: '/work/alpha', project: 'alpha',
  model: 'claude-opus-5-5', modelKey: 'opus', input: 100, output: 200, cacheRead: 1000, cacheWrite: 50, cacheWrite1h: 0, ...over,
});
const day = (store, d) => History.query(store, { from: d, to: d, groupBy: 'none' }).total;

test('history: recording the same turns twice gives the same totals', () => {
  const store = History.open({ root: tmp() });
  const turns = [turn(), turn({ output: 900 }), turn({ sessionId: 'sess-b' })];
  assert.deepEqual(History.record(store, turns), { added: 3, grown: 0 });
  const once = day(store, '2026-09-22');
  assert.deepEqual(History.record(store, turns), { added: 0, grown: 0 });
  assert.deepEqual(day(store, '2026-09-22'), once);
  assert.equal(once.turns, 3);
  assert.equal(once.sessions, 2);
  assert.equal(once.output, 1300);
});

test('history: a turn first seen mid-stream is topped up, not counted twice', () => {
  const store = History.open({ root: tmp() });
  const t = turn({ output: 10 });
  History.record(store, [t]);
  assert.equal(day(store, '2026-09-22').routineTurns, 1);
  assert.deepEqual(History.record(store, [{ ...t, output: 5000 }]), { added: 0, grown: 1 });
  const d = day(store, '2026-09-22');
  assert.equal(d.turns, 1);
  assert.equal(d.output, 5000);
  assert.equal(d.routineTurns, 0, 'it grew past routine');
  // an older, smaller copy (a resumed session's) never takes anything back
  History.record(store, [{ ...t, output: 10 }]);
  assert.equal(day(store, '2026-09-22').output, 5000);
});

test('history: transcripts going away never shrink a recorded day', () => {
  const root = tmp();
  const store = History.open({ root });
  const turns = [turn(), turn(), turn({ ts: at('2026-09-23T09:00:00') })];
  History.record(store, turns);
  History.flush(store);
  const again = History.open({ root });
  History.record(again, turns.slice(2)); // the 22nd's transcript was deleted
  History.flush(again);
  const reread = History.open({ root });
  assert.equal(day(reread, '2026-09-22').turns, 2);
  assert.equal(day(reread, '2026-09-23').turns, 1);
});

test('history: the record survives a reopen, and files are private', () => {
  const root = tmp();
  const store = History.open({ root });
  History.record(store, [turn(), turn({ ts: at('2026-08-31T23:30:00') })]);
  assert.equal(History.flush(store), 2);
  assert.equal(History.flush(store), 0, 'nothing dirty');
  const files = fs.readdirSync(path.join(root, 'usage', 'daily')).sort();
  assert.deepEqual(files, ['2026-08.ids.json', '2026-08.json', '2026-09.ids.json', '2026-09.json']);
  for (const f of files) assert.equal(fs.statSync(path.join(root, 'usage', 'daily', f)).mode & 0o777, 0o600);
  const q = History.query(History.open({ root }), { from: '2026-08-01', to: '2026-09-30' });
  assert.deepEqual(q.rows.map((r) => [r.key, r.turns]), [['2026-08-31', 1], ['2026-09-22', 1]]);
  assert.deepEqual(History.extent(History.open({ root })), { from: '2026-08-31', to: '2026-09-22' });
  // no prompt or reply text, only numbers, model ids and project paths
  const raw = fs.readFileSync(path.join(root, 'usage', 'daily', '2026-09.json'), 'utf8');
  assert.doesNotMatch(raw, /sess-a|msg_/);
});

test('history: cost is priced at read time, so a price change re-prices history', () => {
  const store = History.open({ root: tmp() });
  const t = turn({ cacheWrite: 1000, cacheWrite1h: 400 });
  History.record(store, [t]);
  const before = day(store, '2026-09-22');
  assert.equal(before.cost, Math.round(Usage.costOf(t, 'opus') * 1e4) / 1e4);
  const saved = { ...Usage.PRICES.opus };
  try {
    Usage.PRICES.opus.output = 50;
    const after = day(store, '2026-09-22');
    assert.ok(after.cost > before.cost);
    assert.equal(after.output, before.output, 'tokens unchanged');
  } finally { Object.assign(Usage.PRICES.opus, saved); }
});

test('history: exact model ids are kept, families roll them up; unknown models are unpriced, never dropped', () => {
  const store = History.open({ root: tmp() });
  History.record(store, [turn({ model: 'claude-opus-5' }), turn({ model: 'claude-opus-5-5' }), turn({ model: 'mystery-9', modelKey: null })]);
  const byModel = History.query(store, { from: '2026-09-22', to: '2026-09-22', groupBy: 'model' });
  assert.deepEqual(byModel.rows.map((r) => r.key).sort(), ['claude-opus-5', 'claude-opus-5-5', 'mystery-9']);
  const byFamily = History.query(store, { from: '2026-09-22', to: '2026-09-22', groupBy: 'family' });
  assert.deepEqual(byFamily.rows.map((r) => [r.key, r.turns]).sort(), [['opus', 2], ['unpriced', 1]]);
  assert.equal(byModel.total.unpricedTurns, 1);
  assert.equal(byModel.total.unpricedTokens, 1350);
  assert.deepEqual(byModel.unpricedModels, ['mystery-9']);
});

test('history: stats.json cost-only days import as legacy; the record wins where it has turns', () => {
  const store = History.open({ root: tmp() });
  History.record(store, [turn()]);
  const imported = History.importLegacy(store, { '2026-09-22': { cost: 999 }, '2026-09-10': { cost: 12.5 }, '2026-09-11': { cost: 0 }, 'junk': { cost: 3 } });
  assert.equal(imported, 1);
  const q = History.query(store, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(q.legacyDays, 1);
  assert.deepEqual(q.rows.find((r) => r.key === '2026-09-10'), { ...q.rows.find((r) => r.key === '2026-09-10'), cost: 12.5, legacyCost: 12.5, turns: 0 });
  assert.ok(q.rows.find((r) => r.key === '2026-09-22').cost < 999);
  // a later import never lowers a legacy day
  History.importLegacy(store, { '2026-09-10': { cost: 2 } });
  assert.equal(History.query(store, { from: '2026-09-10', to: '2026-09-10' }).total.cost, 12.5);
  // a project filter leaves out legacy days (they have no projects)
  assert.equal(History.query(store, { from: '2026-09-01', to: '2026-09-30', project: '/work/alpha' }).legacyDays, 0);
});

test('history: grouping by project, hour and weekday×hour adds up to the total', () => {
  const store = History.open({ root: tmp() });
  History.record(store, [turn(), turn({ ts: at('2026-09-22T22:05:00'), cwd: '/work/beta' }), turn({ ts: at('2026-09-26T08:00:00') })]);
  const opts = { from: '2026-09-21', to: '2026-09-27' };
  const byProject = History.query(store, { ...opts, groupBy: 'project' });
  assert.deepEqual(byProject.rows.map((r) => [r.key, r.turns]), [['/work/alpha', 2], ['/work/beta', 1]]);
  const hours = History.query(store, { ...opts, groupBy: 'hour' });
  assert.deepEqual(hours.rows.map((r) => [r.key, r.turns]).sort(), [['10', 1], ['22', 1], ['8', 1]]);
  const grid = History.query(store, { ...opts, groupBy: 'weekday-hour' });
  assert.deepEqual(grid.rows.map((r) => r.key).sort(), ['2:10', '2:22', '6:8']);
  const sum = grid.rows.reduce((a, r) => a + r.cost, 0);
  assert.ok(Math.abs(sum - grid.total.cost) < 1e-3);
  assert.throws(() => History.query(store, { groupBy: 'colour' }));
});

test('history: day keys follow local time, including across a DST change', () => {
  // America/New_York falls back on 2026-11-01: 01:30 happens twice.
  const script = `
    const H = require(${JSON.stringify(path.join(__dirname, '..', 'usage-history.js'))});
    const s = H.open({ root: ${JSON.stringify(tmp())} });
    const t = (id, iso) => ({ id, ts: Date.parse(iso), model: 'claude-opus-5-5', cwd: '/w', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    H.record(s, [t('a', '2026-11-01T05:30:00Z'), t('b', '2026-11-01T06:30:00Z'), t('c', '2026-11-02T04:59:00Z'), t('d', '2026-11-02T05:01:00Z')]);
    const q = H.query(s, { from: '2026-10-31', to: '2026-11-03' });
    const h = H.query(s, { from: '2026-11-01', to: '2026-11-01', groupBy: 'hour' });
    console.log(JSON.stringify({ days: q.rows.map((r) => [r.key, r.turns]), hours: h.rows.map((r) => [r.key, r.turns]) }));`;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.days, [['2026-11-01', 3], ['2026-11-02', 1]]);
  assert.deepEqual(out.hours, [['1', 2], ['23', 1]], 'both 01:30s are hour 1 local');
});

test('history: a year of data queries in well under 100 ms', () => {
  const store = History.open({ root: tmp() });
  const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
  const turns = [];
  const start = at('2025-10-01T09:00:00');
  for (let d = 0; d < 365; d += 1) {
    for (let k = 0; k < 40; k += 1) turns.push(turn({ ts: start + d * 86400000 + k * 600000, model: models[k % 3], cwd: `/work/p${k % 6}`, sessionId: `s${d}-${k % 5}` }));
  }
  History.record(store, turns);
  for (const groupBy of ['day', 'family', 'project', 'weekday-hour']) {
    const t0 = process.hrtime.bigint();
    const q = History.query(store, { from: '2025-10-01', to: '2026-09-30', groupBy });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(q.total.turns, 365 * 40);
    assert.ok(ms < 100, `${groupBy} took ${ms.toFixed(1)} ms`);
  }
});

test('history: turns without an id or time are skipped, not guessed at', () => {
  const store = History.open({ root: tmp() });
  assert.deepEqual(History.record(store, [turn({ id: null }), turn({ ts: 0 }), null, turn()]), { added: 1, grown: 0 });
});

test('history: catch-up reads transcripts into the record in yielding batches, and is idempotent', async () => {
  const projects = tmp();
  const line = (id, ts, output, model = 'claude-sonnet-5-5') => JSON.stringify({ type: 'assistant', uuid: `u-${id}`, requestId: `r-${id}`, sessionId: 'sess-x', cwd: '/work/gamma', timestamp: ts, message: { id: `m-${id}`, model, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  for (let p = 0; p < 3; p += 1) {
    const dir = path.join(projects, `-work-p${p}`);
    fs.mkdirSync(dir, { recursive: true });
    // streaming: the same message twice, usage growing; the last one wins
    fs.writeFileSync(path.join(dir, `s${p}.jsonl`), [line(`${p}a`, '2026-09-20T10:00:00Z', 5), line(`${p}a`, '2026-09-20T10:00:00Z', 50), line(`${p}b`, '2026-09-21T10:00:00Z', 7), ''].join('\n'));
  }
  const root = tmp();
  const store = History.open({ root });
  const progress = [];
  const r = await History.catchUp(store, { root: projects, batch: 2, onProgress: (p) => progress.push(p) });
  assert.deepEqual({ files: r.files, read: r.read, added: r.added }, { files: 3, read: 3, added: 6 });
  assert.deepEqual(progress, [{ done: 2, of: 3 }, { done: 3, of: 3 }]);
  const q = History.query(History.open({ root }), { from: '2026-09-19', to: '2026-09-22', groupBy: 'none' });
  assert.equal(q.total.turns, 6);
  assert.equal(q.total.output, 3 * (50 + 7));
  const again = await History.catchUp(History.open({ root }), { root: projects });
  assert.equal(again.added, 0);
});
