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

const TOOL_WORDS = [
  [['Read', 'Grep', 'Glob'], 'read files'],
  [['Write', 'Edit', 'MultiEdit', 'NotebookEdit'], 'edit files'],
  [['Bash'], 'run terminal commands'],
  [['WebFetch', 'WebSearch'], 'use the web'],
];
/** What an agent's tools let it do, in plain words, for the page. */
function toolsInWords(tools) {
  if (!tools || tools.declared === null) return 'Every tool your AI tool has. The author didn\'t limit it.';
  const declared = tools.declared.filter((t) => typeof t === 'string');
  const words = TOOL_WORDS.filter(([names]) => names.some((n) => declared.includes(n))).map(([, w]) => w);
  const known = new Set(TOOL_WORDS.flatMap(([names]) => names));
  const other = declared.filter((t) => !known.has(t));
  if (other.length) words.push(`use ${other.length === 1 ? 'one other tool' : `${other.length} other tools`} (${other.join(', ')})`);
  if (!words.length) return 'No tools.';
  const s = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/** The list fields the page gets for every agent: never the prompt itself. */
function summary(a) {
  return {
    id: a.id, name: a.name, slug: a.slug, category: a.category, icon: a.icon, source: a.source, license: a.license,
    oneLiner: a.oneLiner, bestWhen: a.bestWhen, description: a.description, tags: a.tags,
    everyTool: a.tools.declared === null, toolsSummary: toolsInWords(a.tools), risk: a.risk.level,
    // "Every tool" has its own chip, so this counts the other flags only.
    flagCount: a.risk.flags.filter((f) => f.rule !== 'all-tools').length,
    primary: a.primary !== false, aliases: a.aliases,
  };
}

module.exports = { loadCatalog, shipped, toolsInWords, summary, FILE };
