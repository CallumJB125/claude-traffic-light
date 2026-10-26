import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const rootPkg = JSON.parse(read('package.json'));
const boardPkg = JSON.parse(read('board', 'package.json'));

test('smol-toml is an exact pin in root dependencies and in board', () => {
  const v = rootPkg.dependencies['smol-toml'];
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(rootPkg.devDependencies?.['smol-toml'], undefined);
  assert.equal(boardPkg.dependencies['smol-toml'], v);
  assert.equal(JSON.parse(read('node_modules', 'smol-toml', 'package.json')).version, v);
});

test('user-provider.cjs loads by require and by import with named exports', async () => {
  const cjs = require('../user-provider.cjs');
  assert.equal(typeof cjs.claudeProvider, 'function');
  const esm = await import('../user-provider.cjs');
  assert.equal(esm.claudeProvider, cjs.claudeProvider);
  assert.equal(esm.codexProvider, cjs.codexProvider);
  assert.ok(esm.CLAUDE_ROUTING_KEYS.includes('ANTHROPIC_BASE_URL'));
});

test('secret-patterns.mjs loads by require under plain node', () => {
  assert.equal(typeof require('../secret-patterns.mjs').findSecrets, 'function');
});

test('the third-party notice for smol-toml is generated and current', () => {
  const { bundledNpmSection, loadBundledNpm } = require('../../../scripts/build-agent-catalog.js');
  const list = loadBundledNpm(ROOT);
  const entry = list.find((p) => p.name === 'smol-toml');
  assert.equal(entry.version, rootPkg.dependencies['smol-toml']);
  for (const lock of ['package-lock.json', 'board/package-lock.json']) assert.equal(JSON.parse(read(...lock.split('/')))['packages']['node_modules/smol-toml'].version, entry.version, lock);
  const section = bundledNpmSection(list);
  assert.equal(entry.licenseText, read('node_modules', 'smol-toml', 'LICENSE'), 'shipped licence text must equal the package LICENSE');
  assert.ok(entry.licenseText.includes(entry.copyright));
  assert.ok(section.includes('smol-toml') && section.includes(entry.version) && section.includes(entry.license));
  assert.ok(read('THIRD_PARTY_NOTICES.md').includes(section.trimEnd()), 'THIRD_PARTY_NOTICES.md is stale: run node scripts/build-agent-catalog.js');
});

test('nothing in board/shared or src imports stringify from smol-toml', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test') walk(p); } else if (/\.(c|m)?js$/.test(e.name)) files.push(p); } };
  walk(path.join(ROOT, 'board', 'shared'));
  walk(path.join(ROOT, 'src'));
  assert.ok(files.length > 20);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes('smol-toml')) continue;
    assert.ok(!/stringify[^\n]*smol-toml|smol-toml[^\n]*\.stringify|require\(['"]smol-toml['"]\)\.stringify/.test(text), f);
  }
});
