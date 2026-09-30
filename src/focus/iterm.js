// iTerm2: select the session by its id (the UUID in ITERM_SESSION_ID), or by
// tty when all we have is the tty (a tmux client's outer tab).
const Ids = require('./ids.js');
const { runScript } = require('./applescript.js');

const SCRIPT = `on run argv
  set wantId to item 1 of argv
  set wantTty to item 2 of argv
  if application "iTerm2" is not running then return "not-running"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (wantId is not "" and id of s is wantId) or (wantTty is not "" and tty of s is wantTty) then
            select w
            select t
            select s
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "no match"
end run`;

const isITerm = (s) => Ids.hostIs(s, 'iTerm2', 'iTerm.app');

module.exports = {
  id: 'iterm',
  app: 'iTerm2',
  needs: { permission: 'automation', app: 'iTerm2', reason: 'so a click can switch to the exact iTerm2 tab your session is running in' },
  canHandle: (s, ctx) => ctx.platform === 'darwin' && (isITerm(s) || (!!ctx.outer && !s.hostApp)) && !!(Ids.itermUuid(s) || Ids.tty(s)),
  focus: (s, { exec }) => runScript(exec, SCRIPT, [Ids.itermUuid(s) || '', Ids.tty(s) || '']),
  SCRIPT,
};
