// The permanent daily usage record. Claude Code deletes transcripts after
// cleanupPeriodDays (30 by default), so anything read straight from them
// can never look back further than that; this keeps its own record instead.
//
//   ~/.claude-traffic-light/usage/daily/YYYY-MM.json
//     { v, priceVersion, days: { 'YYYY-MM-DD': {
//         legacy?: { cost },                       // imported from stats.json: cost only
//         sources: { claude: { '<exact model id>': { '<project cwd>': bucket } } } } } }
//   ~/.claude-traffic-light/usage/daily/YYYY-MM.ids.json
//     { turns: { '<turn hash>': [input, output, cacheRead, cacheWrite, cacheWrite1h, routine] },
//       sessions: { '<day>\t<source>\t<model>\t<project>': ['<session hash>', …] } }
//
// A bucket holds tokens, never dollars: cost is priced at read time from
// usage.js PRICES, so a price change or a pricing fix re-prices all history.
// Only numbers and project paths are stored, never prompt or reply text.
//
// Recording is idempotent and never shrinks a day: each turn's counted
// tokens are kept in the .ids sidecar, and a re-read adds only what grew
// (a turn first seen mid-stream, whose usage grows until its last line).
// A transcript that is deleted is simply not read again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Usage = require('./usage.js');
const { dayKey } = require('./stats.js');

const VERSION = 1;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
const DAY_MS = 86400000;
const PRICE_VERSION = crypto.createHash('sha1').update(JSON.stringify(Usage.PRICES)).digest('hex').slice(0, 10);

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const isRoutine = (t) => t.output <= Usage.ROUTINE_OUTPUT && t.input + t.cacheWrite <= Usage.ROUTINE_NEW_INPUT;
const blankBucket = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, routineTurns: 0, sessions: 0, firstTs: 0, lastTs: 0, hours: new Array(24).fill(0) });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A store is a lazily loaded view of the record; only the recorder (the
// history worker) writes, everyone else opens it read-only.
function open({ root } = {}) {
  const dir = path.join(root, 'usage', 'daily');
  return { dir, months: new Map(), dirty: new Set() };
}
function month(store, key, { ids = false } = {}) {
  let m = store.months.get(key);
  if (!m) {
    const rec = readJson(path.join(store.dir, `${key}.json`), null);
    m = { rec: rec && rec.v === VERSION && rec.days ? rec : { v: VERSION, priceVersion: PRICE_VERSION, days: {} }, ids: null };
    store.months.set(key, m);
  }
  if (ids && !m.ids) {
    const s = readJson(path.join(store.dir, `${key}.ids.json`), null);
    m.ids = s && s.turns && s.sessions ? s : { turns: {}, sessions: {} };
  }
  return m;
}
// every month on disk or recorded since (not yet flushed)
const months = (store) => {
  let disk = [];
  try { disk = fs.readdirSync(store.dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 7)); } catch { /* none yet */ }
  return [...new Set([...disk, ...store.months.keys()])].sort();
};

// Adds turns (usage.js readTurns shape) to the record. → { added, grown }.
function record(store, turns, { source = 'claude' } = {}) {
  let added = 0;
  let grown = 0;
  for (const t of turns) {
    if (!t || !t.id || !Number.isFinite(t.ts) || t.ts <= 0) continue;
    const day = dayKey(t.ts);
    const mk = day.slice(0, 7);
    const m = month(store, mk, { ids: true });
    const tid = hash(`${source}\t${t.id}`);
    const prev = own(m.ids.turns, tid) ? m.ids.turns[tid] : null;
    const now = FIELDS.map((f) => Math.max(0, Number(t[f]) || 0));
    const routine = isRoutine(t) ? 1 : 0;
    const delta = now.map((v, i) => Math.max(0, v - (prev ? prev[i] : 0)));
    if (prev && delta.every((d) => d === 0) && prev[5] === routine) continue;
    const model = t.model ? String(t.model) : 'unknown';
    const project = t.cwd || t.project || 'unknown';
    const d = own(m.rec.days, day) ? m.rec.days[day] : (m.rec.days[day] = {});
    const src = (d.sources || (d.sources = {}))[source] || (d.sources[source] = {});
    const byProject = own(src, model) ? src[model] : (src[model] = {});
    const b = own(byProject, project) ? byProject[project] : (byProject[project] = blankBucket());
    FIELDS.forEach((f, i) => { b[f] += delta[i]; });
    if (!prev) {
      b.turns += 1;
      b.hours[new Date(t.ts).getHours()] += 1;
      b.firstTs = b.firstTs ? Math.min(b.firstTs, t.ts) : t.ts;
      b.lastTs = Math.max(b.lastTs, t.ts);
      b.routineTurns += routine;
      if (t.sessionId) {
        const sk = `${day}\t${source}\t${model}\t${project}`;
        const list = own(m.ids.sessions, sk) ? m.ids.sessions[sk] : (m.ids.sessions[sk] = []);
        const sid = hash(t.sessionId);
        if (!list.includes(sid)) { list.push(sid); b.sessions = list.length; }
      }
      added += 1;
    } else {
      // a turn that kept growing can stop looking routine
      b.routineTurns = Math.max(0, b.routineTurns + routine - prev[5]);
      grown += 1;
    }
    m.ids.turns[tid] = [...now.map((v, i) => Math.max(v, prev ? prev[i] : 0)), routine];
    store.dirty.add(mk);
  }
  return { added, grown };
}

// Cost-only days from stats.json, for the time before the record existed.
// A day the record already has turns for keeps its own numbers.
function importLegacy(store, statsDays) {
  let imported = 0;
  for (const [day, s] of Object.entries(statsDays || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !s || !(Number(s.cost) > 0)) continue;
    const m = month(store, day.slice(0, 7));
    const d = own(m.rec.days, day) ? m.rec.days[day] : (m.rec.days[day] = {});
    if (d.sources) continue;
    const cost = Math.round(Number(s.cost) * 1e4) / 1e4;
    if (!d.legacy || d.legacy.cost < cost) { d.legacy = { cost }; store.dirty.add(day.slice(0, 7)); imported += 1; }
  }
  return imported;
}

function flush(store) {
  if (!store.dirty.size) return 0;
  fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  let n = 0;
  for (const mk of store.dirty) {
    const m = store.months.get(mk);
    if (!m) continue;
    m.rec.priceVersion = PRICE_VERSION;
    writeAtomic(path.join(store.dir, `${mk}.json`), m.rec);
    if (m.ids) writeAtomic(path.join(store.dir, `${mk}.ids.json`), m.ids);
    n += 1;
  }
  store.dirty.clear();
  return n;
}

// Reads transcripts written since `since` (everything, on the first run)
// straight into the record, a few files at a time with a yield between
// batches, so the thread it runs on keeps answering. It uses a throwaway
// parse cache: the caller's incremental cache holds only its own window.
async function catchUp(store, { root, since = 0, batch = 8, source = 'claude', onProgress = null, maxBytes = 200 * 1024 * 1024 } = {}) {
  const files = await Usage.listJsonl(root);
  let added = 0;
  let grown = 0;
  let read = 0;
  for (let i = 0; i < files.length; i += batch) {
    for (const file of files.slice(i, i + batch)) {
      let stat;
      try { stat = await fs.promises.stat(file); } catch { continue; }
      if (stat.mtimeMs < since || stat.size > maxBytes) continue;
      let entry;
      try { entry = await Usage.parseFile(file, stat, null); } catch { continue; }
      const r = record(store, [...entry.turns.values()].filter((t) => t.ts >= since), { source });
      added += r.added;
      grown += r.grown;
      read += 1;
    }
    if (onProgress) onProgress({ done: Math.min(files.length, i + batch), of: files.length });
    await new Promise((resolve) => setImmediate(resolve));
  }
  flush(store);
  return { files: files.length, read, added, grown };
}

// ── Reading ────────────────────────────────────────────────────────────────
const FAMILY = (id) => { const k = Usage.modelKey(id); return k === 'fable-5' ? 'fable' : k || 'unpriced'; };
const blankRow = (key) => ({ key, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0, unpricedTurns: 0, unpricedTokens: 0, routineTurns: 0, sessions: 0, legacyCost: 0 });
const GROUPS = ['day', 'model', 'family', 'project', 'source', 'hour', 'weekday-hour', 'none'];

// Every day in [from, to] (local days, ms or 'YYYY-MM-DD'), grouped.
// → { from, to, groupBy, rows: [...], total, legacyDays, unpricedModels, priceVersion }
function query(store, { from, to = Date.now(), groupBy = 'day', project = null, source = null } = {}) {
  if (!GROUPS.includes(groupBy)) throw new Error(`groupBy is one of ${GROUPS.join(', ')}`);
  const fromKey = typeof from === 'string' ? from : dayKey(from ?? 0);
  const toKey = typeof to === 'string' ? to : dayKey(to);
  const rows = new Map();
  const total = blankRow('total');
  const unpricedModels = new Set();
  let legacyDays = 0;
  const row = (k) => rows.get(k) || rows.set(k, blankRow(k)).get(k);
  for (const mk of months(store)) {
    if (mk < fromKey.slice(0, 7) || mk > toKey.slice(0, 7)) continue;
    const { rec } = month(store, mk);
    for (const [day, d] of Object.entries(rec.days)) {
      if (day < fromKey || day > toKey) continue;
      if (d.legacy && !d.sources && !project && (!source || source === 'claude')) {
        legacyDays += 1;
        for (const r of groupBy === 'day' ? [row(day), total] : groupBy === 'none' ? [total] : [total]) { r.cost += d.legacy.cost; r.legacyCost += d.legacy.cost; }
        continue;
      }
      const wd = new Date(`${day}T12:00:00`).getDay();
      for (const [src, models] of Object.entries(d.sources || {})) {
        if (source && src !== source) continue;
        for (const [model, projects] of Object.entries(models)) {
          const key = Usage.modelKey(model);
          for (const [proj, b] of Object.entries(projects)) {
            if (project && proj !== project) continue;
            const cost = key ? Usage.costOf(b, key) : null;
            if (cost == null) unpricedModels.add(model);
            const add = (r, share = 1) => {
              r.turns += b.turns * share;
              for (const f of FIELDS) r[f] += b[f] * share;
              r.routineTurns += b.routineTurns * share;
              r.sessions += b.sessions * share;
              if (cost == null) { r.unpricedTurns += b.turns * share; r.unpricedTokens += (b.input + b.output + b.cacheRead + b.cacheWrite) * share; } else r.cost += cost * share;
            };
            add(total);
            if (groupBy === 'hour' || groupBy === 'weekday-hour') {
              // tokens and cost follow each hour's share of the bucket's turns
              const n = b.hours.reduce((a, c) => a + c, 0) || 1;
              b.hours.forEach((c, h) => { if (c) add(row(groupBy === 'hour' ? String(h) : `${wd}:${h}`), c / n); });
            } else if (groupBy !== 'none') {
              add(row({ day, model, family: FAMILY(model), project: proj, source: src }[groupBy]));
            }
          }
        }
      }
    }
  }
  const round = (r) => { r.cost = Math.round(r.cost * 1e4) / 1e4; r.legacyCost = Math.round(r.legacyCost * 1e4) / 1e4; return r; };
  const list = [...rows.values()].map(round);
  list.sort(groupBy === 'day' || groupBy === 'hour' || groupBy === 'weekday-hour' ? (a, b) => (a.key < b.key ? -1 : 1) : (a, b) => b.cost - a.cost || b.turns - a.turns);
  return { from: fromKey, to: toKey, groupBy, rows: list, total: round(total), legacyDays, unpricedModels: [...unpricedModels].sort(), priceVersion: PRICE_VERSION };
}

// The earliest and latest recorded day, or null.
function extent(store) {
  const ms = months(store);
  if (!ms.length) return null;
  const days = (mk) => Object.keys(month(store, mk).rec.days).sort();
  const first = days(ms[0])[0];
  const last = days(ms[ms.length - 1]).pop();
  return first && last ? { from: first, to: last } : null;
}

module.exports = { VERSION, PRICE_VERSION, GROUPS, open, record, importLegacy, flush, catchUp, query, extent, DAY_MS };
