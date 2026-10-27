'use strict';
// PR 0s: the terminal modules' import boundary (plan-agent-terminal §R2.7.5,
// condition 12; plan-pr0s §8 S4). A static scan of every repo .js/.cjs/.mjs
// outside node_modules and the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// Who may require the guarded modules. Pinned: widening it is a review decision.
const ALLOWED = ['main.js', 'src/tasks-terminal.js', 'src/tasks-service.js', 'src/focus/index.js'];
const GUARDED = [/^src\/keeper-protocol\//, /^src\/terminal-presence[^/]*$/, /^src\/focus\/plexiform-terminal\.js$/];
// Files that exist from PR 0s, so a rename can't leave the scan guarding nothing.
const EXISTING = ['src/keeper-protocol/index.js', 'src/keeper-protocol/takeover-shape.js', 'src/keeper-protocol/schema.json', 'src/keeper-protocol/takeover-shape.json', 'src/terminal-presence.js'];
// T3 adds this one; guarded before it exists.
const FORWARD = ['src/focus/plexiform-terminal.js'];
const DENIED = [/^board\//, /^src\/sync\//, /^src\/team-/, /^mcp-server\.js$/, /^src\/signal-server\.js$/, /^src\/agent-bus-/, /^src\/remote-/, /^src\/compose-/, /^src\/session-actions/, /^src\/crash-report-/];

const guarded = (f) => GUARDED.some((re) => re.test(f));
const files = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter((f) => f && fs.existsSync(path.join(ROOT, f)));

// Every relative require/import/import() in a source file, resolved to a repo path.
function edges() {
  const all = files();
  const known = new Set(all);
  const resolve = (from, spec) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, `${base}/index.js`].find((c) => known.has(c)) ?? base;
  };
  const out = [];
  for (const f of all) {
    if (!/\.(c|m)?js$/.test(f) || /(^|\/)(node_modules|test|tests|test-visual)\//.test(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/(?:require\s*\(\s*|import\s*\(\s*|\bfrom\s+|^\s*import\s+)(['"`])(\.{1,2}\/[^'"`]+)\1/gm)) out.push({ from: f, to: resolve(f, m[2]) });
  }
  return { all, out };
}

test('the guarded terminal modules exist and are reached only from the allowed importers', () => {
  const { all, out } = edges();
  for (const f of EXISTING) assert.ok(all.includes(f) && guarded(f), `${f} is found and guarded`);
  for (const f of FORWARD) assert.ok(guarded(f), `${f} is guarded before it exists`);
  assert.ok(out.some((e) => e.from === 'main.js' && e.to === 'src/tasks-terminal.js'), 'the scan resolves a known require');
  assert.ok(out.some((e) => e.from === 'src/keeper-protocol/takeover-shape.js' && e.to === 'src/keeper-protocol/takeover-shape.json'), 'the scan sees JSON requires');
  for (const e of out.filter((x) => guarded(x.to) && !guarded(x.from))) {
    assert.ok(ALLOWED.includes(e.from), `${e.from} requires ${e.to}`);
    assert.ok(!DENIED.some((re) => re.test(e.from)), `${e.from} requires ${e.to}`);
  }
  assert.deepEqual(ALLOWED, ['main.js', 'src/tasks-terminal.js', 'src/tasks-service.js', 'src/focus/index.js']);
  assert.ok(!ALLOWED.some((f) => DENIED.some((re) => re.test(f))));
});

test('the guarded modules require nothing from the app beyond their own folder', () => {
  const { out } = edges();
  for (const e of out.filter((x) => guarded(x.from))) assert.ok(guarded(e.to), `${e.from} requires ${e.to}`);
});

test('the export lists are pinned (adding one is a review decision)', () => {
  const names = (m) => Object.keys(require(path.join(ROOT, m))).sort();
  assert.deepEqual(names('src/keeper-protocol/index.js'), ['ERROR_CODES', 'FRAME', 'LIMITS', 'OPS', 'PROTOCOL', 'ROLES', 'SCHEMA_PATH', 'SPAWN_KINDS']);
  assert.deepEqual(names('src/keeper-protocol/takeover-shape.js'), ['SHAPE', 'checkTakeover']);
  assert.deepEqual(names('src/terminal-presence.js'), ['DEFAULTS', 'OPEN_IN', 'PLEXIFORM', 'REASONS', 'RESULT_CODES', 'SPAWN_REFUSED_REASONS', 'STATES', 'USUAL', 'detect', 'normalizeTerminalConfig', 'resolveOpenIn', 'reveal']);
});
