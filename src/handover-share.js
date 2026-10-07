'use strict';

// The opt-in per-repo "Share handover with team" send (default off). For an
// observed session whose card is on a team board, and whose repository the
// person switched sharing on for, the scrubbed local handover goes to that
// card as a system-written salvage section. Nothing is sent for a viewer, for
// a repo not linked to that team board, when nothing changed, or faster than
// the gap and hourly limits below (the hub's own limit is 30 an hour).

const crypto = require('node:crypto');
const Handover = require('./session-handover.js');
const BurstHandover = require('./burst-handover.js');

const GAP_MS = 15 * 60_000;
const PER_HOUR = 12;

// getRoute(destination, cwd) -> the signed-in catalog route {role,...} when the cwd's repo is linked to that team board, else null.
function create({ writer, links, rows, rootOf, getRoute, send, home = null, user = null, now = Date.now, gapMs = GAP_MS, perHour = PER_HOUR, log = () => {} }) {
  const sent = new Map(); // key -> { hash, at }
  let hour = [];
  let running = false;
  async function pump(sessions) {
    if (running) return;
    running = true;
    try {
      const shared = links.shared();
      if (!Object.keys(shared).length) return;
      const cards = rows();
      for (const s of (Array.isArray(sessions) ? sessions : []).slice(0, 50)) {
        if (!s || s.remote || s.device || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string') continue;
        const adapter = Handover.adapterOf(s.source);
        const provider = adapter === 'claude-code' ? 'claude' : adapter;
        const card = cards.find((c) => c.session_id === s.sessionId && c.provider === provider && c.destination?.kind === 'team' && c.card_id);
        if (!card) continue;
        const root = await rootOf(s.cwd);
        if (!root || shared[BurstHandover.repoKey(root)] !== true) continue;
        const key = Handover.keyOf(adapter, s.sessionId);
        const doc = writer.text(key);
        const payload = doc ? Handover.salvagePayload(doc, { root, shared, home, user, date: new Date(now()).toISOString().slice(0, 10) }) : null;
        if (!payload || !payload.text) continue;
        // The scrub salts its hashes per call, so change is judged on the local document.
        const hash = crypto.createHash('sha256').update(doc).digest('hex');
        const last = sent.get(key);
        hour = hour.filter((t) => now() - t < 3_600_000);
        if (last && (last.hash === hash || now() - last.at < gapMs) || hour.length >= perHour) continue;
        const route = await getRoute(card.destination, s.cwd);
        if (!route || route.role === 'viewer') continue;
        sent.set(key, { hash: last?.hash ?? '', at: now() }); // a failed try waits out the gap too
        hour.push(now());
        let r = null;
        try { r = await send(card.destination, card.card_id, payload); } catch { r = null; }
        if (r && r.ok) sent.set(key, { hash, at: now() }); else log('[handover-share] send deferred');
      }
    } finally { running = false; }
  }
  return { pump };
}

module.exports = { create, GAP_MS, PER_HOUR };
