// VS Code and its forks: `open -a <app> <folder>` brings forward the window
// that has the folder the session started in. Without that folder it is a
// bare `open -a <app>`: a guessed path could open a new window or swap the
// folder in the current one. There is no CLI or URI that picks an integrated
// terminal (by pid or otherwise) without an extension, so this stops at the
// window and says so.
const Ids = require('./ids.js');

const IDES = ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Code - OSS', 'Cursor', 'Windsurf'];

function ideOf(s) {
  if (IDES.includes(s.hostApp)) return s.hostApp;
  return Ids.envOf(s).TERM_PROGRAM === 'vscode' && !s.hostApp ? 'Visual Studio Code' : null;
}

module.exports = {
  id: 'vscode',
  app: 'Visual Studio Code',
  needs: null,
  IDES,
  canHandle: (s, ctx) => ctx.platform === 'darwin' && !!ideOf(s),
  async focus(s, { exec, isDir }) {
    const app = ideOf(s);
    const dir = Ids.launchCwd(s);
    const r = await exec('/usr/bin/open', dir && isDir(dir) ? ['-a', app, dir] : ['-a', app]);
    if (!r.ok) return { ok: false, reason: (r.stderr || 'open failed').trim().slice(0, 120) };
    return { ok: true, exact: false, app, reason: 'window only: no way to pick the terminal without an extension' };
  },
};
