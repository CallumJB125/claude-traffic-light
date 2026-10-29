'use strict';
// Promote signs docs/release-notes.md from main into release.json, and the app
// refuses a manifest whose notes exceed MAX_NOTES ("bad notes"). Catch that here,
// not at promote time (ledger 54: beta.108's first promote failed on 26,489 characters).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('release notes fit the update manifest limit', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'updater', 'verify.js'), 'utf8');
  const m = src.match(/const MAX_NOTES = (\d+);/);
  assert.ok(m, 'MAX_NOTES not found in src/updater/verify.js');
  const notes = fs.readFileSync(path.join(root, 'docs', 'release-notes.md'), 'utf8');
  assert.ok(notes.length <= Number(m[1]), `docs/release-notes.md is ${notes.length} characters; the manifest allows ${m[1]}. Move older betas out (they stay in their GitHub releases).`);
});
