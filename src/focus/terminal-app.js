// Terminal.app: the tab whose tty is the session's. QoL1 (verified on the real app): `activate`
// comes first, since a window order set while Terminal is hidden is lost when it un-hides, and a
// minimised window is restored, since `set index` alone leaves it in the Dock. `w` is first pinned by id:
// the loop's references are by position, and activating reorders the windows under them (seen on the real app),
// so the tab is found again in the pinned window.
const Ids = require('./ids.js');
const { runScript } = require('./applescript.js');

const SCRIPT = `on run argv
  set wantTty to item 1 of argv
  if application "Terminal" is not running then return "not-running"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is wantTty then
          set w to window id (id of w)
          activate
          if miniaturized of w then set miniaturized of w to false
          set selected tab of w to (first tab of w whose tty is wantTty)
          set index of w to 1
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
  canHandle: (s, ctx) => ctx.platform === 'darwin' && (isTerminal(s) || (!!ctx.outer && !s.hostApp)) && !!Ids.tty(s),
  focus: (s, { exec }) => runScript(exec, SCRIPT, [Ids.tty(s)]),
  SCRIPT,
};
