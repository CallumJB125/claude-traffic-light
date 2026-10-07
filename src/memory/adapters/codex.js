'use strict';

// Codex transcripts: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
// and ~/.codex/archived_sessions. Indexed: the person's prompts and Codex's
// text replies, with tool names and the files a tool call or patch named.
// Tool output is never read into the index.

const fs = require('node:fs');
const path = require('node:path');
const { promptText } = require('../../handover-transcripts.js');
const { readAppended, parseJson, msOf } = require('./jsonl.js');

const MAX_FILES = 20000;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const textOf = (content, kinds) => (Array.isArray(content) ? content.filter((b) => b && kinds.includes(b.type) && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
const unfile = (p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : null);
const repoOf = (url) => (typeof url === 'string' && url ? path.basename(url.replace(/\/+$/, '')).replace(/\.git$/, '') || null : null);

function sources({ home, since = 0 }) {
  const out = [];
  const add = (dir) => {
    for (const f of listDir(dir)) {
      if (!ROLLOUT.test(f) || out.length >= MAX_FILES) continue;
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isFile() && st.mtimeMs >= since) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  const root = path.join(home, '.codex', 'sessions');
  const nums = (dir) => listDir(dir).filter((n) => /^\d+$/.test(n));
  // A day folder holds sessions started that day; one started before `since` may still be active, so a week of slack.
  const floor = since ? new Date(since - 7 * 86400000) : null;
  for (const y of nums(root)) for (const m of nums(path.join(root, y))) for (const d of nums(path.join(root, y, m))) {
    if (floor && new Date(Date.UTC(+y, +m - 1, +d + 1)) < floor) continue;
    add(path.join(root, y, m, d));
  }
  add(path.join(home, '.codex', 'archived_sessions'));
  return out;
}

function read(source, cursor, { since = 0 } = {}) {
  const c = cursor || { offset: 0, skipping: false, sid: (ROLLOUT.exec(path.basename(source.path)) || [])[1]?.toLowerCase() || path.basename(source.path, '.jsonl'), last: {} };
  const r = readAppended(source.path, c.offset, c.skipping);
  if (r.reset) return { reset: true, sessions: [], cursor: null, more: true };
  const s = { sid: c.sid, cwd: null, repo: null, branch: null, title: null, started: null, ended: null, turns: [] };
  const last = { ...c.last };
  let pending = null; // tool calls collect onto the next assistant reply, or stand alone
  const flushTools = (ts) => { if (pending && pending.tools.length) s.turns.push({ ts: pending.ts ?? ts, role: 'assistant', text: '', files: pending.files, tools: pending.tools }); pending = null; };
  const push = (role, text, ts) => {
    const t = String(text || '').trim();
    const sig = `${t.length}:${t.slice(0, 120)}`;
    if (!t || last[role] === sig) return; // response_item and event_msg repeat the same message
    last[role] = sig;
    if (role === 'user') { flushTools(ts); if (!c.titled) { s.title = t; c.titled = true; } s.turns.push({ ts, role, text: t, files: [], tools: [] }); return; }
    const p = pending; pending = null;
    s.turns.push({ ts, role, text: t, files: p ? p.files : [], tools: p ? p.tools : [] });
  };
  const tool = (name, files, ts) => { if (!pending) pending = { ts, files: [], tools: [] }; pending.tools.push(name); for (const f of files) if (f) pending.files.push(f); };
  for (const line of r.lines) {
    const d = parseJson(line);
    if (!d) continue;
    const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    const ts = msOf(d.timestamp);
    if ((d.type === 'session_meta' || d.type === 'turn_context') && typeof p.cwd === 'string' && p.cwd) { s.cwd = unfile(p.cwd); if (!c.repoUrl) s.repo = path.basename(s.cwd); }
    if (d.type === 'session_meta' && p.git && typeof p.git === 'object') {
      if (typeof p.git.branch === 'string' && p.git.branch) s.branch = p.git.branch;
      const repo = repoOf(p.git.repository_url);
      if (repo) { s.repo = repo; c.repoUrl = true; }
    }
    if (ts !== null) { if (s.started === null) s.started = ts; s.ended = ts; }
    if (ts === null || ts < since) continue;
    if (d.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') push('user', promptText(textOf(p.content, ['input_text', 'text'])), ts);
      else if (p.type === 'message' && p.role === 'assistant') push('assistant', textOf(p.content, ['output_text', 'text']), ts);
      else if (p.type === 'function_call' && typeof p.name === 'string') {
        let args = p.arguments;
        if (typeof args === 'string') args = parseJson(args);
        tool(p.name, [unfile(args && (args.path || args.file_path))], ts);
      } else if (p.type === 'local_shell_call') tool('shell', [], ts);
      else if (p.type === 'custom_tool_call' && typeof p.name === 'string') {
        const files = p.name === 'apply_patch' && typeof p.input === 'string' ? [...p.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim()) : [];
        tool(p.name, files, ts);
      }
    } else if (d.type === 'event_msg') {
      if (p.type === 'user_message') push('user', promptText(p.message), ts);
      else if (p.type === 'agent_message') push('assistant', p.message, ts);
    }
  }
  flushTools(s.ended);
  return { sessions: [s], cursor: { ...c, offset: r.offset, skipping: r.skipping, last }, more: !r.done };
}

module.exports = { id: 'codex', label: 'Codex', handover: 'codex', experimental: false, sources, read };
