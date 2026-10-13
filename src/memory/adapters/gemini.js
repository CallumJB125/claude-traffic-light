'use strict';

// Experimental. Gemini CLI saves each chat as one JSON file:
// ~/.gemini/tmp/<project hash>/chats/session-*.json ({sessionId, startTime,
// lastUpdated, messages: [{type: 'user'|'gemini', content, timestamp, toolCalls}]}).
// The format is undocumented; anything unexpected is skipped. The project
// folder is stored only as a hash, so these sessions have no folder or repo.

const fs = require('node:fs');
const path = require('node:path');
const { msOf } = require('./jsonl.js');

const MAX_BYTES = 32 * 1024 * 1024;
const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : '');

function sources({ home, since = 0 }) {
  const root = path.join(home, '.gemini', 'tmp'), out = [];
  for (const proj of listDir(root)) {
    const dir = path.join(root, proj, 'chats');
    for (const f of listDir(dir)) {
      if (!/^session-.*\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isFile() && st.size <= MAX_BYTES && st.mtimeMs >= since) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function read(source, _cursor, { since = 0 } = {}) {
  let d;
  try { d = JSON.parse(fs.readFileSync(source.path, 'utf8')); } catch { return { sessions: [], cursor: {}, more: false }; }
  if (!d || typeof d !== 'object' || !Array.isArray(d.messages)) return { sessions: [], cursor: {}, more: false };
  const s = { sid: String(d.sessionId || path.basename(source.path, '.json')), cwd: null, repo: null, branch: null, title: null, started: msOf(d.startTime), ended: msOf(d.lastUpdated), replace: true, turns: [] };
  for (const m of d.messages) {
    if (!m || typeof m !== 'object') continue;
    const ts = msOf(m.timestamp) ?? s.ended;
    if (ts === null || ts < since) continue;
    const role = m.type === 'user' ? 'user' : m.type === 'gemini' ? 'assistant' : null;
    if (!role) continue;
    const text = textOf(m.content).trim();
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls.filter((t) => t && typeof t.name === 'string') : [];
    if (!text && !calls.length) continue;
    if (role === 'user' && !s.title) s.title = text;
    const files = calls.map((t) => t.args && (t.args.file_path || t.args.path || t.args.absolute_path)).filter((f) => typeof f === 'string');
    s.turns.push({ ts, role, text, files, tools: calls.map((t) => t.name) });
  }
  return { sessions: [s], cursor: {}, more: false };
}

module.exports = { id: 'gemini', label: 'Gemini CLI', handover: 'gemini', experimental: true, sources, read };
