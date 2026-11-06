'use strict';
// Local observed hook metadata only: no transcripts, requests, titles, summaries,
// prompts, external commands or writes. These rows grant no control authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const text = (s, n = 80) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, n) : '';
const NEEDS = new Set(['permission-request', 'elicitation']);
const WORKING = new Set(['prompt-submit', 'tool-use', 'tool-done', 'subagent-start', 'subagent-done', 'compact']);
function readMetadata(directory, now = Date.now()) {
  const rows = [];
  try {
    const dir = fs.lstatSync(directory); if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid()) return rows;
    for (const name of fs.readdirSync(directory).filter((x) => /^[\w.-]+\.json$/.test(x)).slice(0, 200)) {
      try {
        const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let data;
        try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 128 * 1024) continue;
          // Read cap remains effective if a file grows after fstat.
          const b = Buffer.alloc(128 * 1024 + 1); const n = fs.readSync(fd, b, 0, b.length, 0); if (n > 128 * 1024) continue; data = JSON.parse(b.subarray(0, n).toString('utf8')); }
        finally { fs.closeSync(fd); }
        const provider = ['claude', 'codex', 'gemini'].includes(data.source) ? data.source : data.source ? 'other' : 'claude';
        const updated = Date.parse(data.updatedAt), age = Number.isFinite(updated) ? Math.max(0, now - updated) : null;
        if (data.signal === 'session-end' || (age !== null && age > 24 * 60 * 60 * 1000)) continue;
        const bucket = NEEDS.has(data.signal) ? 'needs' : ['tool-failed', 'turn-failed'].includes(data.signal) ? 'stuck' : data.signal === 'stop' ? 'check' : WORKING.has(data.signal) ? 'working' : 'idle';
        rows.push({ id: crypto.createHash('sha256').update(name).digest('hex'), title: `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider === 'gemini' ? 'Gemini' : 'AI'} session`, provider,
          project: text(path.basename(typeof data.cwd === 'string' ? data.cwd : '')), status: age === null || age > 90000 ? 'Last observed · stale' : bucket === 'needs' ? 'Needs you in its own app' : bucket === 'working' ? 'Working · observed' : bucket === 'check' ? 'Finished · check its app' : bucket === 'stuck' ? 'Needs attention' : 'Idle · observed', bucket,
          age_ms: age, hostApp: text(data.hostApp), cost: null, approvals: null, branch: null });
      } catch { /* partial, unreadable and replaced hook files are omitted */ }
    }
  } catch { /* not installed: the empty state explains the metadata boundary */ }
  return rows;
}
module.exports = { readMetadata };
