'use strict';
// The community gallery's item, entry and index shapes: one validator shared
// by the site build (site/gallery-build.js), the PR check and the app
// (src/gallery.js), so the site refuses exactly what the app refuses.
//
// An item is gallery/items/<kind>/<id>.json. The index is every item as an
// entry (`<kind>/<id>` plus a sha256 of the entry), with sorted keys and
// entries, so two builds from the same items give the same bytes and the
// owner's offline signature stays valid on the Pages build.
//
// This file must not load src/borrow/payload.js (it imports an .mjs the site
// build's Node may not load): setup payloads get a shape check here and the
// full check only in the app, via validateSetupPayload.

const { closed, canonical, hash, timeValid, FLOOR } = require('./plugins/index-verify.js');
const Recipes = require('./recipes.js');
const { validateCharacter } = require('../characters/validate.js');
const CharacterStore = require('./character-store.js');
const { findSecrets } = require('./secret-patterns.js');

const KINDS = Object.freeze(['recipe', 'character', 'pack', 'rules', 'setup']);
const ADDABLE = Object.freeze(['recipe', 'character']);
const STACKS = Object.freeze(['nextjs', 'python', 'swift', 'go', 'rust', 'node', 'rails', 'any']);
const LICENSES = Object.freeze(['CC0-1.0', 'MIT']);
const LIMITS = Object.freeze({ indexBytes: 2 * 1024 * 1024, entries: 500, entryBytes: 128 * 1024, id: 48, title: 80, summary: 300, name: 60, tags: 8, tag: 24, stacks: 4, packMin: 2, packMax: 12, note: 300, rules: 40, setupFiles: 128, setupFileBytes: 256 * 1024 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const GITHUB = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{64}$/;
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])/i;
const ITEM_KEYS = ['schema', 'kind', 'id', 'title', 'summary', 'author', 'license', 'tags', 'stacks', 'tools', 'added', 'updated', 'payload'];
const ENTRY_KEYS = ['id', 'kind', 'slug', 'title', 'summary', 'author', 'license', 'tags', 'stacks', 'tools', 'added', 'updated', 'sha256', 'payload'];
const INDEX_KEYS = ['kind', 'schemaVersion', 'serial', 'generatedAt', 'entries'];
// Setups writes these three as plain files an AI reads when asked. Rules files
// (CLAUDE.md/AGENTS.md/GEMINI.md) replace the whole home file and are followed
// in every session; mcp and settings change what runs. Those are refused.
const SETUP_TARGET = /^\.claude\/(?:skills\/[^/]+(?:\/[^/]+){1,3}|commands\/[^/]+(?:\/[^/]+){0,3}|agents\/[^/]+(?:\/[^/]+){0,3})$/;

const line = (v, max, { empty = false } = {}) => typeof v === 'string' && (empty || v.trim().length > 0) && v.length <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
const date = (v) => typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
const list = (v, max, ok) => Array.isArray(v) && v.length <= max && new Set(v).size === v.length && v.every(ok);
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
function leaks(value) {
  const text = strings(value).join('\n');
  return HOME_PATH.test(text) ? 'a home folder path' : findSecrets(text).length ? 'something that looks like a secret' : null;
}
// Sorted keys at every level: the byte form the index is built and signed in.
const sorted = (v) => JSON.parse(canonical(v));

// Format characters (bidi overrides, zero-width) let text read differently
// from what it is, in a confirm dialog or a prompt.
const FORMAT = /\p{Cf}/u;
function payloadProblems(kind, id, p, item = {}) {
  if (kind === 'recipe') {
    const out = Recipes.problems(p).map((x) => `payload.${x}`);
    if (p && p.id !== id) out.push('payload.id must equal the item id');
    if (p && p.title !== item.title) out.push('payload.title must equal the item title');
    if (strings(p).some((v) => FORMAT.test(v))) out.push('payload: invisible formatting characters (bidi or zero-width) are not allowed');
    if (p && p.edits !== false) out.push('payload.edits must be false: gallery recipes only read');
    return out;
  }
  if (kind === 'character') {
    if (p && Object.hasOwn(p, 'css')) return ['payload.css: gallery characters cannot carry CSS'];
    const v = validateCharacter(p, { source: 'import' });
    if (!v.ok) return v.errors.map((e) => `payload.${e.path || 'character'}: ${e.message}`);
    if (v.character.name !== p.name) return ['payload.name: plain text only (no control, formatting or markup characters, no surrounding spaces)'];
    return Buffer.byteLength(JSON.stringify(v.character)) > CharacterStore.LIMITS.fileBytes ? ['payload: character is too large'] : [];
  }
  if (kind === 'pack') {
    if (!closed(p, ['members', 'note'])) return ['payload: { members, note }'];
    const out = [];
    if (!Array.isArray(p.members) || p.members.length < LIMITS.packMin || p.members.length > LIMITS.packMax || new Set(p.members).size !== p.members.length) out.push(`payload.members: ${LIMITS.packMin}–${LIMITS.packMax} different items`);
    else for (const m of p.members) if (typeof m !== 'string' || !/^[a-z]+\/[a-z0-9-]+$/.test(m) || !KINDS.includes(m.split('/')[0]) || !ID.test(m.split('/')[1])) out.push(`payload.members: ${String(m).slice(0, 60)} is not kind/id`);
    else if (m.startsWith('pack/')) out.push(`payload.members: ${m}: packs cannot contain packs`);
    if (!line(p.note, LIMITS.note, { empty: true })) out.push(`payload.note: one line, up to ${LIMITS.note} characters`);
    return out;
  }
  if (kind === 'rules') {
    const Rules = require('../rules.js');
    if (!closed(p, ['rulesVersion', 'rules'])) return ['payload: { rulesVersion, rules }'];
    if (!Number.isInteger(p.rulesVersion) || p.rulesVersion < 1 || p.rulesVersion > Rules.RULES_VERSION) return [`payload.rulesVersion: 1–${Rules.RULES_VERSION}`];
    if (!Array.isArray(p.rules) || !p.rules.length || p.rules.length > LIMITS.rules) return [`payload.rules: 1–${LIMITS.rules} rules`];
    const out = [];
    p.rules.forEach((r, i) => {
      if (!r || typeof r !== 'object' || canonical(Rules.normalizeRule(r)) !== canonical(r)) out.push(`payload.rules[${i}]: not in the app's rule format`);
      else if (/^file:/.test(r.then.sound || '')) out.push(`payload.rules[${i}]: sounds from files on your Mac are not shared`);
      else if (r.then.cameo && !Rules.CAMEOS.includes(r.then.cameo)) out.push(`payload.rules[${i}]: photo cameos are not shared`);
    });
    if (!out.length && Rules.clickCommands(p.rules).length) out.push('payload.rules: clicks that run commands, Shortcuts, links or apps are not shared');
    return out;
  }
  if (kind === 'setup') {
    if (!closed(p, ['schema', 'files', 'items', 'note']) || p.schema !== 1 || !line(p.note, 2048, { empty: true }) || !Array.isArray(p.items) || p.items.length) return ['payload: { schema: 1, files, items: [], note }'];
    if (!Array.isArray(p.files) || !p.files.length || p.files.length > LIMITS.setupFiles) return [`payload.files: 1–${LIMITS.setupFiles} files`];
    const out = [];
    p.files.forEach((f, i) => {
      if (!closed(f, ['id', 'source_id', 'relative_path', 'format', 'content', 'note']) || ![f.id, f.source_id, f.relative_path, f.format, f.note].every((v) => typeof v === 'string' && v.length <= 1024) || typeof f.content !== 'string' || Buffer.byteLength(f.content) > LIMITS.setupFileBytes) out.push(`payload.files[${i}]: not a setup file`);
      else if (!SETUP_TARGET.test(f.relative_path)) out.push(`payload.files[${i}]: only skills, commands and agents are shared (not ${f.relative_path.slice(0, 80)})`);
    });
    return out;
  }
  return [];
}

// → [] when valid, else what is wrong. name: the file name without .json.
function validateItem(item, name) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['not an object'];
  const out = [];
  for (const k of Object.keys(item)) if (!ITEM_KEYS.includes(k)) out.push(`unknown field: ${k}`);
  for (const k of ITEM_KEYS) if (!Object.hasOwn(item, k)) out.push(`missing field: ${k}`);
  if (out.length) return out;
  if (item.schema !== 1) out.push('schema: 1');
  if (!KINDS.includes(item.kind)) out.push(`kind: one of ${KINDS.join(', ')}`);
  if (!(typeof item.id === 'string' && item.id.length <= LIMITS.id && ID.test(item.id))) out.push('id: lowercase words joined by dashes');
  else if (name !== undefined && name !== item.id) out.push(`id: must equal the file name (${name})`);
  if (!line(item.title, LIMITS.title)) out.push(`title: one line, up to ${LIMITS.title} characters`);
  if (!line(item.summary, LIMITS.summary)) out.push(`summary: one line, up to ${LIMITS.summary} characters`);
  if (!closed(item.author, ['name'], ['github']) || !line(item.author.name, LIMITS.name) || (Object.hasOwn(item.author, 'github') && !(typeof item.author.github === 'string' && GITHUB.test(item.author.github)))) out.push('author: { name, github? }');
  if (!LICENSES.includes(item.license)) out.push(`license: one of ${LICENSES.join(', ')}`);
  if (!list(item.tags, LIMITS.tags, (t) => typeof t === 'string' && t.length <= LIMITS.tag && TAG.test(t))) out.push(`tags: up to ${LIMITS.tags} lowercase words`);
  if (!list(item.stacks, LIMITS.stacks, (s) => STACKS.includes(s))) out.push(`stacks: up to ${LIMITS.stacks} of ${STACKS.join(', ')}`);
  if (!list(item.tools, Recipes.TOOLS.length, (t) => Recipes.TOOLS.includes(t))) out.push(`tools: any of ${Recipes.TOOLS.join(', ')}`);
  if (!date(item.added)) out.push('added: YYYY-MM-DD');
  if (!date(item.updated) || (date(item.added) && item.updated < item.added)) out.push('updated: YYYY-MM-DD, not before added');
  if (out.length) return out;
  out.push(...payloadProblems(item.kind, item.id, item.payload, item));
  const leak = leaks(item.kind === 'character' ? { ...item, payload: { name: item.payload.name } } : item);
  if (leak) out.push(`contains ${leak}`);
  return out;
}

const entryHash = (entry) => hash(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'sha256')));
function entryOf(item) {
  const { schema: _s, id, ...rest } = item;
  const entry = { ...rest, id: `${item.kind}/${id}`, slug: id };
  return sorted({ ...entry, sha256: entryHash(entry) });
}
function itemOf(entry) {
  const { id: _id, slug, sha256: _sha, ...rest } = entry;
  return { ...rest, schema: 1, id: slug };
}

function validateEntry(entry) {
  if (!closed(entry, ENTRY_KEYS)) return ['entry: unknown or missing fields'];
  if (entry.id !== `${entry.kind}/${entry.slug}`) return ['entry: id must be kind/slug'];
  if (typeof entry.sha256 !== 'string' || !SHA.test(entry.sha256) || entryHash(entry) !== entry.sha256) return ['entry: sha256 does not match'];
  if (Buffer.byteLength(JSON.stringify(entry)) > LIMITS.entryBytes) return [`entry: over ${LIMITS.entryBytes} bytes`];
  return validateItem(itemOf(entry));
}

// The index shape only: entries are checked one by one (validateEntry), so the
// app can drop a bad entry and keep the rest. timeOk comes from the verifier.
function validateIndex(index, timeOk = true) {
  if (!closed(index, INDEX_KEYS) || index.kind !== 'plexiform.gallery' || index.schemaVersion !== 1 || !Number.isSafeInteger(index.serial) || index.serial < 1 || !Array.isArray(index.entries) || index.entries.length > LIMITS.entries) return 'index-schema';
  return timeOk ? null : 'index-time';
}

// items: [{ item, name }] from gallery/items/<kind>/<name>.json; serial: the
// owner's counter from gallery/index-meta.json, raised on every publish, so a
// takedown (which can lower generatedAt) still supersedes the list before it.
// Throws with every problem found; else the index and its exact bytes.
function buildIndex(items, { serial = 1, now = Date.now() } = {}) {
  const problems = [];
  const seen = new Map();
  for (const { item, name, kind } of items) {
    const where = `${kind || item?.kind}/${name ?? item?.id}`;
    const found = validateItem(item, name);
    if (kind !== undefined && item?.kind !== kind) found.push(`kind: must equal the folder (${kind})`);
    // Apps refuse an index dated after tomorrow, so one future date would sink the whole gallery.
    if (!found.length) for (const k of ['added', 'updated']) if (Date.parse(`${item[k]}T00:00:00.000Z`) > now + 86400000) found.push(`${k}: not later than tomorrow`);
    for (const p of found) problems.push(`${where}: ${p}`);
    if (!found.length) {
      if (seen.has(`${item.kind}/${item.id}`)) problems.push(`${where}: duplicate`);
      seen.set(`${item.kind}/${item.id}`, item);
    }
  }
  for (const [where, item] of seen) if (item.kind === 'pack') for (const m of item.payload.members) if (!seen.has(m)) problems.push(`${where}: member ${m} is not in the gallery`);
  if (!seen.size) problems.push('no items');
  if (!Number.isSafeInteger(serial) || serial < 1) problems.push('serial: a whole number from 1 (gallery/index-meta.json)');
  if (seen.size > LIMITS.entries) problems.push(`more than ${LIMITS.entries} items`);
  if (problems.length) { const e = new Error(`gallery items are not valid:\n${problems.join('\n')}`); e.problems = problems; throw e; }
  const entries = [...seen.values()].map(entryOf).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of entries) if (Buffer.byteLength(JSON.stringify(e)) > LIMITS.entryBytes) problems.push(`${e.id}: over ${LIMITS.entryBytes} bytes`);
  const generatedAt = `${entries.map((e) => e.updated).sort().at(-1)}T00:00:00.000Z`;
  if (!timeValid(generatedAt, FLOOR, now)) problems.push(`generatedAt ${generatedAt}: apps accept ${FLOOR} up to tomorrow`);
  const index = sorted({ kind: 'plexiform.gallery', schemaVersion: 1, serial, generatedAt, entries });
  const text = `${JSON.stringify(index, null, 2)}\n`;
  if (Buffer.byteLength(text) > LIMITS.indexBytes) problems.push(`index is over ${LIMITS.indexBytes} bytes`);
  if (problems.length) { const e = new Error(`gallery items are not valid:\n${problems.join('\n')}`); e.problems = problems; throw e; }
  return { index, text };
}

// App only: the full reviewed-setups check (src/borrow/payload.js) on top of
// the shape check. Throws when it fails.
function validateSetupPayload(payload) {
  const shape = payloadProblems('setup', '', payload);
  if (shape.length) throw new Error(shape[0]);
  return require('./borrow/payload.js').validatePayload(payload);
}

module.exports = { KINDS, ADDABLE, STACKS, LICENSES, LIMITS, validateItem, validateEntry, validateIndex, entryHash, entryOf, buildIndex, validateSetupPayload };
