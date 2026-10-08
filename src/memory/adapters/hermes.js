'use strict';

// Hermes keeps its sessions in ~/.hermes/state.db (SQLite). Opened read-only;
// indexed: user prompts and assistant replies with the tool names and file
// paths of their tool calls. Rows with role 'tool' (tool output) are never read.

const fs = require('node:fs');
const path = require('node:path');

const BATCH = 2000;
const dbPath = (home) => path.join(home, '.hermes', 'state.db');
const fileOf = (args) => (args && typeof args === 'object' ? [args.path, args.file_path].find((v) => typeof v === 'string' && v) || null : null);
const json = (s) => { if (typeof s !== 'string' || !s || s.length > 1024 * 1024) return null; try { return JSON.parse(s); } catch { return null; } };

function sources({ home }) {
  const p = dbPath(home);
  try { const st = fs.statSync(p); return st.isFile() ? [{ path: p, mtimeMs: st.mtimeMs, size: st.size, always: true }] : []; } catch { return []; }
}

function read(source, cursor, { since = 0 } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const c = cursor || { lastId: 0 };
  const db = new DatabaseSync(source.path, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, session_id, role, content, tool_calls, timestamp FROM messages
      WHERE id > ? AND role IN ('user', 'assistant') ORDER BY id LIMIT ${BATCH}`).all(c.lastId);
    const bySession = new Map();
    const meta = db.prepare('SELECT id, cwd, git_branch, git_repo_root, title, started_at, ended_at, last_activity_at, estimated_cost_usd FROM sessions WHERE id = ?');
    for (const m of rows) {
      const ts = Math.round(Number(m.timestamp) * 1000);
      if (!Number.isFinite(ts) || ts < since) continue;
      let s = bySession.get(m.session_id);
      if (!s) {
        const x = meta.get(m.session_id) || {};
        const root = x.git_repo_root || x.cwd || null;
        s = { sid: String(m.session_id), cwd: x.cwd || null, repo: root ? path.basename(root) : null, branch: x.git_branch || null, title: x.title || null,
          started: Number.isFinite(x.started_at) ? Math.round(x.started_at * 1000) : null,
          ended: Number.isFinite(x.last_activity_at ?? x.ended_at) ? Math.round((x.last_activity_at ?? x.ended_at) * 1000) : null,
          cost: Number.isFinite(x.estimated_cost_usd) ? x.estimated_cost_usd : null, turns: [] };
        bySession.set(m.session_id, s);
      }
      const calls = Array.isArray(json(m.tool_calls)) ? json(m.tool_calls) : [];
      const tools = [], files = [];
      for (const call of calls) {
        const fn = call && call.function;
        if (fn && typeof fn.name === 'string') { tools.push(fn.name); const f = fileOf(typeof fn.arguments === 'string' ? json(fn.arguments) : fn.arguments); if (f) files.push(f); }
      }
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (!text && !tools.length) continue;
      if (m.role === 'user' && !s.title) s.title = text;
      s.turns.push({ ts, role: m.role, text, files, tools });
    }
    const lastId = rows.length ? rows[rows.length - 1].id : c.lastId;
    return { sessions: [...bySession.values()], cursor: { lastId }, more: rows.length === BATCH };
  } finally { db.close(); }
}

module.exports = { id: 'hermes', label: 'Hermes', handover: 'hermes', experimental: false, sources, read };
