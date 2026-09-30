// kitty: `kitten @ --to <KITTY_LISTEN_ON> focus-window --match id:<KITTY_WINDOW_ID>`.
// Needs `allow_remote_control` and `listen_on` in kitty.conf; without them
// there is no KITTY_LISTEN_ON and this adapter never runs. focus-window
// switches kitty's tab but doesn't raise the app, hence the `open -a`.
const os = require('os');
const Ids = require('./ids.js');

const BINS = [
  '/Applications/kitty.app/Contents/MacOS/kitten',
  `${os.homedir()}/Applications/kitty.app/Contents/MacOS/kitten`,
  '/opt/homebrew/bin/kitten',
  '/usr/local/bin/kitten',
  '/usr/bin/kitten',
  `${os.homedir()}/.nix-profile/bin/kitten`,
  '/run/current-system/sw/bin/kitten',
];

module.exports = {
  id: 'kitty',
  app: 'kitty',
  needs: null,
  BINS,
  canHandle: (s, ctx) => (!s.hostApp || s.hostApp === 'kitty') && !!(Ids.kittyWindow(s) && Ids.kittyListen(s) && ctx.which(BINS)),
  async focus(s, { exec, which, platform }) {
    const r = await exec(which(BINS), ['@', '--to', Ids.kittyListen(s), 'focus-window', '--match', `id:${Ids.kittyWindow(s)}`]);
    if (!r.ok) return { ok: false, reason: (r.stderr || 'kitten @ failed').trim().slice(0, 120) };
    if (platform === 'darwin') await exec('/usr/bin/open', ['-a', 'kitty']);
    return { ok: true, exact: true };
  },
};
