#!/usr/bin/env node
'use strict';
// Builds the bundled Find agents catalogue from pinned upstream commits.
// Release time only: never shipped, never run by the app.
//
// Upstream content is untrusted data. This script only downloads the pinned
// tarball of each source with `gh api` (or reads one given with --archives),
// checks its SHA-256 and every included file's SHA-256 against
// catalog/agents/lock.json, and parses Markdown frontmatter as text. Nothing
// from an archive is written to disk except the normalised catalogue and each
// source's LICENSE text, and nothing from it is ever executed.
//
//   node scripts/build-agent-catalog.js              rebuild; fails if anything differs from lock.json
//   node scripts/build-agent-catalog.js --check      rebuild in memory; fails if the committed output differs
//   node scripts/build-agent-catalog.js --relock     after re-pinning a sha in catalog/sources.json
//   --archives <dir>        read <dir>/<source id>.tgz instead of downloading
//   --save-archives <dir>   keep the downloaded tarballs there (for a later --archives run)
//   --root <dir>            repository root to read and write (default: this checkout)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseFrontmatter, str, ALLOWED_KEYS } = require('../src/agent-frontmatter.js');
const { scanAgent, RULES_VERSION } = require('../src/agent-risk.js');

const SCHEMA = 1;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_UNPACKED = 256 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── tar (ustar + pax) reader, in memory ─────────────────────────────────────
function untar(buf) {
  const entries = [];
  let off = 0, pax = {}, global = {}, total = 0;
  const parsePax = (data) => {
    const out = {};
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const len = Number.parseInt(data.subarray(i, sp).toString('ascii'), 10);
      if (!(sp > i && len > sp - i && i + len <= data.length)) throw new Error('bad pax record');
      const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
      const eq = rec.indexOf('=');
      if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
      i += len;
    }
    return out;
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const sum = Number.parseInt(field(148, 156).trim() || '0', 8);
    let check = 0;
    for (let i = 0; i < 512; i++) check += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== check) throw new Error(`tar header checksum mismatch at ${off}`);
    let name = field(0, 100);
    const prefix = field(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = Number.parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || off + 512 + size > buf.length) throw new Error('bad tar entry size');
    total += size;
    if (total > MAX_UNPACKED) throw new Error('archive unpacks too large');
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') { global = { ...global, ...parsePax(data) }; continue; }
    if (type === 'x') { pax = parsePax(data); continue; }
    if (pax.path) name = pax.path;
    pax = {};
    entries.push({ name, type: type === '\0' ? '0' : type, data: Buffer.from(data) });
  }
  return { entries, global };
}

function globRe(glob) {
  const re = glob.split(/(\*\*\/|\*)/).map((part) => (part === '**/' ? '(?:[^/]+/)*' : part === '*' ? '[^/]*' : part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))).join('');
  return new RegExp(`^${re}$`);
}

// ── normalisation ───────────────────────────────────────────────────────────
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const clean = (s) => String(s ?? '').replace(/<example>[\s\S]*?<\/example>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.—-]+$/, '')}…`;
}
function firstSentence(s) {
  const m = s.match(/^(.+?[.!?])(?=\s+[A-Z(]|\s*$)/);
  return (m ? m[1] : s).trim();
}
function bestWhenOf(desc) {
  const m = desc.match(/\b((?:use|invoke|call|deploy|engage)\s+(?:this\s+agent\s+|it\s+|me\s+)?(?:proactively\s+|immediately\s+|automatically\s+)?(?:when|for|to|after|before|whenever|if)\b.*?)(?:[.!?](?=\s|$)|$)/i)
    ?? desc.match(/\b((?:best|ideal)\s+(?:used\s+)?(?:when|for)\b.*?)(?:[.!?](?=\s|$)|$)/i);
  if (!m) return null;
  const s = m[1].trim();
  return clip(s[0].toUpperCase() + s.slice(1), 160);
}
const toolList = (v) => (v == null ? null : (Array.isArray(v) ? v : String(v).split(',')).map((t) => String(t).trim()).filter(Boolean));
const compile = (rules) => rules.map((r) => ({ ...r, re: new RegExp(`\\b(?:${r.match})`, 'i') }));

function classify(entry, rules, override) {
  const divMap = rules.divisions[entry.source] ?? {};
  const top = entry.division.split('/')[0];
  let category = override.category ?? divMap[top] ?? divMap[entry.division] ?? null;
  for (const hay of [entry.name.replace(/[-_]/g, ' '), entry.description, entry.division.replace(/[-_/]/g, ' ')]) {
    if (category) break;
    category = rules.categoryRules.find((r) => r.re.test(hay))?.category ?? null;
  }
  category ??= rules.defaultCategory;
  if (!rules.categories[category]) throw new Error(`${entry.id}: unknown category ${category}`);
  let icon = override.icon ?? null;
  if (!icon) icon = rules.iconRules.find((r) => r.re.test(entry.name.replace(/[-_]/g, ' ')))?.icon ?? null;
  if (!icon) icon = rules.iconRules.find((r) => r.re.test(entry.description))?.icon ?? null;
  if (!icon) icon = rules.categories[category].icon ?? rules.fallbackIcon;
  if (!rules.glyphs.includes(icon)) throw new Error(`${entry.id}: unknown icon ${icon}`);
  return { category, icon };
}

function licenseKind(text) {
  if (/\bMIT License\b/i.test(text) || /Permission is hereby granted, free of charge, to any person obtaining a copy/.test(text)) return 'MIT';
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  return null;
}

// ── build ───────────────────────────────────────────────────────────────────
function loadArchive(src, opts) {
  if (opts.archives) return fs.readFileSync(path.join(opts.archives, `${src.id}.tgz`));
  // gh resolves the tarball for this exact commit; nothing else is fetched.
  const buf = execFileSync('gh', ['api', `repos/${src.repo}/tarball/${src.sha}`], { maxBuffer: MAX_ARCHIVE, stdio: ['ignore', 'pipe', 'inherit'] });
  if (opts.saveArchives) { fs.mkdirSync(opts.saveArchives, { recursive: true }); fs.writeFileSync(path.join(opts.saveArchives, `${src.id}.tgz`), buf); }
  return buf;
}

function readSource(src, lockEntry, opts, report) {
  if (!ID.test(src.id) || !REPO.test(src.repo) || !SHA.test(src.sha)) throw new Error(`source ${src.id}: bad id, repo or sha`);
  const archive = loadArchive(src, opts);
  if (archive.length > MAX_ARCHIVE) throw new Error(`${src.id}: archive too large`);
  const archiveSha256 = sha256(archive);
  const relock = opts.relock || !lockEntry || lockEntry.sha !== src.sha;
  if (!relock && lockEntry.archiveSha256 !== archiveSha256 && !opts.allowArchiveDrift) throw new Error(`${src.id}: archive SHA-256 ${archiveSha256} does not match lock.json (${lockEntry.archiveSha256}). If GitHub regenerated the archive, rerun with --allow-archive-drift: every file is still checked against its own SHA-256.`);
  if (!relock && lockEntry.sha !== src.sha) throw new Error(`${src.id}: sha differs from lock.json; rerun with --relock to re-pin`);
  const { entries, global } = untar(zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED }));
  if (global.comment !== src.sha) throw new Error(`${src.id}: archive is for commit ${global.comment}, not the pinned ${src.sha}`);
  const include = src.include.map(globRe), exclude = (src.exclude ?? []).map(globRe);
  const files = new Map();
  let licenseText = null;
  for (const e of entries) {
    const rel = e.name.replace(/^[^/]+\//, '');
    if (!rel || rel.includes('..') || rel.startsWith('/')) continue;
    if (rel === src.licensePath) {
      if (e.type !== '0') throw new Error(`${src.id}: ${src.licensePath} is not a regular file`);
      licenseText = e.data.toString('utf8');
      continue;
    }
    if (!include.some((r) => r.test(rel)) || exclude.some((r) => r.test(rel))) continue;
    if (e.type !== '0') { report.skipped.push({ source: src.id, path: rel, reason: 'not a regular file (link or folder)' }); continue; }
    files.set(rel, e.data);
  }
  if (licenseText == null) throw new Error(`${src.id}: no ${src.licensePath} in the archive`);
  const kind = licenseKind(licenseText);
  if (kind !== src.license) throw new Error(`${src.id}: licence at the pinned commit reads as ${kind ?? 'unknown'}, not ${src.license}`);
  const fileHashes = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => [p, sha256(d)]));
  if (!relock) {
    const want = lockEntry.files ?? {};
    const diff = [...new Set([...Object.keys(want), ...Object.keys(fileHashes)])].filter((p) => want[p] !== fileHashes[p]);
    if (diff.length) throw new Error(`${src.id}: ${diff.length} file(s) differ from lock.json, e.g. ${diff.slice(0, 3).join(', ')}`);
    if (lockEntry.licenseSha256 !== sha256(licenseText)) throw new Error(`${src.id}: LICENSE differs from lock.json`);
  }
  const copyright = (licenseText.match(/^\s*Copyright\b.*$/im)?.[0] ?? '').trim();
  return {
    lock: { sha: src.sha, archiveSha256: lockEntry && !relock && opts.allowArchiveDrift ? lockEntry.archiveSha256 : archiveSha256, archiveBytes: archive.length, licenseSha256: sha256(licenseText), files: fileHashes },
    licenseText, copyright, files,
  };
}

function build(root, opts = {}) {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const sources = read('catalog/sources.json').sources.filter((s) => s.enabled);
  let lock = {};
  try { lock = read('catalog/agents/lock.json').sources ?? {}; } catch { lock = {}; }
  const rulesFile = read('catalog/agents/icon-rules.json');
  const rules = { ...rulesFile, categoryRules: compile(rulesFile.categoryRules), iconRules: compile(rulesFile.iconRules) };
  const overrides = read('catalog/agents/overrides.json').agents ?? {};
  const report = { skipped: [], excludedHighRisk: [], sameNameInSource: [], duplicates: [], overridden: [] };
  const outLock = {}, licenses = {}, sourceMeta = [];
  let all = [];

  for (const src of sources) {
    const got = readSource(src, lock[src.id], opts, report);
    outLock[src.id] = got.lock;
    licenses[src.id] = got.licenseText;
    sourceMeta.push({ id: src.id, name: src.name, repo: src.repo, url: `https://github.com/${src.repo}`, sha: src.sha, license: src.license, copyright: got.copyright, licenseFile: `licenses/${src.id}.LICENSE`, stars: src.stars });
    const bySlug = new Map();
    for (const [rel, data] of [...got.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const raw = data.toString('utf8');
      if (!Buffer.from(raw, 'utf8').equals(data)) { report.skipped.push({ source: src.id, path: rel, reason: 'not valid UTF-8' }); continue; }
      let fm;
      try { fm = parseFrontmatter(raw); } catch (e) { report.skipped.push({ source: src.id, path: rel, reason: e.message === 'no frontmatter' ? 'no frontmatter (not an agent file)' : `frontmatter: ${e.message}` }); continue; }
      const name = str(fm.fields, 'name')?.trim(), description = str(fm.fields, 'description')?.trim();
      if (!name || !description || name.length > 120 || !slugify(name)) { report.skipped.push({ source: src.id, path: rel, reason: 'no usable name or description' }); continue; }
      // A name ends up on one line in other platforms' files, so it may not hold line breaks or control characters.
      if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(name)) { report.skipped.push({ source: src.id, path: rel, reason: 'name contains control characters' }); continue; }
      // Only allowlisted keys: hooks, mcpServers, permissionMode and the like act
      // beyond the prompt, and disallowedTools can't be carried to other platforms.
      const extra = Object.keys(fm.fields).filter((k) => !ALLOWED_KEYS.has(k));
      if (extra.length) { report.skipped.push({ source: src.id, path: rel, reason: `frontmatter key not allowed: ${extra.join(', ')}` }); continue; }
      const slug = slugify(name);
      const division = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel).replace(/^categories\//, '').replace(/^plugins\/([^/]+)\/agents$/, '$1').replace(/^agents$/, '');
      const key = src.dedupeKey === 'stem' ? slugify(path.posix.basename(rel, '.md')) : slug;
      const item = { rel, raw, fm, name, description, slug, key, division, fileSha256: sha256(data), bodySha256: sha256(raw.slice(fm.bodyOffset)) };
      if (!bySlug.has(key)) bySlug.set(key, []);
      bySlug.get(key).push(item);
    }
    for (const [key, items] of bySlug) {
      let pick = items[0];
      if (items.length > 1) {
        // One agent copied several times inside a source: keep the variant
        // whose prompt most copies agree on (ties: first by path). Content is
        // never merged.
        const counts = new Map();
        for (const it of items) counts.set(it.bodySha256, (counts.get(it.bodySha256) ?? 0) + 1);
        pick = items.reduce((best, it) => (counts.get(it.bodySha256) > counts.get(best.bodySha256) ? it : best), items[0]);
        report.sameNameInSource.push({ source: src.id, key, kept: pick.rel, dropped: items.filter((it) => it !== pick).map((it) => it.rel) });
      }
      const { fm, raw, rel, name, description, division, slug } = pick;
      const id = `${src.id}/${key}`;
      const ov = overrides[id] ?? {};
      const body = raw.slice(fm.bodyOffset);
      const declared = toolList(fm.fields.tools);
      const desc = clean(description);
      const entry = {
        id, source: src.id, sourcePath: rel, sourceSha: src.sha, fileSha256: pick.fileSha256,
        name, slug, key, description: desc,
        oneLiner: ov.oneLiner ?? clip(firstSentence(desc), 120),
        bestWhen: ov.bestWhen ?? bestWhenOf(desc),
        category: null, division, tags: [...new Set(division.split('/').filter(Boolean).concat(toolList(fm.fields.services?.map?.((s) => (typeof s === 'string' ? s : s.name)) ?? fm.fields.services) ?? []))],
        tools: { declared, effective: declared ?? 'all' },
        model: str(fm.fields, 'model'),
        vibe: str(fm.fields, 'vibe'), upstreamColor: str(fm.fields, 'color'), upstreamEmoji: str(fm.fields, 'emoji'),
        author: str(fm.fields, 'author'),
        raw, bodyOffset: fm.bodyOffset, bodyBytes: Buffer.byteLength(body),
        risk: scanAgent({ body, tools: declared, frontmatter: fm.frontmatter }),
        icon: null, license: src.license,
        attribution: `"${name}" from github.com/${src.repo} at ${src.sha.slice(0, 7)}. ${src.license} License${got.copyright ? `, ${got.copyright}` : ''}.`,
        aliases: [], primary: true,
      };
      Object.assign(entry, classify(entry, rules, ov));
      if (ov.exclude) { if (!ov.reason) throw new Error(`${id}: exclude override needs a reason`); report.overridden.push({ id, action: 'exclude', reason: ov.reason }); continue; }
      if (entry.risk.level === 'high') {
        if (!ov.include) { report.excludedHighRisk.push({ id, path: rel, flags: entry.risk.flags.filter((f) => f.level === 'high').map(({ rule, line, excerpt }) => ({ rule, line, excerpt })) }); continue; }
        if (!ov.reason) throw new Error(`${id}: include override needs a reason`);
        report.overridden.push({ id, action: 'include', reason: ov.reason });
      }
      all.push(entry);
    }
  }

  // Cross-source dedupe by key: one primary per name, the rest listed as aliases.
  const stars = Object.fromEntries(sources.map((s) => [s.id, s.stars ?? 0]));
  const groups = new Map();
  for (const e of all) { if (!groups.has(e.key)) groups.set(e.key, []); groups.get(e.key).push(e); }
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => (b.tools.declared ? 1 : 0) - (a.tools.declared ? 1 : 0) || stars[b.source] - stars[a.source] || (a.id < b.id ? -1 : 1));
    for (const e of list) { e.primary = e === list[0]; e.aliases = list.filter((x) => x !== e).map((x) => x.id).sort(); }
    report.duplicates.push({ key, primary: list[0].id, also: list.slice(1).map((x) => x.id) });
  }
  all = all.sort((a, b) => (a.id < b.id ? -1 : 1));
  const categories = Object.fromEntries(Object.entries(rulesFile.categories).map(([k, v]) => [k, { label: v.label, icon: v.icon }]));
  const catalog = { schema: SCHEMA, riskRules: RULES_VERSION, sources: sourceMeta, categories, agents: all };
  const json = `${JSON.stringify(catalog)}\n`;
  const counts = { total: all.length, unique: groups.size, bySource: Object.fromEntries(sources.map((s) => [s.id, all.filter((e) => e.source === s.id).length])), primaryBySource: Object.fromEntries(sources.map((s) => [s.id, all.filter((e) => e.source === s.id && e.primary).length])), fallbackIcons: all.filter((e) => e.icon === rules.fallbackIcon).length, review: all.filter((e) => e.risk.level === 'review').length };
  report.counts = counts;
  report.skipped.sort((a, b) => (a.source + a.path < b.source + b.path ? -1 : 1));
  return { catalog, json, lock: { schema: SCHEMA, sources: outLock }, licenses, report, sources: sourceMeta };
}

// npm packages that ship inside the app (root `dependencies` the code requires directly).
function bundledNpmSection(list) {
  const lines = ['## Bundled npm packages', '', 'These packages are installed from npm and shipped in the app unchanged.', ''];
  for (const p of list) lines.push(`### ${p.name}`, '', `- Version: ${p.version}`, `- Licence: ${p.license}`, `- Source: ${p.url}`, '');
  return lines.join('\n');
}

function notices(sources, bundled = []) {
  const lines = [
    '# Third-party notices',
    '',
    'Plexiform is MIT licensed (see `package.json`). It bundles the third-party material below. This file is generated by `scripts/build-agent-catalog.js`; edit `catalog/sources.json` instead.',
    '',
    '## Agent catalogue (Find agents)',
    '',
    'The agent prompts in `catalog/agents/catalog.json.gz` are copied unchanged from these repositories at the pinned commits. Each licence text ships in `catalog/agents/licenses/`. The agents are third-party prompts: Plexiform does not write or endorse them.',
    '',
  ];
  for (const s of sources) {
    lines.push(`### ${s.name}`, '', `- Source: ${s.url}`, `- Commit: \`${s.sha}\``, `- Licence: ${s.license}${s.copyright ? ` (${s.copyright})` : ''}`, `- Licence text: \`catalog/agents/${s.licenseFile}\``, '');
  }
  if (bundled.length) lines.push(bundledNpmSection(bundled));
  return `${lines.join('\n').trimEnd()}\n`;
}

function pinModule(json, counts) {
  return `'use strict';\n// Generated by scripts/build-agent-catalog.js. The SHA-256 of the uncompressed\n// catalogue, checked by src/agent-catalog.js before the app trusts it.\nmodule.exports = Object.freeze({ sha256: '${sha256(Buffer.from(json))}', agents: ${counts.total} });\n`;
}

function outputs(root, result) {
  const out = new Map();
  const dir = 'catalog/agents';
  out.set(`${dir}/catalog.json.gz`, { json: result.json });
  out.set(`${dir}/lock.json`, `${JSON.stringify(result.lock, null, 2)}\n`);
  out.set(`${dir}/build-report.json`, `${JSON.stringify(result.report, null, 2)}\n`);
  for (const [id, text] of Object.entries(result.licenses)) out.set(`${dir}/licenses/${id}.LICENSE`, text);
  out.set('THIRD_PARTY_NOTICES.md', notices(result.sources, JSON.parse(fs.readFileSync(path.join(root, 'catalog/bundled-npm.json'), 'utf8'))));
  out.set('src/agent-catalog-pin.js', pinModule(result.json, result.report.counts));
  return out;
}

function readCatalogJson(file) { try { return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'); } catch { return null; } }

function summarize(before, after) {
  const old = new Map((before?.agents ?? []).map((a) => [a.id, a.fileSha256 + a.risk.level + a.icon + a.category]));
  const now = new Map(after.agents.map((a) => [a.id, a.fileSha256 + a.risk.level + a.icon + a.category]));
  return { added: [...now.keys()].filter((k) => !old.has(k)), removed: [...old.keys()].filter((k) => !now.has(k)), changed: [...now.keys()].filter((k) => old.has(k) && old.get(k) !== now.get(k)) };
}

function main(argv) {
  const opts = { check: false, relock: false, allowArchiveDrift: false, archives: null, saveArchives: null, root: path.join(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--relock') opts.relock = true;
    else if (a === '--allow-archive-drift') opts.allowArchiveDrift = true;
    else if (a === '--archives') opts.archives = path.resolve(argv[++i]);
    else if (a === '--save-archives') opts.saveArchives = path.resolve(argv[++i]);
    else if (a === '--root') opts.root = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  const result = build(opts.root, opts);
  const files = outputs(opts.root, result);
  const gz = path.join(opts.root, 'catalog/agents/catalog.json.gz');
  const beforeJson = readCatalogJson(gz);
  const diff = summarize(beforeJson ? JSON.parse(beforeJson) : null, result.catalog);
  const stale = [];
  for (const [rel, content] of files) {
    const full = path.join(opts.root, rel);
    if (content.json !== undefined) { if (readCatalogJson(full) !== content.json) stale.push(rel); continue; }
    let cur = null; try { cur = fs.readFileSync(full, 'utf8'); } catch { /* missing */ }
    if (cur !== content) stale.push(rel);
  }
  const c = result.report.counts;
  const gzBytes = zlib.gzipSync(result.json, { level: 9 }).length;
  console.log(`agents: ${c.total} (${c.unique} unique names) ${JSON.stringify(c.bySource)}; review-flagged ${c.review}; high-risk excluded ${result.report.excludedHighRisk.length}; fallback icons ${c.fallbackIcons}`);
  console.log(`catalogue: ${Buffer.byteLength(result.json)} bytes uncompressed, ${gzBytes} gzipped`);
  console.log(`diff vs committed: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
  for (const [k, ids] of Object.entries(diff)) if (ids.length && ids.length <= 40) console.log(`  ${k}: ${ids.join(', ')}`);
  if (opts.check) {
    if (stale.length) { console.error(`out of date: ${stale.join(', ')}`); return 1; }
    console.log('up to date');
    return 0;
  }
  for (const [rel, content] of files) {
    if (!stale.includes(rel)) continue;
    const full = path.join(opts.root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.json !== undefined ? zlib.gzipSync(content.json, { level: 9 }) : content);
  }
  const licDir = path.join(opts.root, 'catalog/agents/licenses');
  for (const f of fs.readdirSync(licDir)) if (!files.has(`catalog/agents/licenses/${f}`)) fs.unlinkSync(path.join(licDir, f));
  console.log(stale.length ? `wrote ${stale.join(', ')}` : 'nothing changed');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`build-agent-catalog: ${e.message}`); process.exitCode = 1; }
}

module.exports = { build, outputs, untar, globRe, slugify, bestWhenOf, firstSentence, clip, licenseKind, notices, bundledNpmSection, main };
