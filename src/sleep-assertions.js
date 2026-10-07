'use strict';

// "Other programs keeping this Mac awake": the power assertions macOS reports.
// macOS only; elsewhere nothing is spawned. The runner is final; parse() is a
// WP0 stub that WP5 fills in.

const { execFile } = require('node:child_process');

function runPmset() {
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'assertions'], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout))); // privacy-flow: power-assertions
  });
}

// `pmset -g assertions` text -> [{ pid, process, type, name }] for PreventSystemSleep holders.
function parse(_text) { return []; }

async function listAssertions({ platform = process.platform, run = runPmset } = {}) {
  if (platform !== 'darwin') return [];
  return parse(await run());
}

module.exports = { listAssertions, parse, runPmset };
