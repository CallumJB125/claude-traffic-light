'use strict';
// "Start from this": a starter kit is a repo link (a reference, never cloned
// here), a CLAUDE.md, skills, MCP server entries and an optional budget, with
// a permission manifest generated from exactly those parts. It is packaged
// from a local project (only those files are read; MCP env and headers, which
// hold keys, are never read into it) or comes from a published build log.
// Installing writes into a folder the person picks, after the consent sheet
// shows the manifest; it never overwrites a file, and the CLAUDE.md credits
// the author it was remixed from.

const fs = require('node:fs');
const path = require('node:path');
const { hasCredential } = require('./secret-patterns.js');

const MAX = Object.freeze({ text: 20_000, skills: 20, mcp: 20, args: 20 });
const SKILL = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MCP_NAME = /^[A-Za-z0-9_.-]{1,60}$/;
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const fail = (m) => { throw new Error(m); };
const txt = (v, max, where) => { if (typeof v !== 'string' || v.length > max || HIDDEN.test(v)) fail(`${where} is not valid text`); return v; };
const https = (v, where) => { if (v == null || v === '') return null; let u; try { u = new URL(v); } catch { fail(`${where} must be an https link`); } if (u.protocol !== 'https:' || u.username || u.password) fail(`${where} must be an https link`); return u.href; };

// The same rules as the hub's validateKit (board/hub/build-logs.js), without the permissions it derives.
function normalize(kit) {
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) fail('a starter kit must be an object');
  const skills = Array.isArray(kit.skills) ? kit.skills : [];
  const mcp = Array.isArray(kit.mcp) ? kit.mcp : [];
  if (skills.length > MAX.skills || mcp.length > MAX.mcp) fail('too many skills or MCP servers');
  const out = {
    repo: https(kit.repo, 'repo'),
    claude_md: txt(kit.claude_md ?? '', MAX.text, 'CLAUDE.md'),
    skills: skills.map((s, i) => { const name = txt(s?.name, 60, `skill ${i + 1}`); if (!SKILL.test(name)) fail(`skill name "${name}" must be lower-case letters, digits and dashes`); return { name, content: txt(s.content, MAX.text, `skill ${name}`) }; }),
    mcp: mcp.map((m, i) => {
      const name = txt(m?.name, 60, `MCP server ${i + 1}`);
      if (!MCP_NAME.test(name)) fail(`MCP server name "${name}" is not valid`);
      const command = m.command == null ? null : txt(m.command, 200, `MCP server ${name} command`);
      const url = https(m.url, `MCP server ${name} url`);
      if (!command === !url) fail(`MCP server ${name} needs a command or an https url`);
      const args = Array.isArray(m.args) ? m.args : [];
      if (args.length > MAX.args) fail(`MCP server ${name} has too many arguments`);
      return { name, command, args: args.map((a) => txt(a, 200, `MCP server ${name} argument`)), url };
    }),
    budget_usd: kit.budget_usd == null ? null : (typeof kit.budget_usd === 'number' && kit.budget_usd > 0 && kit.budget_usd <= 10_000 ? Math.round(kit.budget_usd * 100) / 100 : fail('budget must be between $0.01 and $10,000')),
  };
  if (new Set(out.skills.map((s) => s.name)).size !== out.skills.length || new Set(out.mcp.map((m) => m.name)).size !== out.mcp.length) fail('skill and MCP server names must be unique');
  return out;
}

// What installing does, in plain words: the consent sheet shows exactly these lines.
function manifest(kit) {
  const lines = [];
  if (kit.claude_md) lines.push('Writes CLAUDE.md: instructions your AI reads at the start of every session in this folder.');
  for (const s of kit.skills) lines.push(`Adds the skill "${s.name}" (.claude/skills/${s.name}/SKILL.md): instructions your AI may follow.`);
  for (const m of kit.mcp) lines.push(m.command ? `Adds the MCP server "${m.name}" to .mcp.json: your AI may start \`${[m.command, ...m.args].join(' ')}\` on this computer.` : `Adds the MCP server "${m.name}" to .mcp.json: your AI may connect to ${m.url}.`);
  if (kit.budget_usd != null) lines.push(`Suggests a budget of $${kit.budget_usd.toFixed(2)} per task (shown to you; nothing is charged).`);
  if (kit.repo) lines.push(`Names ${kit.repo} as the template repository (a link only: nothing is downloaded).`);
  lines.push('Never overwrites a file that is already there.');
  return lines;
}

function readSmall(fsx, file, max = MAX.text) {
  try { const st = fsx.lstatSync(file); if (!st.isFile() || st.size > max) return null; return fsx.readFileSync(file, 'utf8'); } catch { return null; }
}
// git remote origin as an https link (GitHub/GitLab ssh forms rewritten), or null.
function repoOf(dir, fsx) {
  const cfg = readSmall(fsx, path.join(dir, '.git', 'config'), 64 * 1024);
  const m = cfg && /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
  if (!m) return null;
  let u = m[1].replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
  try { const x = new URL(u); if (x.protocol !== 'https:') return null; x.username = ''; x.password = ''; u = x.href.replace(/\/$/, ''); } catch { return null; }
  return u;
}

// Package a local project: only CLAUDE.md, .claude/skills/*/SKILL.md, .mcp.json (names, commands, args, urls) and the git remote.
function fromProject(dir, { fsx = fs, budget_usd = null } = {}) {
  const claude = readSmall(fsx, path.join(dir, 'CLAUDE.md')) || '';
  const skills = [];
  try {
    for (const name of fsx.readdirSync(path.join(dir, '.claude', 'skills')).sort()) {
      if (skills.length >= MAX.skills || !SKILL.test(name)) continue;
      const body = readSmall(fsx, path.join(dir, '.claude', 'skills', name, 'SKILL.md'));
      if (body) skills.push({ name, content: body });
    }
  } catch { /* no skills */ }
  const mcp = [];
  try {
    const servers = JSON.parse(readSmall(fsx, path.join(dir, '.mcp.json'), 256 * 1024) || '{}').mcpServers || {};
    for (const [name, s] of Object.entries(servers)) {
      if (mcp.length >= MAX.mcp || !MCP_NAME.test(name) || !s || typeof s !== 'object') continue;
      const command = typeof s.command === 'string' ? s.command : null;
      const url = typeof s.url === 'string' && /^https:/.test(s.url) ? s.url : null;
      if (!command === !url) continue;
      const args = Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string').slice(0, MAX.args) : [];
      // An argument that looks like a key is dropped, not shared.
      mcp.push({ name, command, args: args.filter((a) => !hasCredential(a)), url });
    }
  } catch { /* no MCP config */ }
  return normalize({ repo: repoOf(dir, fsx), claude_md: claude, skills, mcp, budget_usd });
}

// Files an install would write, relative to the folder; `exists` ones are skipped.
function plan(kit, dir, { credit = null, fsx = fs } = {}) {
  const k = normalize(kit);
  const out = [];
  const add = (rel, content) => { let exists = false; try { fsx.lstatSync(path.join(dir, rel)); exists = true; } catch { exists = false; } out.push({ rel, content, exists }); };
  const by = credit ? `<!-- Remixed from "${String(credit.title).replace(/-->/g, '')}" by ${String(credit.author).replace(/-->/g, '')}${credit.link ? ` (${credit.link})` : ''} with Plexiform. -->\n\n` : '';
  if (k.claude_md || by) add('CLAUDE.md', `${by}${k.claude_md}`);
  for (const s of k.skills) add(path.join('.claude', 'skills', s.name, 'SKILL.md'), s.content);
  if (k.mcp.length) add('.mcp.json', `${JSON.stringify({ mcpServers: Object.fromEntries(k.mcp.map((m) => [m.name, m.command ? { command: m.command, args: m.args } : { type: 'http', url: m.url }])) }, null, 2)}\n`);
  return out;
}

function install(kit, dir, { credit = null, fsx = fs } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('choose a folder');
  const st = fsx.statSync(dir);
  if (!st.isDirectory()) fail('choose a folder');
  const written = [], skipped = [];
  for (const f of plan(kit, dir, { credit, fsx })) {
    if (f.exists) { skipped.push(f.rel); continue; }
    const file = path.join(dir, f.rel);
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    try { fsx.writeFileSync(file, f.content, { flag: 'wx', mode: 0o644 }); written.push(f.rel); } catch (e) { if (e.code === 'EEXIST') skipped.push(f.rel); else throw e; }
  }
  return { written, skipped };
}

// A pasted build log link → its kit.json link (https only, /b/<22-char slug>).
function remixLink(text) {
  let u; try { u = new URL(String(text || '').trim()); } catch { return null; }
  const m = /^\/b\/([A-Za-z0-9_-]{22})(?:\/kit\.json)?\/?$/.exec(u.pathname);
  const loop = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!m || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) || u.username || u.password) return null;
  return { page: `${u.origin}/b/${m[1]}`, kit: `${u.origin}/b/${m[1]}/kit.json`, remix: `${u.origin}/b/${m[1]}/remix`, origin: u.origin, slug: m[1] };
}

module.exports = { normalize, manifest, fromProject, plan, install, remixLink, repoOf };
