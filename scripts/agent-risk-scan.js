#!/usr/bin/env node
'use strict';
// Runs the risky-directive scan (src/agent-risk.js) over agent Markdown files
// or over the shipped catalogue, and prints every flag. Reads text only.
//
//   node scripts/agent-risk-scan.js path/to/agent.md [...]   scan files
//   node scripts/agent-risk-scan.js --catalog [--high]       rescan the shipped catalogue
// Exits 1 if any scanned agent is high risk.
const fs = require('node:fs');
const { parseFrontmatter } = require('../src/agent-frontmatter.js');
const { scanAgent } = require('../src/agent-risk.js');

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  let body = text, tools = null, frontmatter = '';
  try {
    const fm = parseFrontmatter(text);
    body = text.slice(fm.bodyOffset);
    frontmatter = fm.frontmatter;
    const t = fm.fields.tools;
    tools = t == null ? null : (Array.isArray(t) ? t : String(t).split(',')).map((x) => x.trim()).filter(Boolean);
  } catch { /* scanned as plain text */ }
  return scanAgent({ body, tools, frontmatter });
}

function main(argv) {
  const onlyHigh = argv.includes('--high');
  const results = [];
  if (argv.includes('--catalog')) {
    const loaded = require('../src/agent-catalog.js').loadCatalog();
    if (!loaded.ok) { console.error(loaded.error); return 2; }
    for (const a of loaded.catalog.agents) results.push([a.id, scanAgent({ body: loaded.body(a), tools: a.tools.declared })]);
  } else {
    for (const f of argv.filter((a) => !a.startsWith('--'))) results.push([f, scanFile(f)]);
  }
  let high = 0;
  for (const [name, r] of results) {
    if (r.level === 'high') high++;
    const flags = r.flags.filter((f) => !onlyHigh || f.level === 'high');
    if (!flags.length) continue;
    console.log(`${name}: ${r.level}`);
    for (const f of flags) console.log(`  ${f.level.padEnd(6)} ${f.rule.padEnd(20)} line ${String(f.line).padStart(4)}  ${f.excerpt}`);
  }
  console.log(`${results.length} scanned, ${high} high risk`);
  return high ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { scanFile, main };
