'use strict';

// Burst's HANDOFF.md as the handover of a Claude session Plexiform observes or
// shares but does not own. Shown locally always; sent to the team hub only for
// a repository the user switched "Share Burst handover with team" on for
// (default off), scrubbed, as a system-written salvage note. Salvage is the
// board's append-only section, so the human and agent layers are never touched.

const crypto = require('node:crypto');
const path = require('node:path');
const { scrub } = require('./scrub.js');

const MAX_CHARS = 4000;
const DATE = /(\d{4}-\d{2}-\d{2})/;

const norm = (p) => (typeof p === 'string' && p ? path.resolve(p) : '');

// The longest audited root that contains the session's working directory.
function matchRoot(cwd, audit) {
  const dir = norm(cwd);
  if (!dir) return null;
  let best = null;
  for (const e of Array.isArray(audit) ? audit : []) {
    const root = norm(e && e.root);
    if (!root) continue;
    if ((dir === root || dir.startsWith(root + path.sep)) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

// Burst prepends dated sections. Newest = latest date in a heading, first on a tie.
function newestSection(content) {
  const text = typeof content === 'string' ? content : '';
  const parts = text.split(/^(?=#{1,3} )/m).filter((p) => /^#{1,3} /.test(p));
  let best = null, bestDate = '';
  for (const p of parts) {
    const m = DATE.exec(p.split('\n', 1)[0]);
    if (m && m[1] > bestDate) { best = p; bestDate = m[1]; }
  }
  const section = (best || (parts.length ? parts[0] : text)).trim();
  return { text: section.slice(0, MAX_CHARS), date: bestDate };
}

// What the Sessions page shows for one observed session: local only.
function localView(content) {
  const s = newestSection(content);
  return s.text ? { text: s.text, date: s.date, source: 'Claude Burst HANDOFF.md' } : null;
}

const repoKey = (root) => crypto.createHash('sha256').update(norm(root)).digest('hex').slice(0, 16);

// The one thing that may leave the machine, and only when `shared` has the repo.
function hubPayload(root, content, { shared = {}, home = null, user = null } = {}) {
  if (!norm(root) || shared[repoKey(root)] !== true) return null;
  const s = newestSection(content);
  if (!s.text) return null;
  return {
    section: 'salvage',
    written_by: 'system',
    repo: repoKey(root),
    date: s.date,
    text: scrub(s.text, { home, user }).slice(0, MAX_CHARS),
  };
}

// send: the team hub client's append call. Absent = nothing is sent.
async function shareToHub({ root, content, shared, send, home, user }) {
  const payload = hubPayload(root, content, { shared, home, user });
  if (!payload) return { ok: false, reason: 'not-shared' };
  if (typeof send !== 'function') return { ok: false, reason: 'no-hub' };
  await send(payload); // privacy-flow: burst-handover-share
  return { ok: true };
}

module.exports = { matchRoot, newestSection, localView, hubPayload, shareToHub, repoKey, MAX_CHARS };
