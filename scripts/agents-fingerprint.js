#!/usr/bin/env node
'use strict';
// Dev-only, read-only: prints a fingerprint of an agents folder (every entry's
// path, kind, mode, size, mtime and sha256, or a link's target) so a rehearsal
// of Find agents' adopt/update/undo can prove the folder ends byte-identical.
// Links are never followed and nothing is written. Not shipped (package.json
// build.files). The design: .omc/plans/plan-find-agents.md §9 PR 4.
//
//   node scripts/agents-fingerprint.js <dir>            full listing, then a digest line
//   node scripts/agents-fingerprint.js <dir> --digest   the digest line only
//   node scripts/agents-fingerprint.js <dir> --restore  as --digest, without links' own times (what ditto keeps)
//   node scripts/agents-fingerprint.js <dir> --matches  counts only: how many .md files
//                                                      match the shipped catalogue exactly
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * One line per entry, sorted by path. `mtime: false` leaves times out;
 * `linkTimes: false` leaves out only links' own times, which ditto and cp -Rp
 * don't keep (a link's target is still compared).
 */
function fingerprint(dir, { mtime = true, linkTimes = true, fsApi = fs } = {}) {
  const out = [];
  const line = (kind, rel, st, extra) => out.push([kind, rel, (st.mode & 0o7777).toString(8).padStart(4, '0'), st.size, mtime && (linkTimes || kind !== 'L') ? Math.trunc(st.mtimeMs) : '-', extra].join(' '));
  const walk = (d, rel) => {
    for (const name of fsApi.readdirSync(d).sort()) {
      const p = path.join(d, name), r = rel ? `${rel}/${name}` : name, st = fsApi.lstatSync(p);
      if (st.isSymbolicLink()) line('L', r, st, fsApi.readlinkSync(p));
      else if (st.isDirectory()) { line('D', r, st, '-'); walk(p, r); }
      else if (st.isFile()) line('F', r, st, sha(fsApi.readFileSync(p)));
      else line('O', r, st, '-');
    }
  };
  const top = fsApi.lstatSync(dir);
  if (!top.isDirectory()) throw Object.assign(new Error('not a folder (or a link to one)'), { code: 'ENOTDIR' });
  walk(dir, '');
  return out;
}
const digest = (lines) => sha(lines.join('\n'));

// Counts only: never prints a file name or any content.
function catalogueMatches(dir, { fsApi = fs, catalog = require('../src/agent-catalog.js').shipped() } = {}) {
  if (!catalog.ok) throw new Error(catalog.error);
  const known = new Set(catalog.catalog.agents.map((a) => a.fileSha256));
  let md = 0, exact = 0, other = 0;
  for (const name of fsApi.readdirSync(dir)) {
    const p = path.join(dir, name), st = fsApi.lstatSync(p);
    if (!name.endsWith('.md')) { other++; continue; }
    if (!st.isFile()) { other++; continue; }
    md++;
    if (known.has(sha(fsApi.readFileSync(p)))) exact++;
  }
  return { md, exact, notMatching: md - exact, other };
}

if (require.main === module) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir || (flag && !['--digest', '--restore', '--matches'].includes(flag))) { console.error('usage: agents-fingerprint.js <dir> [--digest | --restore | --matches]'); process.exit(2); }
  try {
    if (flag === '--matches') {
      const m = catalogueMatches(dir);
      console.log(`${m.md} .md files: ${m.exact} match the catalogue exactly (adoptable), ${m.notMatching} don't; ${m.other} other entries.`);
    } else {
      const lines = fingerprint(dir, { linkTimes: flag !== '--restore' });
      if (!flag) for (const l of lines) console.log(l);
      console.log(`digest ${digest(lines)} (${lines.length} entries)`);
    }
  } catch (e) { console.error(`agents-fingerprint: ${e.code || e.message}`); process.exit(1); }
}

module.exports = { fingerprint, digest, catalogueMatches };
