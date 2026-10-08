'use strict';

// This computer's own record of which board card an observed session belongs to
// (set from Sessions > Attach to card) and which repositories the person opted
// in to "Share handover with team". Private file, never read by a renderer.
// The hub has no session<->card link of its own, so an attachment is local only.

const fs = require('node:fs');
const path = require('node:path');

const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_LINKS = 500;
const REPO_KEY = /^[0-9a-f]{16}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, n);
const keyOf = (provider, sessionId) => `${provider}:${sessionId}`;

function destinationOf(d) {
  if (d && d.kind === 'team' && ID.test(d.team_id ?? '') && ID.test(d.board_id ?? '') && typeof d.hub === 'string') {
    try { const u = new URL(d.hub); if (u.origin === d.hub) return { kind: 'team', hub: d.hub, team_id: d.team_id, board_id: d.board_id }; } catch { /* below */ }
    return null;
  }
  return d && d.kind === 'local' ? { kind: 'local' } : null;
}

function create({ file, now = Date.now }) {
  let state = { v: 1, links: {}, share: {} };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && v.v === 1 && typeof v.links === 'object' && typeof v.share === 'object') state = { v: 1, links: v.links || {}, share: v.share || {} };
  } catch { /* none yet */ }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return {
    attach({ provider, session_id, card_id, card_key = '', title = '', destination }) {
      const dest = destinationOf(destination);
      if (!ID.test(provider ?? '') || !ID.test(session_id ?? '') || !ID.test(card_id ?? '') || !dest) return false;
      const key = keyOf(provider, session_id);
      if (!state.links[key] && Object.keys(state.links).length >= MAX_LINKS) {
        const oldest = Object.entries(state.links).sort((a, b) => a[1].at - b[1].at)[0];
        delete state.links[oldest[0]];
      }
      state.links[key] = { provider, session_id, card_id, card_key: clean(card_key, 40), title: clean(title, 120), destination: dest, at: now() };
      try { save(); return true; } catch { return false; }
    },
    forSession: (provider, sessionId) => state.links[keyOf(provider, sessionId)] ?? null,
    // The same shape as the work-capture overview rows, so session-handover forCard can read both.
    rows: () => Object.values(state.links).map((l) => ({ provider: l.provider, session_id: l.session_id, task_id: 'session', card_id: l.card_id, untracked: false, destination: { ...l.destination } })),
    shared: () => ({ ...state.share }),
    setShare(repo, on) {
      if (!REPO_KEY.test(repo ?? '')) return false;
      if (on === true) state.share[repo] = true; else delete state.share[repo];
      try { save(); return true; } catch { return false; }
    },
  };
}

module.exports = { create, keyOf };
