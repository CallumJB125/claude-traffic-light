'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const C = require('../src/compaction');
const { createLedger, MAX_ENTRIES } = require('../src/compaction-stats');
const { createInteractionHub } = require('../src/session-interaction');
const { createCodexAppServer } = require('../src/codex-app-server');

const ACTOR = 'overview:1:1';
const FAKE = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');
const ON = { enabled: true, providers: { mem: true, codex: true, local: true }, threshold: 0.5, minTurns: 1, keepTurns: 2 };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-compaction-test-'));

// 'mem' is not a real provider: normalizeSettings only keeps known ones, so
// the hub tests use provider id 'codex' with an in-memory adapter.
function memAdapter({ compactThrows = false } = {}) {
  const ee = new EventEmitter(); let n = 0; const calls = [], compacts = [], interrupts = [];
  return {
    label: 'Mem', calls, compacts, interrupts,
    capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false, compact: true },
    emit: (e) => ee.emit('e', e),
    open: async () => ({ target: `target-${++n}` }),
    async send(a) { calls.push(a); return { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    async compact(a) { compacts.push(a); if (compactThrows) throw new Error('provider refused'); return true; },
    interrupt: async (a) => { interrupts.push(a); return true; }, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
async function setup({ settings = ON, adapterOpts, compactorOpts = {} } = {}) {
  const adapter = memAdapter(adapterOpts), records = [];
  let current = settings;
  const ledger = { record: (e) => records.push(e) };
  const compaction = C.createSessionCompactor({ settings: () => current, ledger, ...compactorOpts });
  const hub = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: (b) => b === null, compaction });
  const a = (await hub.launch({ provider: 'codex' }, ACTOR)).state;
  const msg = (text = 'hello') => ({ session: a.session, generation: a.generation, text });
  const target = () => hub.targetOf(a.session);
  // One user turn: ack, usage report, completion.
  async function turn(inputTokens, window = 10000) {
    const r = await hub.send(msg(), ACTOR);
    assert.equal(r.status, 'acknowledged');
    const turnId = adapter.calls.length ? `turn-${adapter.calls.length}` : null;
    adapter.emit({ kind: 'usage', target: target(), turnId, inputTokens, window });
    adapter.emit({ kind: 'turn-completed', target: target(), turnId, status: 'completed' });
    await tick();
    return turnId;
  }
  const compactTurn = (id = 'compact-1') => adapter.emit({ kind: 'turn-started', target: target(), turnId: id });
  const finishCompact = (id = 'compact-1', status = 'completed', compacted = true) => {
    if (compacted) adapter.emit({ kind: 'compacted', target: target(), turnId: id });
    adapter.emit({ kind: 'usage', target: target(), turnId: id, inputTokens: 0, window: 10000 });
    adapter.emit({ kind: 'turn-completed', target: target(), turnId: id, status });
  };
  return { hub, adapter, records, a, msg, target, turn, compactTurn, finishCompact, set: (s) => { current = s; }, state: () => hub.state({ session: a.session }, ACTOR) };
}

// ── Policy ──
test('Policy: settings default OFF and are clamped', () => {
  const d = C.normalizeSettings(undefined);
  assert.equal(d.enabled, false); assert.deepEqual(Object.values(d.providers), [false, false, false, false]);
  assert.equal(d.threshold, 0.55);
  assert.equal(C.normalizeSettings({ threshold: 5 }).threshold, 0.95);
  assert.equal(C.normalizeSettings({ threshold: -1 }).threshold, 0.01);
  assert.equal(C.normalizeSettings({ threshold: 'x' }).threshold, 0.55);
  assert.equal(C.normalizeSettings({ providers: { codex: 'yes', evil: true } }).providers.codex, false);
  assert.equal('evil' in C.normalizeSettings({ providers: { evil: true } }).providers, false);
});
test('Policy: compacts only when on, idle, enough turns, and over the threshold', () => {
  const base = { settings: ON, provider: 'codex', contextTokens: 6000, window: 10000, turns: 3 };
  assert.deepEqual(C.shouldCompact(base).go, true);
  assert.equal(C.shouldCompact({ ...base, settings: { ...ON, enabled: false } }).reason, 'off');
  assert.equal(C.shouldCompact({ ...base, settings: { ...ON, providers: { codex: false } } }).reason, 'off');
  assert.equal(C.shouldCompact({ ...base, busy: true }).reason, 'mid-turn');
  assert.equal(C.shouldCompact({ ...base, compacting: true }).reason, 'running');
  assert.equal(C.shouldCompact({ ...base, contextTokens: 4000 }).reason, 'under-threshold');
  assert.equal(C.shouldCompact({ ...base, window: null }).reason, 'unknown-fill');
  assert.equal(C.shouldCompact({ ...base, contextTokens: undefined }).reason, 'unknown-fill');
  assert.equal(C.shouldCompact({ ...base, turns: 0 }).reason, 'few-turns');
});

// ── Ledger ──
test('Ledger: savings arithmetic per provider and total, estimates kept apart, $ labelled estimate', () => {
  const l = createLedger({ prices: () => ({ codex: 2 }) });
  l.record({ provider: 'codex', before: 10000, after: 4000, source: 'provider', at: 1 });
  l.record({ provider: 'codex', before: 3000, after: 3500, source: 'provider', at: 2 }); // grew: counted honestly
  l.record({ provider: 'codex', before: null, after: null, source: 'provider', at: 3 }); // unmeasured
  l.record({ provider: 'local', before: 800, after: 100, source: 'estimate', at: 4 });
  const s = l.summary();
  assert.equal(s.providers.codex.compactions, 3); assert.equal(s.providers.codex.measured, 2);
  assert.equal(s.providers.codex.savedTokens, 5500);
  assert.equal(s.providers.codex.estimatedDollars, 5500 * 2 / 1e6);
  assert.equal(s.providers.local.estimatedTokens, 700); assert.equal(s.providers.local.savedTokens, 0);
  assert.equal(s.total.savedTokens, 5500); assert.equal(s.total.estimatedTokens, 700); assert.equal(s.total.compactions, 4);
  assert.equal(s.dollarsAreEstimates, true);
  assert.equal(s.last.provider, 'local'); assert.equal(s.last.saved, 700);
});
test('Ledger: refuses junk and never invents a number', () => {
  const l = createLedger();
  assert.equal(l.record({ provider: 'nope', before: 1, after: 0, source: 'provider', at: 1 }), null);
  assert.equal(l.record({ provider: 'codex', before: 1, after: 0, source: 'guess', at: 1 }), null);
  const e = l.record({ provider: 'codex', before: 500, after: -3, source: 'provider', at: 1 });
  assert.equal(e.saved, null); assert.equal(e.before, null);
  assert.equal(l.summary().total.savedTokens, 0); assert.equal(l.summary().total.measured, 0);
});
test('Ledger: bounded entries, totals survive the bound, persistence round-trip, no text stored', () => {
  const file = path.join(tmp(), 'compaction-stats.json');
  const l = createLedger({ file });
  for (let i = 0; i < MAX_ENTRIES + 25; i++) l.record({ provider: 'codex', before: 100, after: 40, source: 'provider', at: i, text: 'SECRET-PROMPT', summary: 'SECRET-SUMMARY', target: 'thread-xyz' });
  assert.equal(l.entries().length, MAX_ENTRIES);
  const raw = fs.readFileSync(file, 'utf8');
  for (const leak of ['SECRET', 'thread-xyz', 'text', 'summary']) assert(!raw.includes(leak), leak);
  const again = createLedger({ file });
  assert.equal(again.summary().total.compactions, MAX_ENTRIES + 25);
  assert.equal(again.summary().total.savedTokens, 60 * (MAX_ENTRIES + 25));
  assert.equal(again.entries().length, MAX_ENTRIES);
  fs.writeFileSync(file, '{not json');
  assert.equal(createLedger({ file }).summary().total.compactions, 0);
  fs.writeFileSync(file, JSON.stringify({ v: 1, totals: { codex: { compactions: 'x', savedTokens: 1e400 } }, entries: [{ provider: 'codex', source: 'provider', at: 1, before: 5, after: 2, text: 'leak' }] }));
  const odd = createLedger({ file });
  assert.equal(odd.summary().providers.codex.compactions, 0);
  assert.equal('text' in odd.entries()[0], false);
});

// ── Generic summarise-and-replace (Plexiform-held histories) ──
const hist = (n, size = 400) => Array.from({ length: n }, (_, i) => [{ role: 'user', text: `q${i} ${'x'.repeat(size)}` }, { role: 'assistant', text: `a${i} ${'y'.repeat(size)}` }]).flat();
function local(over = {}) {
  const records = [], calls = [];
  let settings = ON;
  const hc = C.createHistoryCompactor({ provider: 'local', window: () => 2000, settings: () => settings, ledger: { record: (e) => records.push(e) }, summarise: async (older) => { calls.push(older.length); return 'short summary'; }, ...over });
  return { hc, records, calls, set: (s) => { settings = s; } };
}
test('History: builds in the background and swaps at the next send, keeping the last N turns verbatim', async () => {
  const x = local(), h = hist(6);
  assert.deepEqual((await x.hc.prepare('s', h)), { ok: true, reason: 'ready' });
  const out = x.hc.swap('s', h);
  assert.equal(out.swapped, true);
  assert.equal(out.history[0].compacted, true); assert.match(out.history[0].text, /short summary/);
  assert.deepEqual(out.history.slice(1), h.slice(-4));
  assert.equal(x.records.length, 1); assert.equal(x.records[0].source, 'estimate');
  assert(x.records[0].before > x.records[0].after);
  assert(!JSON.stringify(x.records).includes('short summary'));
  assert.equal(x.hc.swap('s', h).swapped, false, 'a summary is used once');
});
test('History: no model call unless compaction actually triggers', async () => {
  const x = local();
  assert.equal((await x.hc.prepare('s', hist(1, 10))).ok, false);
  x.set({ ...ON, enabled: false });
  assert.equal((await x.hc.prepare('s', hist(6))).reason, 'off');
  assert.equal((await x.hc.prepare('s', hist(6), { busy: true })).reason, 'off');
  x.set(ON);
  assert.equal((await x.hc.prepare('s', hist(6), { busy: true })).reason, 'mid-turn');
  assert.equal(x.calls.length, 0);
});
test('Hostile history: summary failure, timeout and empty summary leave history untouched', async () => {
  for (const summarise of [async () => { throw new Error('model down'); }, async () => '   ', async () => 42, () => new Promise(() => {})]) {
    const x = local({ summarise, timeoutMs: 30 }), h = hist(6);
    assert.equal((await x.hc.prepare('s', h)).reason, 'summary-failed');
    const out = x.hc.swap('s', h);
    assert.equal(out.swapped, false); assert.equal(out.history, h);
    assert.equal(x.records.length, 0);
  }
});
test('Hostile history: oversized summary is rejected', async () => {
  const x = local({ summarise: async (older) => older.map((m) => m.text).join('\n') });
  assert.equal((await x.hc.prepare('s', hist(6))).reason, 'summary-too-long');
  const y = local({ summarise: async () => 'z'.repeat(40000), maxSummaryRatio: 100 });
  assert.equal((await y.hc.prepare('s', hist(60))).reason, 'summary-too-long');
  assert.equal(x.hc.swap('s', hist(6)).swapped, false);
});
test('Hostile history: history changed while building (racing send) is stale, never swapped', async () => {
  let release;
  const x = local({ summarise: () => new Promise((r) => { release = () => r('sum'); }) });
  const h = hist(6);
  const p = x.hc.prepare('s', h);
  await tick();
  assert.equal(x.hc.swap('s', h).reason, 'building', 'a send during the build goes out uncompacted');
  release(); await p;
  const edited = h.map((m, i) => (i === 0 ? { ...m, text: 'edited' } : m));
  assert.equal(x.hc.swap('s', edited).reason, 'stale');
  assert.equal(x.records.length, 0);
});
test('Hostile history: toggle off mid-flight stops the swap; closed session drops the build', async () => {
  let release;
  const x = local({ summarise: () => new Promise((r) => { release = () => r('sum'); }) });
  const h = hist(6);
  const p = x.hc.prepare('s', h); await tick();
  x.set({ ...ON, enabled: false });
  release(); await p;
  assert.equal(x.hc.swap('s', h).reason, 'off');
  x.set(ON);
  const q = x.hc.prepare('t', h); await tick();
  x.hc.drop('t');
  release(); assert.equal((await q).reason, 'stale');
  assert.equal(x.hc.swap('t', h).swapped, false);
  assert.equal(x.records.length, 0);
});
test('Hostile history: a newer generation replaces an older in-flight build', async () => {
  const resolvers = [];
  const x = local({ summarise: () => new Promise((r) => resolvers.push(r)) });
  const h = hist(6), h2 = hist(7);
  const p1 = x.hc.prepare('s', h); await tick();
  x.hc.drop('s');
  const p2 = x.hc.prepare('s', h2); await tick();
  resolvers[0]('old'); assert.equal((await p1).reason, 'stale');
  resolvers[1]('new'); assert.equal((await p2).ok, true);
  const out = x.hc.swap('s', h2);
  assert.match(out.history[0].text, /new/);
});

// ── Owned sessions through the interaction hub ──
test('Hub: off by default never compacts', async () => {
  const x = await setup({ settings: C.DEFAULTS });
  await x.turn(9000);
  assert.equal(x.adapter.compacts.length, 0);
});
test('Hub: over threshold after an idle turn compacts in the background; saving measured from provider usage', async () => {
  const x = await setup();
  await x.turn(3000);
  assert.equal(x.adapter.compacts.length, 0, 'under threshold');
  await x.turn(7000);
  assert.equal(x.adapter.compacts.length, 1);
  assert.equal(x.adapter.compacts[0].target, x.target());
  assert.equal(x.state().status, 'compacting');
  x.compactTurn();
  x.finishCompact();
  assert.equal(x.state().status, 'ready');
  assert.equal(x.state().deliveries.length, 2, 'the compaction turn is never a delivery');
  assert.equal(x.records.length, 0, 'not recorded until the next turn reports usage');
  await x.turn(2500);
  assert.deepEqual(x.records.map(({ provider, before, after, source }) => ({ provider, before, after, source })), [{ provider: 'codex', before: 7000, after: 2500, source: 'provider' }]);
});
test('Hub: never compacts mid-turn', async () => {
  const x = await setup();
  await x.hub.send(x.msg(), ACTOR);
  x.adapter.emit({ kind: 'usage', target: x.target(), turnId: 'turn-1', inputTokens: 9000, window: 10000 });
  await tick();
  assert.equal(x.adapter.compacts.length, 0);
});
test('Hostile hub: a send racing a compaction waits for it, then goes out on the compacted context', async () => {
  const x = await setup();
  await x.turn(8000); x.compactTurn();
  const sending = x.hub.send(x.msg('next'), ACTOR);
  await tick();
  assert.equal(x.adapter.calls.length, 1, 'held until the compaction ends');
  assert.equal((await x.hub.send(x.msg('third'), ACTOR)).status, 'busy');
  x.finishCompact();
  assert.equal((await sending).status, 'acknowledged');
  assert.equal(x.adapter.calls.length, 2);
});
test('Hostile hub: a compaction that outlasts the send wait is interrupted and the send goes ahead', async () => {
  const x = await setup({ compactorOpts: { sendWaitMs: 20, settleMs: 20 } });
  await x.turn(8000); x.compactTurn();
  const r = await x.hub.send(x.msg('next'), ACTOR);
  assert.equal(r.status, 'acknowledged');
  assert.deepEqual(x.adapter.interrupts.map((i) => i.turnId), ['compact-1']);
  x.finishCompact('compact-1', 'interrupted', false);
  x.adapter.emit({ kind: 'usage', target: x.target(), turnId: 'turn-2', inputTokens: 8100, window: 10000 });
  assert.equal(x.records.length, 0, 'an abandoned compaction records nothing');
});
test('Hostile hub: summary failure (provider error or failed turn) rolls back, nothing recorded', async () => {
  const x = await setup({ adapterOpts: { compactThrows: true } });
  await x.turn(8000);
  await tick();
  assert.equal(x.state().status, 'ready');
  const y = await setup();
  await y.turn(8000); y.compactTurn();
  y.finishCompact('compact-1', 'failed', false);
  assert.equal(y.state().status, 'ready');
  await y.turn(8200);
  assert.equal(y.records.length, 0);
  const z = await setup();
  await z.turn(8000); z.compactTurn();
  z.finishCompact('compact-1', 'completed', false); // completed but no compaction item: not claimed
  await z.turn(8200);
  assert.equal(z.records.length, 0);
});
test('Hostile hub: closing a session mid-compaction interrupts it and records nothing', async () => {
  const x = await setup();
  await x.turn(8000); x.compactTurn();
  const t = x.target();
  assert.equal((await x.hub.close({ session: x.a.session, generation: x.a.generation }, ACTOR)).status, 'closed');
  assert(x.adapter.interrupts.some((i) => i.turnId === 'compact-1' && i.target === t));
  x.adapter.emit({ kind: 'compacted', target: t, turnId: 'compact-1' });
  x.adapter.emit({ kind: 'turn-completed', target: t, turnId: 'compact-1', status: 'completed' });
  x.adapter.emit({ kind: 'usage', target: t, turnId: 'turn-9', inputTokens: 100, window: 10000 });
  assert.equal(x.records.length, 0);
});
test('Hostile hub: toggle off mid-flight stops the compaction', async () => {
  const x = await setup();
  await x.turn(8000); x.compactTurn();
  x.set({ ...ON, enabled: false });
  const stopping = x.hub.compactionSettingsChanged();
  await tick();
  assert.deepEqual(x.adapter.interrupts.map((i) => i.turnId), ['compact-1']);
  x.finishCompact('compact-1', 'interrupted', false);
  await stopping;
  assert.equal(x.state().status, 'ready');
  await x.turn(9000);
  assert.equal(x.adapter.compacts.length, 1, 'off: no new compaction');
  assert.equal(x.records.length, 0);
});
test('Hostile hub: a stale generation (target replaced) never records the old compaction', async () => {
  const x = await setup();
  await x.turn(8000); x.compactTurn();
  const old = x.target();
  assert.equal(await x.hub.replaceTarget(x.a.session), true);
  assert.notEqual(x.target(), old);
  x.adapter.emit({ kind: 'compacted', target: old, turnId: 'compact-1' });
  x.adapter.emit({ kind: 'turn-completed', target: old, turnId: 'compact-1', status: 'completed' });
  assert.equal(x.state().generation, 2); assert.equal(x.state().status, 'ready');
  const r = await x.hub.send({ session: x.a.session, generation: 2, text: 'hi' }, ACTOR);
  assert.equal(r.status, 'acknowledged');
  x.adapter.emit({ kind: 'usage', target: x.target(), turnId: `turn-${x.adapter.calls.length}`, inputTokens: 100, window: 10000 });
  assert.equal(x.records.length, 0);
});
test('Hostile hub: a provider without compact capability is never asked', async () => {
  const adapter = memAdapter(); adapter.capabilities = { ...adapter.capabilities, compact: false };
  const compaction = C.createSessionCompactor({ settings: () => ON });
  const hub = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: (b) => b === null, compaction });
  const a = (await hub.launch({ provider: 'codex' }, ACTOR)).state;
  await hub.send({ session: a.session, generation: a.generation, text: 'x' }, ACTOR);
  adapter.emit({ kind: 'usage', target: 'target-1', turnId: 'turn-1', inputTokens: 9999, window: 10000 });
  adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' });
  await tick();
  assert.equal(adapter.compacts.length, 0);
});

// ── Real adapter code against the FAKE app-server process ──
test('FAKE app-server: Codex adapter compacts via thread/compact/start and the ledger records provider usage', async () => {
  const adapter = createCodexAppServer({ bin: FAKE }), seen = [];
  adapter.on((e) => seen.push(e.kind));
  const file = path.join(tmp(), 'stats.json');
  const ledger = createLedger({ file });
  const compaction = C.createSessionCompactor({ settings: () => ({ ...ON, threshold: 0.3, minTurns: 2 }), ledger });
  const hub = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: (b) => b === null, compaction });
  try {
    const A = (await hub.launch({ provider: 'codex' }, ACTOR)).state;
    const sendAndWait = async (text) => {
      const n = hub.state({ session: A.session }, ACTOR).deliveries.length;
      assert.equal((await hub.send({ session: A.session, generation: A.generation, text }, ACTOR)).status, 'acknowledged');
      await until(() => hub.state({ session: A.session }, ACTOR).deliveries.filter((d) => d.state === 'completed').length === n + 1);
    };
    await sendAndWait('one'); await sendAndWait('two'); await sendAndWait('three');
    await until(() => seen.includes('compacted') && hub.state({ session: A.session }, ACTOR).status === 'ready');
    await sendAndWait('four');
    await until(() => ledger.summary().total.compactions === 1);
    const s = ledger.summary();
    assert.equal(s.total.measured, 1);
    assert(s.total.savedTokens > 0, `saved ${s.total.savedTokens}`);
    assert.equal(s.last.source, 'provider');
    assert(!fs.readFileSync(file, 'utf8').includes('three'));
    assert.equal(hub.state({ session: A.session }, ACTOR).deliveries.length, 4);
  } finally { hub.stopAll(); }
});
