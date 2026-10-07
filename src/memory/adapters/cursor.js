'use strict';

// Experimental. Cursor keeps its agent chats in its own SQLite store,
// <Cursor user data>/User/globalStorage/state.vscdb, table cursorDiskKV:
//   composerData:<composerId>          {name, createdAt, lastUpdatedAt, ...}
//   bubbleId:<composerId>:<bubbleId>   {type: 1 (user) | 2 (assistant), text, createdAt?, toolFormerData?}
// Opened read-only. The format is undocumented and changes between Cursor
// versions; anything unexpected is skipped. Chats carry no folder, so these
// sessions have no folder or repo.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { msOf } = require('./jsonl.js');

const MAX_COMPOSERS = 500;
const MAX_VALUE = 4 * 1024 * 1024;

function dbPath(home, platform = process.platform, env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home || os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}
const json = (v) => { const s = Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v; if (typeof s !== 'string' || s.length > MAX_VALUE) return null; try { const d = JSON.parse(s); return d && typeof d === 'object' ? d : null; } catch { return null; } };

function sources({ home, platform, env }) {
  const p = dbPath(home, platform, env);
  try { const st = fs.statSync(p); return st.isFile() ? [{ path: p, mtimeMs: st.mtimeMs, size: st.size, always: true }] : []; } catch { return []; }
}

function read(source, cursor, { since = 0 } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const seen = { ...((cursor && cursor.seen) || {}) };
  const db = new DatabaseSync(source.path, { readOnly: true });
  try {
    const sessions = [];
    const composers = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 5000").all();
    const bubbles = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?');
    for (const row of composers) {
      if (sessions.length >= MAX_COMPOSERS) break;
      const cid = String(row.key).slice('composerData:'.length);
      const d = json(row.value);
      if (!d || !/^[\w-]{1,100}$/.test(cid)) continue;
      const updated = msOf(d.lastUpdatedAt) ?? msOf(d.createdAt);
      if (updated === null || updated < since || seen[cid] === updated) continue;
      seen[cid] = updated;
      const s = { sid: cid, cwd: null, repo: null, branch: null, title: typeof d.name === 'string' && d.name ? d.name : null, started: msOf(d.createdAt), ended: updated, replace: true, turns: [] };
      for (const b of bubbles.all(`bubbleId:${cid}:`, `bubbleId:${cid};`)) {
        const m = json(b.value);
        if (!m || (m.type !== 1 && m.type !== 2)) continue;
        const ts = msOf(m.createdAt) ?? updated;
        if (ts < since) continue;
        const text = typeof m.text === 'string' ? m.text.trim() : '';
        const tool = m.toolFormerData && typeof m.toolFormerData.name === 'string' ? m.toolFormerData.name : null;
        if (!text && !tool) continue;
        const role = m.type === 1 ? 'user' : 'assistant';
        if (role === 'user' && !s.title) s.title = text;
        s.turns.push({ ts, role, text, files: [], tools: tool ? [tool] : [] });
      }
      sessions.push(s);
    }
    return { sessions, cursor: { seen }, more: false };
  } finally { db.close(); }
}

module.exports = { id: 'cursor', label: 'Cursor', handover: 'cursor', experimental: true, sources, read, dbPath };
