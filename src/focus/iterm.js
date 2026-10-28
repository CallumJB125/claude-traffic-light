// iTerm2: select the session by its id (the UUID in ITERM_SESSION_ID), or by
// tty when all we have is the tty (a tmux client's outer tab). QoL1: activate first and restore a
// minimised window, as for Terminal.app (src/focus/terminal-app.js), with the window and session pinned by
// id first, since activating reorders the windows the loop refers to by position.
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
            set wid to id of w
            set sid to id of s
            activate
            set w to window id wid
            if miniaturized of w then set miniaturized of w to false
            select w
            repeat with t2 in tabs of w
              repeat with s2 in sessions of t2
                if id of s2 is sid then
                  select t2
                  select s2
                  return "ok"
                end if
              end repeat
            end repeat
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
