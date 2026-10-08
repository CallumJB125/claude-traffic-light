'use strict';
// `plexiform-run <tool> [args]`: a tiny shell wrapper for tools with no hooks
// of their own. It launches the tool, tells Plexiform when it started and how
// it ended (hooks/emit.js --adapter generic, adapters/generic.js), and passes
// the tool's exit code through. That is all it can see: no prompts, no tool
// names, no answering.
const nodeFs = require('node:fs');
const path = require('node:path');
const Runtime = require('../adapters/runtime.js');

const MARKER = '# plexiform-run v1 (written by Plexiform; safe to delete)';
const NAME = 'plexiform-run';

// The tool a command line launches, as the id its sessions carry.
function keyOf(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return path.basename(first).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
}

const runnerFile = (home) => path.join(home, '.local', 'bin', NAME);

function scriptText(runtime) {
  const emit = Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'generic']);
  if (/[`$\\\r\n]/.test(emit.replace(/^ELECTRON_RUN_AS_NODE=1 /, ''))) throw new Error('Plexiform\'s own path has characters a shell script cannot hold safely.');
  return `#!/bin/sh
${MARKER}
# Usage: plexiform-run <tool> [args...]
[ "$#" -ge 1 ] || { echo "usage: plexiform-run <tool> [args...]" >&2; exit 64; }
KEY=$(printf '%s' "$(basename "$1")" | tr -c 'A-Za-z0-9_.-' '_' | cut -c1-40)
SID="$KEY-$$-$(date +%s)"
CWD=$(pwd | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
report() {
  printf '{"tool":"%s","session":"%s","cwd":"%s","pid":%s,"code":%s}' "$KEY" "$SID" "$CWD" "$$" "\${2:-0}" | ${emit} "$1" >/dev/null 2>&1 || true
}
report start 0
trap ':' INT
"$@"
CODE=$?
report exit "$CODE"
exit "$CODE"
`;
}

function onPath(home, pathDirs) {
  const dir = path.join(home, '.local', 'bin');
  return (pathDirs || String(process.env.PATH || '').split(path.delimiter)).includes(dir);
}

function status({ home, runtime, fs = nodeFs, platform = process.platform, pathDirs } = {}) {
  const file = runnerFile(home);
  const display = onPath(home, pathDirs) ? NAME : `~/.local/bin/${NAME}`;
  if (platform === 'win32') return { ok: false, file, display, problem: 'plexiform-run needs macOS or Linux (it is a shell script).' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text !== scriptText(runtime)) return { ok: false, file, display, problem: 'plexiform-run is from an older or different copy of Plexiform. Fix reinstalls it.' };
    if (!(fs.statSync(file).mode & 0o100)) return { ok: false, file, display, problem: 'plexiform-run is not executable. Fix reinstalls it.' };
    return { ok: true, file, display };
  } catch (e) {
    return { ok: false, file, display, problem: e.code === 'ENOENT' ? 'plexiform-run is not installed. Fix installs it.' : `plexiform-run could not be read: ${e.message}` };
  }
}

function installRunner({ home, runtime, fs = nodeFs, platform = process.platform, pathDirs } = {}) {
  const file = runnerFile(home);
  if (platform === 'win32') return { ok: false, error: 'plexiform-run needs macOS or Linux (it is a shell script).' };
  try {
    let text;
    try { text = scriptText(runtime); } catch (e) { return { ok: false, error: e.message }; }
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (cur !== null && !cur.includes(MARKER)) return { ok: false, error: `${file} already exists and was not made by Plexiform, so it was left alone.` };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (cur !== text) Runtime.writeTextAtomic(file, text, fs, undefined, { newMode: 0o755 });
    fs.chmodSync(file, 0o755);
    const st = status({ home, runtime, fs, platform, pathDirs });
    return st.ok ? { ok: true, file, display: st.display, onPath: onPath(home, pathDirs) } : { ok: false, error: st.problem };
  } catch (e) { return { ok: false, error: e.code === 'EACCES' ? `Plexiform cannot write ${file} (permission denied).` : e.message }; }
}

module.exports = { keyOf, scriptText, status, installRunner, runnerFile, MARKER };
