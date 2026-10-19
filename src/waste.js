'use strict';
// Cost guard: waste found in Claude Code transcripts, each finding with the
// transcript line and turn it came from. Read-only and local: the transcripts
// under ~/.claude/projects, nothing written, no network.
//
//   reread   the same slice of a file Read N+ times in one session with no
//            Write/Edit to it in between
//   failloop the same tool call (tool + normalised input) failing K+ times in
//            one session without succeeding in between
//   overkill Opus doing routine work (a short reply on little new context;
//            the same test as usage.js modelMix), priced against Sonnet
//
// A "turn" is the person's Nth prompt in that transcript; "line" is the
// 1-based line in the .jsonl file.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Usage = require('../usage.js');

const REREAD_MIN = 4;
const FAILLOOP_MIN = 3;
const OVERKILL_MIN = 10;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_EVIDENCE = 6;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const r2 = (n) => Math.round(n * 100) / 100;
const str = (v) => (typeof v === 'string' && v ? v : null);

// A person's prompt, not a tool result, a meta line or a harness wrapper.
function isPrompt(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain || !d.message) return false;
  const c = d.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
  const t = String(text || '').trim();
  return !!t && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted') && !(t.startsWith('<') && !/<command-name>/.test(t));
}

// Whitespace and object key order don't make two calls different.
function normalise(input) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v);
  try { return JSON.stringify(sort(input ?? {})).slice(0, 600); } catch { return ''; }
}

function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n, b) => n + (b && typeof b.text === 'string' ? b.text.length : 0), 0);
  return 0;
}

const isRoutine = (u) => u.output <= Usage.ROUTINE_OUTPUT && u.input + u.cacheWrite <= Usage.ROUTINE_NEW_INPUT;

/**
 * A per-file accumulator: feed it parsed lines in order, then findings().
 * file: the transcript path (only its basename is reported).
 */
function createSession(file) {
  const name = path.basename(file);
  let turn = 0;
  let sessionId = null, cwd = null;
  const uses = new Map(); // tool_use id → {tool, input, key, path, line, turn}
  const reads = new Map(); // read key → {path, run: [evidence], best: [evidence], extraChars}
  const fails = new Map(); // call key → {tool, run: [evidence], best: [evidence]}
  const opus = new Map(); // message id → {usage, line, turn}

  const ev = (line, t) => ({ file: name, line, turn: t });

  function onUse(b, line) {
    if (!b || b.type !== 'tool_use' || !str(b.name)) return;
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    const p = str(input.file_path) || str(input.notebook_path);
    const u = { tool: b.name, key: `${b.name}:${normalise(input)}`, path: p, line, turn };
    if (typeof b.id === 'string' && uses.size < 50000) uses.set(b.id, u);
    if (b.name === 'Read' && p) {
      const k = `${p}|${input.offset ?? ''}|${input.limit ?? ''}`;
      const r = reads.get(k) || { path: p, run: [], best: [], extraChars: 0 };
      r.run.push(ev(line, turn));
      if (r.run.length > r.best.length) r.best = r.run.slice();
      reads.set(k, r);
      u.readKey = k;
    } else if (WRITE_TOOLS.has(b.name) && p) {
      for (const [k, r] of reads) if (r.path === p) r.run = [];
    }
  }

  function onResult(b) {
    if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') return;
    const u = uses.get(b.tool_use_id);
    if (!u) return;
    if (u.readKey && !b.is_error) {
      const r = reads.get(u.readKey);
      // The first read of a run is the useful one; what the rest re-sent is the waste.
      if (r && r.run.length > 1) r.extraChars += resultChars(b.content);
    }
    const f = fails.get(u.key) || { tool: u.tool, run: [], best: [] };
    if (b.is_error) {
      f.run.push(ev(u.line, u.turn));
      if (f.run.length > f.best.length) f.best = f.run.slice();
    } else f.run = [];
    fails.set(u.key, f);
  }

  return {
    add(d, line) {
      if (!d || typeof d !== 'object') return;
      if (!sessionId && str(d.sessionId)) sessionId = d.sessionId;
      if (!cwd && str(d.cwd)) cwd = d.cwd;
      if (isPrompt(d)) { turn += 1; return; }
      const m = d.message && typeof d.message === 'object' ? d.message : null;
      if (!m) return;
      if (d.type === 'assistant') {
        if (Array.isArray(m.content)) for (const b of m.content) onUse(b, line);
        const key = Usage.modelKey(m.model);
        if (key === 'opus' && m.usage) {
          const u = m.usage;
          const cw = u.cache_creation_input_tokens || 0;
          const cc = u.cache_creation;
          // Streaming writes a line per block with the same id: the last one wins.
          opus.set(m.id || `${line}`, { usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: cw, cacheWrite1h: cc && typeof cc === 'object' ? Math.min(cw, cc.ephemeral_1h_input_tokens || 0) : 0, modelKey: 'opus' }, line, turn });
        }
      } else if (d.type === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) onResult(b);
      }
    },
    findings() {
      const out = [];
      const base = { file: name, sessionId, cwd, project: cwd ? path.basename(cwd) : null };
      for (const r of reads.values()) {
        if (r.best.length < REREAD_MIN) continue;
        out.push({ ...base, kind: 'reread', path: r.path, count: r.best.length, approxTokens: Math.round(r.extraChars / 4), evidence: r.best.slice(0, MAX_EVIDENCE) });
      }
      for (const f of fails.values()) {
        if (f.best.length < FAILLOOP_MIN) continue;
        out.push({ ...base, kind: 'failloop', tool: f.tool, count: f.best.length, evidence: f.best.slice(0, MAX_EVIDENCE) });
      }
      let routine = 0, low = 0, high = 0;
      const evid = [];
      for (const o of opus.values()) {
        if (!isRoutine(o.usage)) continue;
        const cost = Usage.costOf(o.usage, 'opus');
        const sonnet = Usage.costOf(o.usage, 'sonnet');
        routine += 1;
        low += Math.max(0, cost - sonnet * Usage.SLACK);
        high += Math.max(0, cost - sonnet);
        if (evid.length < MAX_EVIDENCE) evid.push(ev(o.line, o.turn));
      }
      if (routine >= OVERKILL_MIN) out.push({ ...base, kind: 'overkill', count: routine, of: opus.size, saving: { low: r2(low), high: r2(high) }, evidence: evid });
      return out;
    },
  };
}

async function scanFile(file, { maxBytes = MAX_FILE_BYTES } = {}) {
  const st = await fs.promises.stat(file);
  if (!st.isFile() || st.size > maxBytes) return [];
  const s = createSession(file);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const text of rl) {
    n += 1;
    if (text.length > MAX_LINE || !(text.includes('"type":"user"') || text.includes('"type":"assistant"'))) continue;
    let d;
    try { d = JSON.parse(text); } catch { continue; }
    s.add(d, n);
  }
  return s.findings();
}

const RANK = { failloop: 0, reread: 1, overkill: 2 };

/**
 * Scans transcripts written since `since`, newest first, at most maxFiles.
 * → {since, files, findings: [...], totals: {reread, failloop, overkill: {turns, low, high}}}
 */
async function scan({ root, since = 0, maxFiles = MAX_FILES, list = Usage.listJsonl } = {}) {
  const files = [];
  for (const f of await list(root)) {
    try { const st = await fs.promises.stat(f); if (st.mtimeMs >= since) files.push({ f, at: st.mtimeMs }); } catch { /* gone */ }
  }
  files.sort((a, b) => b.at - a.at);
  const findings = [];
  for (const { f } of files.slice(0, maxFiles)) {
    try { findings.push(...await scanFile(f)); } catch { /* unreadable: skipped */ }
  }
  findings.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.count - a.count);
  const totals = { reread: 0, failloop: 0, overkill: { turns: 0, low: 0, high: 0 } };
  for (const x of findings) {
    if (x.kind === 'overkill') { totals.overkill.turns += x.count; totals.overkill.low = r2(totals.overkill.low + x.saving.low); totals.overkill.high = r2(totals.overkill.high + x.saving.high); } else totals[x.kind] += 1;
  }
  return { since, files: Math.min(files.length, maxFiles), findings, totals };
}

module.exports = { scan, scanFile, createSession, normalise, isPrompt, REREAD_MIN, FAILLOOP_MIN, OVERKILL_MIN };
