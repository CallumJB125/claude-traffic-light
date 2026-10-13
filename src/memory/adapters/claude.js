'use strict';

// Claude Code transcripts: ~/.claude/projects/<project>/<sessionId>.jsonl.
// Indexed: the person's prompts and the assistant's text replies, with the
// tool names and file paths the assistant's tool calls named. Tool results
// (file contents, command output) are never read into the index.

const fs = require('node:fs');
const path = require('node:path');
const { promptText } = require('../../handover-transcripts.js');
const { readAppended, parseJson, msOf } = require('./jsonl.js');

const MAX_FILES = 20000;
const listDir = (dir, opts) => { try { return fs.readdirSync(dir, opts); } catch { return []; } };
const fileOf = (input) => (input && typeof input === 'object' ? [input.file_path, input.path, input.notebook_path].find((v) => typeof v === 'string' && v) || null : null);

function sources({ home, since = 0 }) {
  const root = path.join(home, '.claude', 'projects'), out = [];
  for (const d of listDir(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of listDir(path.join(root, d.name))) {
      if (!f.endsWith('.jsonl') || out.length >= MAX_FILES) continue;
      const p = path.join(root, d.name, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isFile() && st.mtimeMs >= since) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function read(source, cursor, { since = 0 } = {}) {
  const c = cursor || { offset: 0, skipping: false, sid: path.basename(source.path, '.jsonl') };
  const r = readAppended(source.path, c.offset, c.skipping);
  if (r.reset) return { reset: true, sessions: [], cursor: null, more: true };
  const s = { sid: c.sid, cwd: null, repo: null, branch: null, title: null, started: null, ended: null, turns: [] };
  for (const line of r.lines) {
    const d = parseJson(line);
    if (!d || d.isSidechain) continue;
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') { s.title = d.aiTitle; c.titled = true; continue; }
    if (d.type === 'summary' && typeof d.summary === 'string' && !c.titled) { s.title = d.summary; c.titled = true; continue; }
    const ts = msOf(d.timestamp);
    if (typeof d.cwd === 'string' && d.cwd) { s.cwd = d.cwd; s.repo = path.basename(d.cwd); }
    if (typeof d.gitBranch === 'string' && d.gitBranch && d.gitBranch !== 'HEAD') s.branch = d.gitBranch;
    if (ts !== null) { if (s.started === null) s.started = ts; s.ended = ts; }
    const m = d.message && typeof d.message === 'object' ? d.message : null;
    if (!m || ts === null || ts < since) continue;
    if (d.type === 'user' && !d.isMeta) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (blocks.some((b) => b && b.type === 'tool_result')) continue;
      const text = promptText(typeof m.content === 'string' ? m.content : blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n'));
      if (!text) continue;
      if (!c.titled && !c.firstPrompt) { s.title = text; c.firstPrompt = true; }
      s.turns.push({ ts, role: 'user', text, files: [], tools: [] });
    } else if (d.type === 'assistant' && Array.isArray(m.content)) {
      const text = m.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
      const uses = m.content.filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string');
      if (!text && !uses.length) continue;
      s.turns.push({ ts, role: 'assistant', text, files: uses.map((u) => fileOf(u.input)).filter(Boolean), tools: uses.map((u) => u.name) });
    }
  }
  return { sessions: [s], cursor: { ...c, offset: r.offset, skipping: r.skipping }, more: !r.done };
}

module.exports = { id: 'claude', label: 'Claude Code', handover: 'claude-code', experimental: false, sources, read };
