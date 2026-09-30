// Ghostty (1.3+ AppleScript): terminals expose id, name and working
// directory, but no tty, and its child shells get no per-terminal id — so the
// only handle is the session's folder. Focus only when exactly one terminal
// is in that folder; two tabs in the same repo would be a guess.
const Ids = require('./ids.js');
const { runScript } = require('./applescript.js');

const SCRIPT = `on run argv
  set wantDir to item 1 of argv
  if application "Ghostty" is not running then return "not-running"
  tell application "Ghostty"
    set hits to every terminal whose working directory is wantDir
    if (count of hits) is not 1 then return "matches: " & (count of hits)
    focus (item 1 of hits)
    activate
  end tell
  return "ok"
end run`;

const isGhostty = (s) => Ids.hostIs(s, 'Ghostty', 'ghostty');

module.exports = {
  id: 'ghostty',
  app: 'Ghostty',
  needs: { permission: 'automation', app: 'Ghostty', reason: 'so a click can switch to the exact Ghostty tab your session is running in' },
  canHandle: (s, ctx) => ctx.platform === 'darwin' && isGhostty(s) && !!Ids.cwd(s),
  focus: (s, { exec }) => runScript(exec, SCRIPT, [Ids.cwd(s)]),
  SCRIPT,
};
