'use strict';
// plan-ghostty-dock §5.1: Plexiform may only ask Ghostty Dock to focus, list,
// notify or open. It must never type into a terminal, press keys in it, read
// its screen or wait on it, and no bus envelope, MCP tool, run, hub message or
// signal-server route may reach the Dock module at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DOCK_MODULES = ['src/ghostty-dock.js', 'src/focus/ghostty-dock.js'];
const FORBIDDEN_OPS = ['send', 'keys', 'read', 'wait'];
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('the Dock modules hold no forbidden op as a string literal', () => {
  for (const f of DOCK_MODULES) {
    const src = code(read(f));
    for (const op of FORBIDDEN_OPS) {
      assert.doesNotMatch(src, new RegExp(`['"\`]${op}['"\`]`), `${f} names the ${op} op`);
    }
  }
  assert.match(read('src/ghostty-dock.js'), /const OPS = Object\.freeze\(\['focus', 'list', 'notify', 'open'\]\);/);
});

test('every call into the Dock module anywhere in the app names an allowed op', () => {
  const allowed = new Set(['focus', 'list', 'notify', 'open']);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test', 'test-visual', 'dist', 'out', 'site'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  let seen = 0;
  for (const f of files) {
    const src = code(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\b(?:GhosttyDock\.)?run\(\s*(['"`])([^'"`]*)\1\s*,\s*\[/g)) {
      if (!/ghostty-dock|GhosttyDock/.test(src)) continue;
      seen += 1;
      assert.ok(allowed.has(m[2]), `${path.relative(ROOT, f)} calls Ghostty Dock op "${m[2]}"`);
    }
    // No other way to reach the CLI: its path is only built in src/ghostty-dock.js.
    if (path.relative(ROOT, f) !== 'src/ghostty-dock.js') assert.doesNotMatch(src, /\.local['"`/,\s]+['"`]?bin['"`/,\s]+['"`]?ghostty-dock/, path.relative(ROOT, f));
  }
  assert.ok(seen >= 2, 'the focus adapter and the task launcher both call run');
});

// Relative requires/imports of a file, resolved.
function deps(file) {
  const src = code(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const m of src.matchAll(/(?:require\(\s*|from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), m[1]);
    const hit = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (hit) out.push(hit);
  }
  return out;
}
function reaches(entry, targets) {
  const seen = new Set();
  const stack = [path.join(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (targets.has(f)) return path.relative(ROOT, f);
    stack.push(...deps(f));
  }
  return null;
}

test('no bus, MCP, board, run or signal-server code can load the Dock module, directly or through another file', () => {
  const targets = new Set(DOCK_MODULES.map((f) => path.join(ROOT, f)));
  const entries = ['mcp-server.js', 'src/signal-server.js', 'src/agent-bus-main.js'];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel); else if (/\.(c|m)?js$/.test(e.name)) entries.push(rel);
    }
  };
  walk('board');
  assert.ok(entries.some((e) => e.startsWith(path.join('board', 'mcp'))), 'board/mcp is covered');
  for (const e of entries) assert.equal(reaches(e, targets), null, `${e} reaches the Ghostty Dock module`);
});

test('the Health checks take the Dock row as data and never load the module (mcp-server uses them)', () => {
  assert.doesNotMatch(code(read('src/health.js')), /require\([^)]*ghostty-dock/);
});
