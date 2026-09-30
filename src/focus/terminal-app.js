// Terminal.app: the tab whose tty is the session's.
const Ids = require('./ids.js');
const { runScript } = require('./applescript.js');

const SCRIPT = `on run argv
  set wantTty to item 1 of argv
  if application "Terminal" is not running then return "not-running"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is wantTty then
          set selected tab of w to t
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "no match"
end run`;

const isTerminal = (s) => Ids.hostIs(s, 'Terminal', 'Apple_Terminal');

module.exports = {
  id: 'terminal-app',
  app: 'Terminal',
  needs: { permission: 'automation', app: 'Terminal', reason: 'so a click can switch to the exact Terminal tab your session is running in' },
  canHandle: (s, ctx) => ctx.platform === 'darwin' && isTerminal(s) && !!Ids.tty(s),
  focus: (s, { exec }) => runScript(exec, SCRIPT, [Ids.tty(s)]),
  SCRIPT,
};
