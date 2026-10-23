'use strict';
// A temp HOME whose ~/.claude/agents is shaped like a real, long-used one,
// built from the shipped catalogue's own bytes at test time, never from
// anyone's real folder. Used by the PR 4 adopt/backup/restore proofs
// (test/agent-adopt-safety.test.js); the design is .omc/plans/plan-find-agents.md §9 PR 4.
//
// What it holds (170 top-level .md files, plus the awkward cases):
// - 120 byte-exact catalogue agents, 30 from each source, as <slug>.md
// - 20 near misses: one byte changed, CRLF line endings, a trailing newline
// - 30 of the user's own agents
// - a subfolder with an exact copy (adoption looks at the top level only),
//   a hidden file, a non-.md file, an empty .md, a link to an exact copy kept
//   elsewhere, a dangling link, a link to a fake ~/.ssh/id_rsa, a read-only
//   exact copy, an exact copy last changed in 2001, and a name with a space
//   and an emoji
const fs = require('node:fs');
const path = require('node:path');

const OLD = new Date('2001-02-03T04:05:06Z');
const SECRET = 'FAKE PRIVATE KEY: the fixture must never read or copy this as bytes\n';

/** Writes the fixture into `home`. Returns what went where, by file name. */
function buildAgentsHome(home, catalog) {
  const dir = path.join(home, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, bytes, mode = 0o644) => { fs.writeFileSync(path.join(dir, name), bytes, { mode }); fs.chmodSync(path.join(dir, name), mode); };

  const bySource = new Map();
  for (const a of [...catalog.catalog.agents].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (!bySource.has(a.source)) bySource.set(a.source, []);
    bySource.get(a.source).push(a);
  }
  const used = new Set();
  const pick = (list, n) => {
    const out = [];
    const step = Math.max(1, Math.floor(list.length / (n + 5)));
    for (let i = 0; i < list.length && out.length < n; i += step) if (!used.has(list[i].slug)) { used.add(list[i].slug); out.push(list[i]); }
    for (const a of list) { if (out.length >= n) break; if (!used.has(a.slug)) { used.add(a.slug); out.push(a); } }
    return out;
  };
  const exact = [];
  for (const [, list] of [...bySource].sort()) for (const a of pick(list, 30)) { put(`${a.slug}.md`, a.raw); exact.push({ name: `${a.slug}.md`, agentId: a.id }); }

  const rest = [...catalog.catalog.agents].filter((a) => !used.has(a.slug)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const nearMiss = [];
  rest.slice(0, 20).forEach((a, i) => {
    used.add(a.slug);
    const raw = a.raw;
    const bytes = i % 3 === 0 ? raw.replace(/e/, 'E') : i % 3 === 1 ? raw.replace(/\n/g, '\r\n') : `${raw}\n`;
    put(`${a.slug}.md`, bytes);
    nearMiss.push(`${a.slug}.md`);
  });

  const own = [];
  for (let i = 0; i < 30; i++) {
    const name = `my-helper-${String(i).padStart(2, '0')}.md`;
    put(name, `---\nname: my-helper-${i}\ndescription: Something I wrote myself (${i}).\n---\n\nYou are my helper number ${i}.\n`);
    own.push(name);
  }

  // The awkward cases.
  const [sub, ro, aged, linked] = rest.slice(20, 24);
  fs.mkdirSync(path.join(dir, 'team'));
  fs.writeFileSync(path.join(dir, 'team', `${sub.slug}.md`), sub.raw);
  fs.writeFileSync(path.join(dir, '.DS_Store'), Buffer.from([0, 0, 0, 1, 66, 117, 100, 49]));
  fs.writeFileSync(path.join(dir, 'README.txt'), 'My agents.\n');
  put('empty.md', '');
  put(`${ro.slug}.md`, ro.raw, 0o444);
  put(`${aged.slug}.md`, aged.raw);
  fs.utimesSync(path.join(dir, `${aged.slug}.md`), OLD, OLD);
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.writeFileSync(path.join(home, 'elsewhere', `${linked.slug}.md`), linked.raw);
  fs.symlinkSync(path.join('..', '..', 'elsewhere', `${linked.slug}.md`), path.join(dir, `${linked.slug}.md`));
  fs.symlinkSync('nowhere.md', path.join(dir, 'gone.md'));
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), SECRET, { mode: 0o600 });
  fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(dir, 'secret.md'));
  put('my agent ✨.md', `---\nname: sparkle\ndescription: A name with a space and an emoji.\n---\n\nHi.\n`);
  for (const a of [sub, ro, aged, linked]) used.add(a.slug);

  return {
    dir,
    // What adoptable() must find: every exact top-level regular file.
    adoptable: [...exact.map((e) => e.name), `${ro.slug}.md`, `${aged.slug}.md`].sort(),
    exact, nearMiss, own,
    readOnly: `${ro.slug}.md`, aged: `${aged.slug}.md`, linked: `${linked.slug}.md`, nested: `team/${sub.slug}.md`,
    secret: SECRET,
  };
}

module.exports = { buildAgentsHome, OLD };
