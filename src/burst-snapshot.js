'use strict';

// A whitelisted Burst snapshot for out-of-process readers (MCP server, board
// runner): main writes ROOT_DIR/burst-snapshot.json (0600, atomic) after each
// poll; readers treat a missing or stale file as "Burst not present".
// buildSnapshot/boardFacts are WP0 stubs that WP4 fills in; write/read are final.

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_FILE = 'burst-snapshot.json';
const STALE_MS = 2 * 60 * 1000;
const snapshotPath = (root) => path.join(root, SNAPSHOT_FILE);

// detection: burst-client detect(); coordination: normalizeCoordination() or null; requests: scrubbed /api/requests or null.
function buildSnapshot({ detection, now = Date.now() } = {}) {
  return { v: 1, at: now, present: !!detection && detection.kind === 'present' };
}

// Extra facts merged into the board runner's Burst message (src/burst-ipc.js pushBoardFacts).
function boardFacts(_snapshot) { return {}; }

function writeSnapshot(file, snapshot) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readSnapshot(file, { now = Date.now(), maxAgeMs = STALE_MS } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && Number.isFinite(s.at) && now - s.at <= maxAgeMs ? s : null;
  } catch { return null; }
}

module.exports = { buildSnapshot, boardFacts, writeSnapshot, readSnapshot, snapshotPath, SNAPSHOT_FILE, STALE_MS };
