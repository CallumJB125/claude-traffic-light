'use strict';

// Glue for the Sessions page's board features: the local session links, the
// board broker, the opt-in handover share and the read-only local-handover
// answer for the board page. Built once by the Buddy window.

const path = require('node:path');
const { execFile } = require('node:child_process');
const { toolEnv } = require('../src/tool-path');
const { withDeadline, GRACE_MS } = require('../src/bounded-io');
const { repoFor, routeKey } = require('../src/work-capture');
const Links = require('../src/session-links');
const Share = require('../src/handover-share');
const Handover = require('../src/session-handover');
const BurstHandover = require('../src/burst-handover');
const { createSessionBoards } = require('./session-boards');

// The git work tree a folder belongs to, or null.
function gitRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 2000 || cwd.includes('\0')) return Promise.resolve(null);
  return withDeadline((done) => execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
    { timeout: 2000, maxBuffer: 4096, env: toolEnv({ GIT_OPTIONAL_LOCKS: '0' }) }, (err, out) => done(err ? null : String(out).trim() || null)), 2000 + GRACE_MS);
}

function createSessionBridge({ userData, hubs, clientFor, userOf, signedIn, supervisor, workCapture, handoverWriter = () => null, currentHub = () => null, home = null, log = () => {} }) {
  const links = Links.create({ file: path.join(userData, 'session-links.json') });
  const boards = createSessionBoards({ hubs, clientFor, userOf, local: supervisor, getRoutes: () => workCapture.routes(), routeKey, log });
  const rows = () => [...(workCapture.overviewSnapshot?.() ?? []), ...links.rows()];
  let latest = [];
  const share = Share.create({
    writer: { text: (k) => handoverWriter()?.text(k) ?? null }, links, rows, rootOf: gitRoot, home, log,
    async getRoute(dest, cwd) {
      const canonical = await repoFor(cwd);
      const { routes } = await workCapture.routes();
      return routes.find((r) => r.hub === dest.hub && r.team_id === dest.team_id && r.board_id === dest.board_id && r.canonical_url === canonical && r.user_id === userOf(dest.hub)?.id) ?? null;
    },
    async send(dest, card, payload) {
      if (!signedIn(dest.hub)) return { ok: false };
      return clientFor(dest.hub).salvageHandover(dest.team_id, card, payload);
    },
  });
  return {
    links, boards, rows, gitRoot, share,
    sessionsChanged(sessions) { latest = Array.isArray(sessions) ? sessions : []; void share.pump(latest).catch(() => {}); },
    // The board page's read-only question: the local handover for a card, or null.
    async localHandover(cardId) {
      if (typeof cardId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(cardId)) return null;
      const writer = handoverWriter();
      const hub = currentHub();
      if (!writer || hub === undefined) return null;
      const allowed = await Share.rowsForHub({ rows: rows(), sessions: latest, hub, shared: links.shared(), rootOf: gitRoot });
      const doc = Handover.forCard(writer, cardId, allowed);
      if (doc || typeof writer.refresh !== 'function') return doc;
      // A card's Handover action before the writer's next pass: the Sessions page's "Write now".
      const row = allowed.find((c) => c && c.card_id === cardId && typeof c.session_id === 'string');
      if (!row || !(await writer.refresh(Handover.keyOf(Handover.adapterOf(row.provider), row.session_id)))?.ok) return null;
      return Handover.forCard(writer, cardId, allowed);
    },
    repoKey: BurstHandover.repoKey,
  };
}

module.exports = { createSessionBridge, gitRoot };
