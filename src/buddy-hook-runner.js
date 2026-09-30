// `<exe> --buddy-hook <script> args…`: runs one of Buddy's hook scripts in the
// app's own process, as if `node <script> args…` had run it. Windows argv
// hook commands (Codex notify) use it instead of buddy-hook.cmd, because a
// .cmd sends its arguments through cmd.exe's parser again and that mangles
// JSON (BatBadBut). main.js calls this before anything else starts, and the
// process always exits here: no window, no lock, no data folder.
//
// Only the hook scripts can be run this way, so the flag is not a general
// "run any file" door into the app.
const path = require('path');

const ALLOWED = new Set(['emit.js', 'set-status.js']);

// argv: process.argv of the app. → { script, args } or null.
function parse(argv) {
  const at = argv.indexOf('--buddy-hook');
  if (at < 0 || !argv[at + 1]) return null;
  const script = path.resolve(argv[at + 1]);
  if (!ALLOWED.has(path.basename(script)) || path.basename(path.dirname(script)) !== 'hooks') return null;
  return { script, args: argv.slice(at + 2) };
}

function run(argv, { exit = (code) => process.exit(code) } = {}) {
  const job = parse(argv);
  if (!job) { exit(0); return; }
  process.argv = [process.argv[0], job.script, ...job.args];
  try { require(job.script); } catch { /* a hook never breaks the agent that ran it */ }
  // emit.js exits by itself; one that returns without exiting must not leave
  // an Electron process running.
  exit(process.exitCode || 0);
}

module.exports = { parse, run, ALLOWED };
