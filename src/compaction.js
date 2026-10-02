'use strict';
// In-app compactor for sessions Plexiform itself owns. No proxy, no traffic
// interception, no reading of anyone else's transcripts: it only acts on
//  - owned provider sessions whose adapter offers a supported compaction
//    (`adapter.compact({target, keep})` + capability `compact: true`), and
//  - histories Plexiform holds itself (local models), via createHistoryCompactor.
//
// Pauseless shape: work starts only when a session is idle after a turn and
// the context is over the threshold, runs in the background, and is swapped
// in before the next send. A send never waits longer than SEND_WAIT_MS for it;
// after that the compaction is abandoned and the send goes ahead.
//
// Provider implementations of adapter.compact:
//  - Codex (src/codex-app-server.js): app-server `thread/compact/start`. Codex
//    runs the compaction as a turn on the thread, reports a `contextCompaction`
//    item, and reports usage with `thread/tokenUsage/updated`. Codex chooses
//    what it keeps (`keep` is advisory: capability compactKeep: false).
//  - Claude Code (owned headless session, lane P1, to wire): send the literal
//    `/compact` command as a user message on the owned stream-json session,
//    and/or start the owned child with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in ITS
//    env only. Before/after from the `usage` of the result messages.
//  - Gemini CLI (to verify): ACP exposes no compaction method today; leave
//    `compact` false until one is documented.
//  - Local models (lane P2, Plexiform-held history): createHistoryCompactor
//    below with the model's own summarise function.
const crypto = require('node:crypto');

const PROVIDERS = ['codex', 'claude', 'gemini', 'local'];
const DEFAULTS = Object.freeze({ enabled: false, providers: Object.freeze({ codex: false, claude: false, gemini: false, local: false }), threshold: 0.55, minTurns: 3, keepTurns: 4 });
const SEND_WAIT_MS = 15_000, SETTLE_MS = 5_000, COMPACT_MS = 120_000;
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : d);

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const p = s.providers && typeof s.providers === 'object' ? s.providers : {};
  return {
    enabled: s.enabled === true,
    providers: Object.fromEntries(PROVIDERS.map((k) => [k, p[k] === true])),
    // Preferences offers 30–90%; lower values are only for tests and proofs.
    threshold: num(s.threshold, 0.01, 0.95, DEFAULTS.threshold),
    minTurns: Math.round(num(s.minTurns, 1, 50, DEFAULTS.minTurns)),
    keepTurns: Math.round(num(s.keepTurns, 1, 20, DEFAULTS.keepTurns)),
  };
}
const enabledFor = (s, provider) => s.enabled === true && s.providers?.[provider] === true;

// Pure policy. fill is context tokens / window; unknown fill never compacts.
function shouldCompact({ settings, provider, contextTokens, window, turns, busy = false, compacting = false }) {
  const s = normalizeSettings(settings);
  if (!enabledFor(s, provider)) return { go: false, reason: 'off' };
  if (busy) return { go: false, reason: 'mid-turn' };
  if (compacting) return { go: false, reason: 'running' };
  if (!Number.isFinite(contextTokens) || !Number.isFinite(window) || window <= 0) return { go: false, reason: 'unknown-fill' };
  if (turns < s.minTurns) return { go: false, reason: 'few-turns' };
  const fill = contextTokens / window;
  if (fill < s.threshold) return { go: false, reason: 'under-threshold', fill };
  return { go: true, reason: 'over-threshold', fill };
}

// Rough, clearly an estimate: ~4 characters per token.
const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);
const historyTokens = (history) => history.reduce((n, m) => n + estimateTokens(m?.text), 0);

// Index where the last `keep` user turns begin (everything before is older).
function cutIndex(history, keep) {
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) if (history[i]?.role === 'user' && ++seen === keep) return i;
  return 0;
}
const fingerprint = (items) => crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); t.unref?.(); })]);

// Summarise-and-replace for histories Plexiform holds. `summarise(older)`
// returns the summary text. prepare() builds it in the background; swap()
// applies it at the next send only if the older part is unchanged, the
// provider is still on, and the summary is not too long. Anything else leaves
// the history exactly as it was.
function createHistoryCompactor({ provider = 'local', summarise, settings = () => DEFAULTS, ledger = null, window = () => null, maxSummaryRatio = 0.5, maxSummaryTokens = 4000, timeoutMs = COMPACT_MS, now = Date.now }) {
  const pending = new Map(); // key -> {state, cut, print, summary, before, gen}
  let gen = 0;
  async function prepare(key, history, { busy = false } = {}) {
    if (!Array.isArray(history)) return { ok: false, reason: 'invalid' };
    const s = normalizeSettings(settings());
    const turns = history.filter((m) => m?.role === 'user').length;
    const decision = shouldCompact({ settings: s, provider, contextTokens: historyTokens(history), window: window(), turns, busy, compacting: pending.get(key)?.state === 'building' });
    if (!decision.go) return { ok: false, reason: decision.reason };
    const cut = cutIndex(history, s.keepTurns);
    if (cut <= 0) return { ok: false, reason: 'nothing-older' };
    const older = history.slice(0, cut);
    const job = { state: 'building', cut, print: fingerprint(older), summary: null, before: historyTokens(older), gen: ++gen };
    pending.set(key, job);
    let summary;
    try { summary = await withTimeout(Promise.resolve().then(() => summarise(older.map((m) => ({ ...m })))), timeoutMs); } catch { summary = null; }
    if (pending.get(key) !== job) return { ok: false, reason: 'stale' };
    if (typeof summary !== 'string' || !summary.trim()) { pending.delete(key); return { ok: false, reason: 'summary-failed' }; }
    const after = estimateTokens(summary);
    if (after > maxSummaryTokens || after >= job.before * maxSummaryRatio) { pending.delete(key); return { ok: false, reason: 'summary-too-long' }; }
    Object.assign(job, { state: 'ready', summary: summary.trim(), after });
    return { ok: true, reason: 'ready' };
  }
  // Called just before a send. Returns the history to send.
  function swap(key, history) {
    const job = pending.get(key);
    if (!job) return { history, swapped: false, reason: 'none' };
    if (job.state !== 'ready') return { history, swapped: false, reason: 'building' };
    pending.delete(key);
    if (!enabledFor(normalizeSettings(settings()), provider)) return { history, swapped: false, reason: 'off' };
    if (!Array.isArray(history) || history.length < job.cut || fingerprint(history.slice(0, job.cut)) !== job.print) return { history, swapped: false, reason: 'stale' };
    const next = [{ role: 'system', text: `Summary of the earlier conversation:\n${job.summary}`, compacted: true }, ...history.slice(job.cut)];
    try { ledger?.record({ provider, before: job.before, after: estimateTokens(next[0].text), source: 'estimate', at: now() }); } catch { /* stats are best-effort */ }
    return { history: next, swapped: true, reason: 'swapped' };
  }
  const drop = (key) => { pending.delete(key); };
  const status = (key) => pending.get(key)?.state ?? 'idle';
  return { prepare, swap, drop, status };
}

// Coordinator for owned provider sessions (session-interaction hub). The hub
// passes its session records `r`; this keeps r.compaction:
//   running | aborting: {gen, target, turnId, before, compacted, done}
//   measuring:          {provider, before, at} until the next turn's usage
function createSessionCompactor({ settings = () => DEFAULTS, ledger = null, now = Date.now, sendWaitMs = SEND_WAIT_MS, settleMs = SETTLE_MS, maxMs = COMPACT_MS, onChange = () => {} } = {}) {
  const current = () => normalizeSettings(settings());
  const capable = (r) => r.adapter.capabilities?.compact === true && typeof r.adapter.compact === 'function';
  const inFlight = (c) => c?.state === 'running' || c?.state === 'aborting';
  const wait = (ms) => new Promise((res) => { const t = setTimeout(res, ms); t.unref?.(); });

  // The provider reports what really happened: a completed compaction turn
  // that produced a compaction item is recorded even if it was being aborted.
  function finish(r, ok) {
    const c = r.compaction;
    if (!inFlight(c)) return;
    const valid = ok && c.compacted && !r.ended && r.generation === c.gen && r.target === c.target;
    r.compaction = valid ? { state: 'measuring', provider: r.provider, before: c.before, at: now() } : null;
    if (valid) r.turnsSinceCompaction = 0;
    c.resolve();
    onChange(r);
  }
  function record(r, after) {
    const m = r.compaction;
    r.compaction = null;
    const measured = Number.isFinite(m.before) && Number.isFinite(after);
    try { ledger?.record({ provider: m.provider, before: measured ? m.before : null, after: measured ? after : null, source: 'provider', at: m.at }); } catch { /* best-effort */ }
  }

  // Hub hook for events already filtered to r.target. True = consumed here.
  function claims(r, e) {
    const c = r.compaction;
    if (e.kind === 'usage') {
      if (inFlight(c) && (!c.turnId || e.turnId === c.turnId)) return true; // the compaction turn's own usage
      if (Number.isFinite(e.inputTokens)) r.usage = { inputTokens: e.inputTokens, window: Number.isFinite(e.window) ? e.window : r.usage?.window ?? null };
      if (c?.state === 'measuring' && Number.isFinite(e.inputTokens)) record(r, e.inputTokens);
      return true;
    }
    if (inFlight(c)) {
      if (e.kind === 'turn-started' && !c.turnId) { c.turnId = e.turnId; return true; }
      if (typeof e.turnId === 'string' && e.turnId === c.turnId) {
        if (e.kind === 'compacted') c.compacted = true;
        else if (e.kind === 'turn-completed') finish(r, e.status === 'completed');
        return true; // nothing of the compaction turn reaches a delivery
      }
    }
    return e.kind === 'compacted';
  }

  // After a user turn completes: start in the background if the policy says so.
  function idle(r) {
    r.turnsSinceCompaction = (r.turnsSinceCompaction ?? 0) + 1;
    queueMicrotask(() => { maybeStart(r).catch(() => {}); });
  }
  async function maybeStart(r) {
    if (!capable(r) || r.ended || !r.adapter.alive?.()) return false;
    const d = shouldCompact({ settings: current(), provider: r.provider, contextTokens: r.usage?.inputTokens, window: r.usage?.window, turns: r.turnsSinceCompaction ?? 0, busy: r.sending || !!r.activeTurn, compacting: inFlight(r.compaction) });
    if (!d.go) return false;
    let resolve;
    const done = new Promise((res) => { resolve = res; });
    const c = { state: 'running', gen: r.generation, target: r.target, turnId: null, before: r.usage.inputTokens, compacted: false, done, resolve };
    r.compaction = c;
    onChange(r);
    // Bounded: a compaction that never ends is abandoned.
    wait(maxMs).then(() => { if (r.compaction === c) stop(r); });
    try { await r.adapter.compact({ target: c.target, keep: current().keepTurns }); } catch { if (r.compaction === c) finish(r, false); return false; }
    return true;
  }
  // Interrupt a compaction turn and give the provider settleMs to end it.
  async function stop(r) {
    const c = r.compaction;
    if (!inFlight(c)) return;
    if (c.state === 'running') {
      c.state = 'aborting';
      onChange(r);
      if (c.turnId && !r.ended) { try { await r.adapter.interrupt({ target: c.target, turnId: c.turnId }); } catch { /* provider gone */ } }
    }
    await Promise.race([c.done, wait(settleMs)]);
    if (r.compaction === c) { r.compaction = null; c.resolve(); onChange(r); }
  }
  // A send racing a compaction waits for it (bounded), then abandons it.
  async function settle(r) {
    const c = r.compaction;
    if (!inFlight(c)) return;
    await Promise.race([c.done, wait(sendWaitMs)]);
    if (r.compaction === c) await stop(r);
  }
  // Closed session: nothing more is recorded for it. Returns a turn to interrupt.
  function drop(r) {
    const c = r.compaction;
    r.compaction = null;
    if (inFlight(c)) { c.resolve(); return c.turnId; }
    return null;
  }
  // Toggle turned off (or provider disabled) mid-flight: stop it.
  async function settingsChanged(records) {
    const s = current();
    await Promise.all(records.filter((r) => r.compaction?.state === 'running' && !enabledFor(s, r.provider)).map(stop));
  }
  return { claims, idle, maybeStart, settle, stop, drop, settingsChanged, inFlight: (r) => inFlight(r.compaction) };
}

module.exports = { DEFAULTS, PROVIDERS, normalizeSettings, enabledFor, shouldCompact, estimateTokens, createHistoryCompactor, createSessionCompactor };
