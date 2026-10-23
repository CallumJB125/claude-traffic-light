// Ghostty Dock (src/ghostty-dock.js): its CLI focuses a tab by the exact
// Claude session id, so several tabs in one folder are no guess, and it needs
// no Automation permission. When the CLI isn't usable, or fails (a session
// Dock's hook never saw, such as Codex, or no jq), the folder-unique
// AppleScript runs next, addressed by bundle id so it can never reach stock
// Ghostty. Both are skipped when Preferences turn Ghostty Dock off
// (ctx.ghosttyDock is then null).
const Ids = require('./ids.js');
const { runScript } = require('./applescript.js');
const GhosttyDock = require('../ghostty-dock.js');

const SCRIPT = `on run argv
  set wantDir to item 1 of argv
  if application id "${GhosttyDock.BUNDLE_ID}" is not running then return "not-running"
  tell application id "${GhosttyDock.BUNDLE_ID}"
    set hits to every terminal whose working directory is wantDir
    if (count of hits) is not 1 then return "matches: " & (count of hits)
    focus (item 1 of hits)
    activate
  end tell
  return "ok"
end run`;

const isDock = (s, ctx) => ctx.platform === 'darwin' && Ids.hostIs(s, GhosttyDock.APP) && !!ctx.ghosttyDock;

const cli = {
  id: 'ghostty-dock',
  app: GhosttyDock.APP,
  canHandle: (s, ctx) => isDock(s, ctx) && GhosttyDock.validSessionId(s.sessionId) && !!ctx.ghosttyDock.cli,
  focus: async (s, { exec, ghosttyDock }) => {
    const r = await GhosttyDock.run('focus', [s.sessionId], { dock: ghosttyDock, exec });
    return r.ok ? { ok: true, exact: true } : { ok: false, reason: r.reason };
  },
};

const script = {
  id: 'ghostty-dock-script',
  app: GhosttyDock.APP,
  needs: { permission: 'automation', app: GhosttyDock.APP, reason: 'so a click can switch to the Ghostty Dock tab your session is running in' },
  canHandle: (s, ctx) => isDock(s, ctx) && !!ctx.ghosttyDock.installed && !!Ids.launchCwd(s),
  // The only Dock tab in that folder, not one picked by session id: so not `exact`.
  focus: async (s, { exec }) => {
    const r = await runScript(exec, SCRIPT, [Ids.launchCwd(s)]);
    return r.ok ? { ok: true, exact: false, byFolder: true } : r;
  },
  SCRIPT,
};

module.exports = { cli, script, SCRIPT };
