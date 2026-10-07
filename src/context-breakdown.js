'use strict';

// Standalone "What's in context" for any Claude Code session, without Burst:
// a breakdown of the session transcript JSONL by kind, with a token estimate.
// Only sizes leave this module, never text.

const fs = require('node:fs');

const BYTES_PER_TOKEN = 4;
const IMAGE_TOKENS = 1600;
const GROUPS = Object.freeze({
  base: 'System prompt, tools and instruction files',
  reminders: 'Reminders and attachments',
  prompts: 'Your prompts',
  replies: "Claude's replies",
  calls: 'Tool calls',
  results: 'Tool results',
});
const ORDER = ['base', 'reminders', 'prompts', 'replies', 'calls', 'results'];

const bytes = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const REMINDER = /^\s*<(system-reminder|command-name|command-message|command-args|local-command-stdout|user-prompt-submit-hook)>/;

// A tool result's or prompt's content: a string or blocks of text and images.
function contentSize(c) {
  if (typeof c === 'string') return { b: bytes(c), img: 0 };
  let b = 0, img = 0;
  for (const x of Array.isArray(c) ? c : []) {
    if (!obj(x)) continue;
    if (x.type === 'image') img++;
    else if (typeof x.text === 'string') b += bytes(x.text);
    else b += bytes(JSON.stringify(x));
  }
  return { b, img };
}

// JSONL text -> { total: { bytes, tokens }, groups: [{ group, bytes, tokens }], reportedInputTokens, estimate }
// Counts from the last compaction boundary on: what came before it is no longer sent.
// With a reported input size, the transcript groups take their share of it and what the
// transcript does not hold (system prompt, tools, CLAUDE.md) is the remainder.
function breakdownText(text) {
  const acc = Object.fromEntries(ORDER.map((k) => [k, { b: 0, extra: 0 }]));
  let reported = 0;
  const add = (k, b, img = 0) => { acc[k].b += b; acc[k].extra += img * IMAGE_TOKENS; };
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!obj(ev) || ev.isSidechain === true) continue;
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      for (const k of ORDER) acc[k] = { b: 0, extra: 0 };
      reported = 0;
      continue;
    }
    if (ev.type === 'attachment') { add('reminders', bytes(JSON.stringify(ev.attachment ?? ''))); continue; }
    const m = obj(ev.message);
    if (!m) continue;
    if (ev.type === 'assistant') {
      const u = obj(m.usage);
      if (u) {
        const n = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens);
        if (n) reported = n;
      }
      for (const blk of Array.isArray(m.content) ? m.content : [m.content]) {
        if (typeof blk === 'string') add('replies', bytes(blk));
        else if (!obj(blk)) continue;
        else if (blk.type === 'tool_use') add('calls', bytes(blk.name) + bytes(JSON.stringify(blk.input ?? {})));
        else if (blk.type === 'thinking') add('replies', bytes(blk.thinking));
        else add('replies', bytes(blk.text));
      }
    } else if (ev.type === 'user') {
      const meta = ev.isMeta === true || ev.isCompactSummary === true;
      if (typeof m.content === 'string') { add(meta || REMINDER.test(m.content) ? 'reminders' : 'prompts', bytes(m.content)); continue; }
      for (const blk of Array.isArray(m.content) ? m.content : []) {
        if (!obj(blk)) continue;
        if (blk.type === 'tool_result') { const s = contentSize(blk.content); add('results', s.b, s.img); }
        else if (blk.type === 'image') add('prompts', 0, 1);
        else if (typeof blk.text === 'string') add(meta || REMINDER.test(blk.text) ? 'reminders' : 'prompts', bytes(blk.text));
      }
    }
  }
  const est = Object.fromEntries(ORDER.map((k) => [k, Math.ceil(acc[k].b / BYTES_PER_TOKEN) + acc[k].extra]));
  const sum = ORDER.reduce((s, k) => s + est[k], 0);
  const tokens = { ...est };
  if (reported && sum > reported) for (const k of ORDER) tokens[k] = Math.round((est[k] * reported) / sum);
  else if (reported) tokens.base = reported - sum;
  const groups = ORDER.filter((k) => tokens[k] > 0 || acc[k].b > 0).map((k) => ({ group: GROUPS[k], bytes: acc[k].b, tokens: tokens[k] }));
  return {
    total: { bytes: groups.reduce((s, g) => s + g.bytes, 0), tokens: groups.reduce((s, g) => s + g.tokens, 0) },
    groups,
    reportedInputTokens: reported,
    estimate: !reported,
  };
}

// transcript path -> Promise<breakdownText(...) | null>; reads at most maxBytes from the end.
async function breakdownFile(file, opts = {}) {
  const maxBytes = Number.isSafeInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 8 * 1024 * 1024;
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return breakdownText(text);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

module.exports = { breakdownText, breakdownFile, GROUPS };
