// Per-turn token usage read straight from Claude Code's transcripts
// (~/.claude/projects/<project>/<session>.jsonl, plus
// <project>/<session>/subagents/agent-*.jsonl for subagents), priced per
// model, with counterfactual "what if every turn had run on X" costs.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dayKey } = require('./stats.js');

// USD per million tokens.
const PRICES = {
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Legacy ids priced unlike the rest of their family, per LiteLLM's
  // model_prices_and_context_window.json (the table ccusage uses).
  'fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
};
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
// Exact ids only (after dropping a -YYYYMMDD suffix): claude-fable-5-1 is
// plain Fable, not Fable 5.
const EXACT = { 'claude-fable-5': 'fable-5' };
// A cheaper model may tokenise the same work into more tokens and need extra
// turns to finish it; the pessimistic end of every counterfactual assumes it
// costs 35% more than the same token counts would.
const SLACK = 1.35;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const DAY_MS = 86400000;

function modelKey(model) {
  const m = String(model || '').toLowerCase();
  return EXACT[m.replace(/-\d{8}$/, '')] || FAMILIES.find((k) => m.includes(k)) || null;
}

function costOf(turn, key = turn.modelKey) {
  const p = PRICES[key];
  if (!p) return null;
  const write1h = turn.cacheWrite1h || 0;
  return (turn.input * p.input + turn.output * p.output + turn.cacheRead * p.cacheRead
    + (turn.cacheWrite - write1h) * p.cacheWrite + write1h * p.input * 2) / 1e6;
}

function turnFrom(j, file, subagent) {
  const u = j.message.usage;
  const cc = u.cache_creation;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cwd = j.cwd || null;
  return {
    id: j.message.id && j.requestId ? `${j.message.id}:${j.requestId}` : j.uuid || null,
    ts: Date.parse(j.timestamp) || 0,
    sessionId: j.sessionId || null,
    cwd,
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : path.basename(path.dirname(subagent ? path.dirname(path.dirname(file)) : file)),
    model: j.message.model || null,
    modelKey: modelKey(j.message.model),
    subagent,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite,
    cacheWrite1h: cc && typeof cc === 'object' ? Math.min(cacheWrite, cc.ephemeral_1h_input_tokens || 0) : 0,
  };
}

// Transcripts are append-only, so a file that only grew is read from where
// the last pass stopped; one that shrank or was replaced is read from zero.
async function parseFile(file, stat, prev) {
  const subagent = file.split(path.sep).includes('subagents');
  const resume = prev && stat.size >= prev.offset && prev.ino === stat.ino;
  const turns = resume ? prev.turns : new Map();
  let offset = resume ? prev.offset : 0;
  if (stat.size > offset) {
    const stream = fs.createReadStream(file, { start: offset, encoding: 'utf8' });
    let rest = '';
    const take = (line) => {
      // Only assistant lines carry usage; skip parsing everything else.
      if (!line.includes('"usage"')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.type !== 'assistant' || !j.message || !j.message.usage) return;
      const t = turnFrom(j, file, subagent || !!j.isSidechain);
      if (!t.input && !t.output && !t.cacheRead && !t.cacheWrite) return;
      // Streaming writes one line per content block with the same message
      // and request id, usage growing as it goes: the last one wins.
      turns.set(t.id || `${file}:${turns.size}`, t);
    };
    for await (const chunk of stream) {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        offset += Buffer.byteLength(line, 'utf8') + 1;
        take(line);
      }
    }
    // A trailing line with no newline may still be mid-write; leave it (and
    // the offset before it) for the next pass.
  }
  return { key: `${stat.mtimeMs}:${stat.size}`, ino: stat.ino, offset, turns };
}

async function listJsonl(root) {
  const out = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  await walk(root, 0);
  return out;
}

// → { turns, files, parsed, skipped }. `cache` is a Map the caller keeps
// between calls; unchanged files cost one stat.
async function readTurns({ root = path.join(os.homedir(), '.claude', 'projects'), since = 0, cache = new Map(), maxBytes = MAX_FILE_BYTES } = {}) {
  const files = await listJsonl(root);
  let parsed = 0;
  const skipped = [];
  const byId = new Map();
  for (const file of files) {
    let stat;
    try { stat = await fs.promises.stat(file); } catch { continue; }
    // A file last written before `since` cannot hold a turn after it.
    if (stat.mtimeMs < since) continue;
    if (stat.size > maxBytes) { skipped.push(file); continue; }
    let entry = cache.get(file);
    if (!entry || entry.key !== `${stat.mtimeMs}:${stat.size}`) {
      try { entry = await parseFile(file, stat, entry); } catch { continue; }
      cache.set(file, entry);
      parsed += 1;
    }
    // Resumed and forked sessions copy earlier messages into a new file;
    // dedupe across files too, as ccusage does.
    for (const [id, t] of entry.turns) if (t.ts >= since) byId.set(id, t);
  }
  const turns = [...byId.values()].sort((a, b) => a.ts - b.ts);
  return { turns, files: files.length, parsed, skipped };
}

const blank = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ifAll: { sonnet: 0, haiku: 0 }, savings: { sonnet: { low: 0, high: 0 }, haiku: { low: 0, high: 0 } } });

function add(b, t, cost, cf) {
  b.turns += 1;
  b.input += t.input;
  b.output += t.output;
  b.cacheRead += t.cacheRead;
  b.cacheWrite += t.cacheWrite;
  b.cost += cost;
  for (const k of ['sonnet', 'haiku']) {
    b.ifAll[k] += cf[k];
    // Routing only ever moves a turn down to a cheaper model, so a turn that
    // already ran on it (or on something cheaper) saves nothing.
    b.savings[k].low += Math.max(0, cost - cf[k] * SLACK);
    b.savings[k].high += Math.max(0, cost - cf[k]);
  }
}

const round = (b) => {
  const r2 = (n) => Math.round(n * 1e4) / 1e4;
  b.cost = r2(b.cost);
  for (const k of ['sonnet', 'haiku']) { b.ifAll[k] = r2(b.ifAll[k]); b.savings[k].low = r2(b.savings[k].low); b.savings[k].high = r2(b.savings[k].high); }
  return b;
};

// Totals, per day, per project and per model over the last `days` local
// days, plus `baseline`: the model mix over the last `baselineDays`.
function summarise(turns, { days = 7, baselineDays = 14, now = Date.now() } = {}) {
  const startOf = (n) => { const d = new Date(now - (n - 1) * DAY_MS); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const from = startOf(days);
  const total = blank();
  const byDay = {};
  const byProject = {};
  const byModel = {};
  const unknown = { turns: 0, models: [] };
  for (let i = days - 1; i >= 0; i -= 1) byDay[dayKey(now - i * DAY_MS)] = blank();
  for (const t of turns) {
    if (t.ts < from || t.ts > now) continue;
    const cost = costOf(t);
    if (cost == null) {
      unknown.turns += 1;
      if (t.model && !unknown.models.includes(t.model)) unknown.models.push(t.model);
      continue;
    }
    const cf = { sonnet: costOf(t, 'sonnet'), haiku: costOf(t, 'haiku') };
    add(total, t, cost, cf);
    add(byDay[dayKey(t.ts)] || (byDay[dayKey(t.ts)] = blank()), t, cost, cf);
    add(byProject[t.project] || (byProject[t.project] = blank()), t, cost, cf);
    add(byModel[t.modelKey] || (byModel[t.modelKey] = blank()), t, cost, cf);
  }
  const ranked = (o) => Object.entries(o).map(([name, b]) => ({ name, ...round(b) })).sort((a, b) => b.cost - a.cost);
  return {
    days,
    from,
    to: now,
    total: round(total),
    byDay: Object.entries(byDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, b]) => ({ key, ...round(b) })),
    byProject: ranked(byProject),
    byModel: ranked(byModel),
    unknown,
    baseline: baselineOf(turns, baselineDays, startOf, now),
  };
}

function baselineOf(turns, baselineDays, startOf, now) {
  const from = startOf(baselineDays);
  const mix = {};
  let cost = 0;
  let count = 0;
  for (const t of turns) {
    if (t.ts < from || t.ts > now) continue;
    const c = costOf(t);
    if (c == null) continue;
    const m = mix[t.modelKey] || (mix[t.modelKey] = { turns: 0, cost: 0, tokens: 0 });
    m.turns += 1;
    m.cost += c;
    m.tokens += t.input + t.output + t.cacheRead + t.cacheWrite;
    cost += c;
    count += 1;
  }
  for (const m of Object.values(mix)) { m.share = count ? m.turns / count : 0; m.costShare = cost ? m.cost / cost : 0; }
  return { days: baselineDays, from, to: now, turns: count, cost: Math.round(cost * 1e4) / 1e4, mix };
}

const tokensOf = (b) => b.input + b.output + b.cacheRead + b.cacheWrite;

// The Stats page's Spend block (the shape ccusage used to fill): the last
// `days` days per day, project and session, plus `history`, each day's cost
// over `historyDays` for stats.json. Days with no transcripts are left out:
// Claude Code deletes old transcripts, and an empty day there must not
// overwrite the cost stats.json already recorded for it.
function spend(turns, { days = 7, historyDays = 60, now = Date.now() } = {}) {
  const week = summarise(turns, { days, now });
  const hist = summarise(turns, { days: historyDays, now });
  const byDay = {};
  for (const d of week.byDay) byDay[d.key] = { cost: d.cost, tokens: tokensOf(d), models: [] };
  const sessions = {};
  for (const t of turns) {
    if (t.ts < week.from || t.ts > now) continue;
    const cost = costOf(t);
    if (cost == null) continue;
    const d = byDay[dayKey(t.ts)];
    const model = String(t.model).replace(/^claude-/, '');
    if (d && !d.models.includes(model)) d.models.push(model);
    const id = t.sessionId || 'unknown';
    const s = sessions[id] || (sessions[id] = { id, project: t.project, cost: 0, tokens: 0 });
    s.cost += cost;
    s.tokens += tokensOf(t);
  }
  return {
    available: true,
    source: 'transcripts',
    days: byDay,
    history: Object.fromEntries(hist.byDay.filter((d) => d.turns).map((d) => [d.key, d.cost])),
    totals: { totalCost: week.total.cost },
    projects: week.byProject.map((p) => ({ name: p.name, cost: p.cost, tokens: tokensOf(p) })),
    sessions: Object.values(sessions).sort((a, b) => b.cost - a.cost).slice(0, 8),
  };
}

// ── Router history ─────────────────────────────────────────────────────────
// Cheapest first. A session whose main thread moves up this ladder is you
// typing /model to a pricier model: the sign the cheap pick was wrong.
const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4, 'fable-5': 4 };
const family = (k) => (k === 'fable-5' ? 'fable' : k);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Per project over the last `days`: sessions, median main-thread turns per
// session, subagent share of all turns and escalations; plus every escalated
// session by id. This is what the router shim reads (as history.json).
function projectHistory(turns, { days = 7, now = Date.now() } = {}) {
  const from = now - days * DAY_MS;
  const projects = {};
  const sessions = new Map();
  for (const t of turns) {
    if (t.ts < from || t.ts > now) continue;
    const p = projects[t.project] || (projects[t.project] = { sessions: 0, medianTurns: 0, turns: 0, subagentTurns: 0, subagentShare: 0, escalations: 0, lastEscalationAt: null });
    p.turns += 1;
    if (t.subagent) { p.subagentTurns += 1; continue; }
    if (!t.sessionId) continue;
    if (!sessions.has(t.sessionId)) sessions.set(t.sessionId, { project: t.project, turns: [] });
    sessions.get(t.sessionId).turns.push(t);
  }
  const counts = {};
  const escalated = {};
  for (const [id, s] of sessions) {
    (counts[s.project] || (counts[s.project] = [])).push(s.turns.length);
    s.turns.sort((a, b) => a.ts - b.ts);
    let prev = null;
    for (const t of s.turns) {
      if (!RANK[t.modelKey]) continue;
      if (prev && RANK[t.modelKey] > RANK[prev]) { escalated[id] = { project: s.project, at: t.ts, from: family(prev), to: family(t.modelKey) }; break; }
      prev = t.modelKey;
    }
  }
  for (const [name, p] of Object.entries(projects)) {
    p.sessions = (counts[name] || []).length;
    p.medianTurns = median(counts[name] || []);
    p.subagentShare = p.turns ? Math.round((p.subagentTurns / p.turns) * 1000) / 1000 : 0;
  }
  for (const e of Object.values(escalated)) {
    const p = projects[e.project];
    p.escalations += 1;
    p.lastEscalationAt = Math.max(p.lastEscalationAt || 0, e.at);
  }
  return { at: now, days, projects, escalated };
}

// Each project's model mix (share of its turns per model) over the last
// `days` — frozen when routing is switched on, so later spend can be priced
// at the mix you had before.
function projectMix(turns, { days = 14, now = Date.now() } = {}) {
  const from = now - days * DAY_MS;
  const out = {};
  for (const t of turns) {
    if (t.ts < from || t.ts > now || !PRICES[t.modelKey]) continue;
    const p = out[t.project] || (out[t.project] = { turns: 0, mix: {} });
    p.turns += 1;
    p.mix[t.modelKey] = (p.mix[t.modelKey] || 0) + 1;
  }
  for (const p of Object.values(out)) for (const k of Object.keys(p.mix)) p.mix[k] = { turns: p.mix[k], share: p.mix[k] / p.turns };
  return out;
}

function weightsOf(mix) {
  if (!mix || typeof mix !== 'object') return null;
  const w = Object.entries(mix).filter(([k, m]) => PRICES[k] && m && m.share > 0);
  const sum = w.reduce((a, [, m]) => a + m.share, 0);
  return sum ? w.map(([k, m]) => [k, m.share / sum]) : null;
}

// Spend since routing went on, against the same turns priced at the frozen
// baseline mix (the project's own mix, else the overall one). A saving has
// the Router's usual range: the baseline models might have needed up to
// SLACK fewer tokens. A turn that cost more than its baseline counts in full.
function sinceRouting(turns, { since, frozen, now = Date.now() } = {}) {
  const global = weightsOf(frozen && frozen.mix);
  let actual = 0, atBaseline = 0, low = 0, high = 0, count = 0;
  for (const t of turns) {
    if (t.ts < since || t.ts > now) continue;
    const cost = costOf(t);
    if (cost == null) continue;
    const w = weightsOf(frozen && frozen.projects && frozen.projects[t.project] && frozen.projects[t.project].mix) || global;
    const base = w ? w.reduce((a, [k, share]) => a + share * costOf(t, k), 0) : cost;
    actual += cost;
    atBaseline += base;
    count += 1;
    if (base > cost) { high += base - cost; low += Math.max(0, base / SLACK - cost); } else { high += base - cost; low += base - cost; }
  }
  const r = (n) => Math.round(n * 1e4) / 1e4;
  return { since, to: now, turns: count, actual: r(actual), atBaseline: r(atBaseline), saved: { low: r(low), high: r(high) } };
}

module.exports = { PRICES, SLACK, modelKey, costOf, readTurns, summarise, spend, projectHistory, projectMix, sinceRouting };
