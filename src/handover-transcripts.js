'use strict';

// The facts a local handover needs, read from the session's own transcript
// when its hook events are missing or older than its last activity (sessions
// from before Plexiform was connected, observed-only ones, hooks pointing at
// another copy). Read-only and bounded: only the first HEAD_BYTES and the last
// TAIL_BYTES (once WIDE_TAIL_BYTES) of one file, no network, no processes. The result has the shape
// of hooks/handover-tap.js facts (built with its own mutate step and caps), so
// src/session-handover.js renders and scrubs it the same way.
//   Claude Code: ~/.claude/projects/<project>/<sessionId>.jsonl
//   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<sessionId>.jsonl (and ~/.codex/archived_sessions)

const fs = require('node:fs');
const path = require('node:path');
const Tap = require('../hooks/handover-tap.js');

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;
// A tail with no request in it (a few huge lines: images, compaction) is read once more, this wide.
const WIDE_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LINE = 512 * 1024;
const INDEX_TTL_MS = 5 * 60 * 1000;
const MISS_RETRY_MS = 30 * 1000;
const MAX_FILES = 20000;
const CODEX_DAY_DIRS = 120;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const isoOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const parseJson = (s) => { if (typeof s !== 'string' || s.length > MAX_LINE) return null; try { return JSON.parse(s); } catch { return null; } };
const listDir = (dir, opts) => { try { return fs.readdirSync(dir, opts); } catch { return []; } };

// Which file holds a session's transcript. Directory listings are cached; a
// miss rebuilds at most every MISS_RETRY_MS so a brand-new session is found.
function createLocator({ home, now = Date.now }) {
  const cache = { claude: { at: -Infinity, map: new Map() }, codex: { at: -Infinity, map: new Map() } };
  function claudeIndex() {
    const root = path.join(home, '.claude', 'projects'), map = new Map();
    let n = 0;
    for (const d of listDir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of listDir(path.join(root, d.name))) {
        if (!f.endsWith('.jsonl')) continue;
        if (++n > MAX_FILES) return map;
        map.set(f.slice(0, -6), path.join(root, d.name, f));
      }
    }
    return map;
  }
  function codexIndex() {
    const map = new Map();
    const add = (dir) => { for (const f of listDir(dir)) { const m = ROLLOUT.exec(f); if (m && !map.has(m[1].toLowerCase()) && map.size < MAX_FILES) map.set(m[1].toLowerCase(), path.join(dir, f)); } };
    const root = path.join(home, '.codex', 'sessions'), desc = (dir) => listDir(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
    let days = 0;
    for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
      if (days++ >= CODEX_DAY_DIRS) break;
      add(path.join(root, y, m, d));
    }
    add(path.join(home, '.codex', 'archived_sessions'));
    return map;
  }
  const build = { claude: claudeIndex, codex: codexIndex };
  function lookup(kind, id) {
    const c = cache[kind];
    const age = now() - c.at;
    if (age >= INDEX_TTL_MS || (!c.map.has(id) && age >= MISS_RETRY_MS)) { cache[kind] = { at: now(), map: build[kind]() }; }
    return cache[kind].map.get(id) || null;
  }
  return {
    find(adapter, sessionId) {
      if (!home || typeof sessionId !== 'string' || !/^[\w.-]{1,200}$/.test(sessionId)) return null;
      if (adapter === 'claude-code') return lookup('claude', sessionId);
      if (adapter === 'codex') return lookup('codex', sessionId.toLowerCase());
      return null;
    },
  };
}

// The first HEAD_BYTES and the last TAIL_BYTES, as whole lines.
function readBounded(file, tailBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n).toString('utf8'); };
    if (st.size <= HEAD_BYTES + tailBytes) { const lines = read(0, st.size).split('\n'); return { lines, headCount: lines.length, partial: false, size: st.size, mtimeMs: st.mtimeMs }; }
    const head = read(0, HEAD_BYTES).split('\n'); head.pop();
    const tail = read(st.size - tailBytes, tailBytes).split('\n'); tail.shift();
    return { lines: head.concat(tail), headCount: head.length, partial: true, size: st.size, mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

// A person's request, not a wrapper the agent or its harness added.
function promptText(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const cmd = /<command-name>([^<]{1,200})<\/command-name>/.exec(t);
  if (cmd) { const args = /<command-args>([^<]{0,400})<\/command-args>/.exec(t); return `${cmd[1].trim()}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`; }
  if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return null;
  return t;
}

const blank = (adapter, sessionId) => ({ v: 1, adapter, sessionId, cwd: '', startedAt: null, lastActive: null, tools: {}, files: {}, commands: [] });

function claudeFacts(lines, f) {
  const toolNames = new Map();
  let lastText = null;
  for (const line of lines) {
    const d = parseJson(line);
    if (!d || typeof d !== 'object' || d.isSidechain) continue;
    const at = isoOf(d.timestamp) || f.lastActive || new Date(0).toISOString();
    if (str(d.cwd)) f.cwd = d.cwd.slice(0, 500);
    if (isoOf(d.timestamp) && !f.startedAt) f.startedAt = at;
    const m = d.message && typeof d.message === 'object' ? d.message : null;
    if (d.type === 'user' && m && !d.isMeta) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const failed = blocks.find((c) => c && c.type === 'tool_result' && c.is_error);
      if (failed) { Tap.mutate(f, 'tool-failed', { tool_name: toolNames.get(failed.tool_use_id) || null }, at); continue; }
      if (blocks.some((c) => c && c.type === 'tool_result')) { f.lastActive = at; continue; }
      const text = typeof m.content === 'string' ? m.content : blocks.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      if (/^\s*\[Request interrupted/.test(text)) { Tap.mutate(f, 'stop', {}, at); continue; }
      const p = promptText(text);
      if (p) Tap.mutate(f, 'prompt-submit', { prompt: p }, at); else f.lastActive = at;
    } else if (d.type === 'assistant' && m && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use' && str(c.name)) { if (typeof c.id === 'string' && toolNames.size < 5000) toolNames.set(c.id, c.name); Tap.mutate(f, 'tool-use', { tool_name: c.name, tool_input: c.input && typeof c.input === 'object' ? c.input : {} }, at); }
        else if (c.type === 'text' && str(c.text)) { lastText = c.text; f.lastActive = at; }
      }
      if (m.stop_reason === 'end_turn') Tap.mutate(f, 'stop', { last_assistant_message: lastText }, at);
    } else if (d.type === 'system' && (d.subtype === 'stop_hook_summary' || d.subtype === 'turn_duration')) {
      Tap.mutate(f, 'stop', { last_assistant_message: lastText }, at);
    }
  }
  return f;
}

const textOf = (content, kinds) => (Array.isArray(content) ? content.filter((c) => c && kinds.includes(c.type) && typeof c.text === 'string').map((c) => c.text).join('\n') : '');
// ["/bin/zsh", "-lc", "npm test"] → "npm test"
function commandOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || !c.every((x) => typeof x === 'string')) return null;
  return c.length === 3 && /(?:^|\/)(?:ba|z|da)?sh$/.test(c[0]) && /^-l?c$/.test(c[1]) ? c[2] : c.join(' ');
}
const unfile = (p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : p);

function codexFacts(lines, f) {
  let lastText = null;
  const command = (cmd, at) => { const c = commandOf(cmd); if (str(c) && f.commands[f.commands.length - 1] !== Tap.clip(c, Tap.CAP.command)) f.commands = f.commands.concat([Tap.clip(c, Tap.CAP.command)]).slice(-Tap.CAP.commands); f.lastActive = at; };
  for (const line of lines) {
    const d = parseJson(line);
    if (!d || typeof d !== 'object') continue;
    const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    const at = isoOf(d.timestamp) || f.lastActive || new Date(0).toISOString();
    if (isoOf(d.timestamp) && !f.startedAt) f.startedAt = at;
    if ((d.type === 'session_meta' || d.type === 'turn_context') && str(p.cwd)) f.cwd = unfile(p.cwd).slice(0, 500);
    if (d.type === 'session_meta' && isoOf(p.timestamp)) f.startedAt = isoOf(p.timestamp);
    if (d.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') { const t = promptText(textOf(p.content, ['input_text', 'text'])); if (t) Tap.mutate(f, 'prompt-submit', { prompt: t }, at); }
      else if (p.type === 'message' && p.role === 'assistant') { const t = textOf(p.content, ['output_text', 'text']); if (str(t)) { lastText = t; f.lastActive = at; } }
      else if (p.type === 'function_call' && str(p.name)) {
        const args = (typeof p.arguments === 'string' ? parseJson(p.arguments) : p.arguments) || {};
        Tap.mutate(f, 'tool-use', { tool_name: p.name, tool_input: { file_path: str(args.path) || str(args.file_path) } }, at);
        if (args.command || args.cmd) command(args.command || args.cmd, at);
      } else if (p.type === 'local_shell_call') { Tap.mutate(f, 'tool-use', { tool_name: 'shell', tool_input: {} }, at); command(p.action && p.action.command, at); }
      else if (p.type === 'custom_tool_call' && str(p.name)) {
        const edited = p.name === 'apply_patch' && typeof p.input === 'string' ? [...p.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim()) : [];
        Tap.mutate(f, 'tool-use', { tool_name: p.name, tool_input: { file_path: edited[0] || null } }, at);
        for (const file of edited.slice(1)) Tap.mutate(f, 'tool-use', { tool_name: p.name, tool_input: { file_path: file } }, at);
      }
    } else if (d.type === 'event_msg') {
      if (p.type === 'user_message') { const t = promptText(p.message); if (t && t !== f.lastPrompt) Tap.mutate(f, 'prompt-submit', { prompt: t }, at); }
      else if (p.type === 'agent_message' && str(p.message)) { lastText = p.message; f.lastActive = at; }
      else if (p.type === 'task_complete') Tap.mutate(f, 'stop', { last_assistant_message: str(p.last_agent_message) || lastText }, at);
      else if (p.type === 'turn_aborted') Tap.mutate(f, 'stop', {}, at);
      else if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
        const it = p.item;
        if (it.type === 'CommandExecution') command(it.command, at);
        else if (it.type === 'FileChange' && it.changes && typeof it.changes === 'object') {
          for (const file of Object.keys(it.changes).slice(0, Tap.CAP.files)) Tap.mutate(f, 'tool-use', { tool_name: 'apply_patch', tool_input: { file_path: unfile(file) } }, at);
        } else if (it.type === 'ImageView' && str(it.path)) Tap.mutate(f, 'tool-use', { tool_name: 'view_image', tool_input: { file_path: unfile(it.path) } }, at);
        else if (it.type === 'McpToolCall' && str(it.tool)) Tap.mutate(f, 'tool-use', { tool_name: `${str(it.server) || 'mcp'}.${it.tool}`, tool_input: {} }, at);
      }
    }
  }
  return f;
}

// → facts (hooks/handover-tap.js shape, plus source/transcript metadata), or null.
function factsFrom(file, { adapter, sessionId }) {
  if (adapter !== 'claude-code' && adapter !== 'codex') return null;
  const step = adapter === 'codex' ? codexFacts : claudeFacts;
  const parse = (tailBytes) => {
    const r = readBounded(file, tailBytes), f = blank(adapter, sessionId);
    step(r.lines.slice(0, r.headCount), f);
    const before = f.lastPromptAt;
    step(r.lines.slice(r.headCount), f);
    return { r, f, tailPrompt: !r.partial || f.lastPromptAt !== before };
  };
  let r, f;
  try { const a = parse(TAIL_BYTES); ({ r, f } = a.tailPrompt ? a : parse(WIDE_TAIL_BYTES)); } catch { return null; }
  if (!f.lastActive) f.lastActive = new Date(r.mtimeMs).toISOString();
  return { ...f, source: 'transcript', transcript: { file, size: r.size, partial: r.partial, mtimeMs: r.mtimeMs } };
}

module.exports = { createLocator, factsFrom, readBounded, promptText, commandOf, HEAD_BYTES, TAIL_BYTES, WIDE_TAIL_BYTES };
