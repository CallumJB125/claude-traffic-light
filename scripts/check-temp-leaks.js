#!/usr/bin/env node
'use strict';
// Regression guard for test temp-dir leaks. Runs a representative subset of
// the board hub and root suites with TMPDIR pointed at a private directory, so
// a concurrent run elsewhere cannot cause false results, then fails if any
// prefixed entry survived or the directory grew past the byte budget.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PREFIXES = ['board-hub-', 'board-local-', 'board-reboot-', 'board-restore-', 'board-journal-', 'ctl-', 'updater-', 'buddy-flow-', 'buddy-dev-', 'backups-test-', 'cb-history-'];
const MAX_BYTES = 50 * 1024 * 1024;
const SUITES = [
  { cwd: path.join(ROOT, 'board'), files: ['hub/test/quotas.test.js', 'hub/test/local-auth.test.js', 'hub/test/exit-g-reboot.test.js', 'hub/test/http.test.js'] },
  { cwd: ROOT, files: ['test/account-flow.test.js', 'test/backups.test.js', 'test/updater-service.test.js', 'test/answer-file.test.js'] },
];

function bytes(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.blocks * 512;
  let total = st.blocks * 512;
  for (const name of fs.readdirSync(p)) total += bytes(path.join(p, name));
  return total;
}

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'temp-leak-check-')));
let failed = false;
try {
  for (const suite of SUITES) {
    const r = spawnSync(process.execPath, ['--test', ...suite.files], { cwd: suite.cwd, env: { ...process.env, TMPDIR: temp }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const summary = (r.stdout || '').split('\n').filter((l) => /^# (pass|fail|skipped) /.test(l)).join(' ');
    console.log(`${path.relative(ROOT, suite.cwd) || '.'}: exit ${r.status} ${summary}`);
  }
  const names = fs.readdirSync(temp);
  const leaked = names.filter((n) => PREFIXES.some((p) => n.startsWith(p)));
  const size = bytes(temp);
  const byPrefix = {};
  for (const n of leaked) { const p = PREFIXES.find((x) => n.startsWith(x)); byPrefix[p] = (byPrefix[p] || 0) + 1; }
  console.log(`entries=${names.length} leaked=${leaked.length} bytes=${size} ${JSON.stringify(byPrefix)}`);
  const other = names.filter((n) => !leaked.includes(n));
  if (other.length) console.log(`other entries (not failing): ${other.slice(0, 20).join(', ')}`);
  if (leaked.length) { console.error(`FAIL: ${leaked.length} prefixed temp entries leaked`); failed = true; }
  if (size > MAX_BYTES) { console.error(`FAIL: temp dir grew by ${size} bytes (> ${MAX_BYTES})`); failed = true; }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('OK: no temp leaks');
