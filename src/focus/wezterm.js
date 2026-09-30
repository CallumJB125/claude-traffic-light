// WezTerm: `wezterm cli activate-pane --pane-id <WEZTERM_PANE>`. Run from
// outside WezTerm, `wezterm cli` finds the running GUI instance itself. It
// doesn't raise the app, hence the `open -a`.
const os = require('os');
const Ids = require('./ids.js');

const BINS = [
  '/Applications/WezTerm.app/Contents/MacOS/wezterm',
  `${os.homedir()}/Applications/WezTerm.app/Contents/MacOS/wezterm`,
  '/opt/homebrew/bin/wezterm',
  '/usr/local/bin/wezterm',
  '/usr/bin/wezterm',
];

module.exports = {
  id: 'wezterm',
  app: 'WezTerm',
  needs: null,
  BINS,
  canHandle: (s, ctx) => Ids.hostIs(s, 'WezTerm', 'WezTerm') && !!(Ids.weztermPane(s) && ctx.which(BINS)),
  async focus(s, { exec, which, platform }) {
    const r = await exec(which(BINS), ['cli', 'activate-pane', '--pane-id', Ids.weztermPane(s)]);
    if (!r.ok) return { ok: false, reason: (r.stderr || 'wezterm cli failed').trim().slice(0, 120) };
    if (platform === 'darwin') await exec('/usr/bin/open', ['-a', 'WezTerm']);
    return { ok: true, exact: true };
  },
};
