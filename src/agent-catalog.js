'use strict';
// The bundled Find agents catalogue (catalog/agents/catalog.json.gz, built by
// scripts/build-agent-catalog.js from pinned upstream commits). It is trusted
// only if its SHA-256 matches the value baked in at build time; a damaged or
// swapped file loads as { ok: false } and nothing can be added from it.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const PIN = require('./agent-catalog-pin.js');

const FILE = path.join(__dirname, '..', 'catalog', 'agents', 'catalog.json.gz');
const MAX_BYTES = 32 * 1024 * 1024;

function loadCatalog({ file = FILE, pin = PIN, fsApi = fs } = {}) {
  let json;
  try { json = zlib.gunzipSync(fsApi.readFileSync(file), { maxOutputLength: MAX_BYTES }); } catch { return { ok: false, error: 'The agent catalogue is missing or damaged. Reinstall Plexiform.' }; }
  const sha256 = createHash('sha256').update(json).digest('hex');
  if (sha256 !== pin.sha256) return { ok: false, error: 'The agent catalogue is damaged. Reinstall Plexiform.' };
  const catalog = JSON.parse(json.toString('utf8'));
  const byId = new Map(catalog.agents.map((a) => [a.id, a]));
  return {
    ok: true,
    sha256,
    catalog,
    get: (id) => (typeof id === 'string' ? byId.get(id) ?? null : null),
    body: (agent) => agent.raw.slice(agent.bodyOffset),
  };
}

let cached = null;
/** The shipped catalogue, verified once per process. */
function shipped() { if (!cached?.ok) cached = loadCatalog(); return cached; }

module.exports = { loadCatalog, shipped, FILE };
