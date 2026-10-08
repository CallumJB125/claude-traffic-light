'use strict';

// A session's project folder may sit under ~/Desktop, ~/Documents, ~/Downloads
// or iCloud Drive, where macOS holds any read until its privacy prompt is
// answered: minutes, or for good. On the main thread a synchronous read there
// freezes the whole app (see src/agents-sync.js), and so can spawning a child
// with that folder as its cwd, because the spawn waits for the child's chdir.
// So project folders are reached only from a child process told where to go
// (git -C) or through async fs, and each such call gets a deadline: a child
// parked in that wait may outlive its timeout signal, and then execFile's
// callback never comes and whatever awaits it stalls with it.

const fsp = require('node:fs/promises');
const path = require('node:path');

const GRACE_MS = 2000;
const STAT_MS = 2000;

// start(done) begins the work and may return its child process; done(value)
// settles it. At ms the child is killed and the result is fallback.
function withDeadline(start, ms, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { child?.kill?.('SIGKILL'); } catch { /* already gone */ } finish(fallback); }, ms);
    try { child = start(finish) ?? null; } catch { finish(fallback); }
  });
}

async function isDirWithin(p, ms = STAT_MS, stat = fsp.stat) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  return withDeadline((done) => { stat(p).then((st) => done(st.isDirectory()), () => done(false)); }, ms, false);
}

module.exports = { withDeadline, isDirWithin, GRACE_MS, STAT_MS };
