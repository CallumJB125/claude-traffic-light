'use strict';

// "Other programs keeping this Mac awake": the power assertions macOS reports.
// macOS only; elsewhere nothing is spawned. The runner is final; parse() is a
// parser. It works with or without Burst.

const { execFile } = require('node:child_process');

function runPmset() {
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'assertions'], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout))); // privacy-flow: power-assertions
  });
}

// `pmset -g assertions` text -> [{ pid, process, type, name, for? }] for PreventSystemSleep holders.
// Only the "Listed by owning process" lines count. PreventUserIdleSystemSleep (what Claude Code's
// caffeinate -i holds) does not keep a closed lid awake, so it is ignored; so is powerd, the system itself.
const LINE = /^\s*pid (\d+)\((.*?)\):\s*\[0x[0-9a-f]+\]\s+[\d:]+\s+(\w+)\s+named:\s*"(.*)"/;
function parse(text) {
  const out = [];
  let listed = false;
  let last = null;
  for (const line of String(text || '').split('\n')) {
    if (/^Listed by owning process/i.test(line)) { listed = true; continue; }
    if (!listed) continue;
    const m = LINE.exec(line);
    if (m) { last = m[3] === 'PreventSystemSleep' && m[2] !== 'powerd' ? { pid: Number(m[1]), process: m[2], type: m[3], name: m[4] } : null; if (last) out.push(last); continue; }
    // caffeinate names the program it acts for on the next line; keep only that program's file name.
    const f = last && /^\s*Details: .*on behalf of '(.*)' \(pid \d+\)/.exec(line);
    if (f) last.for = f[1].split('/').pop();
  }
  return out;
}

async function listAssertions({ platform = process.platform, run = runPmset } = {}) {
  if (platform !== 'darwin') return [];
  return parse(await run());
}

module.exports = { listAssertions, parse, runPmset };
