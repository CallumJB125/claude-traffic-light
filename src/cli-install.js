'use strict';

// Settings > Advanced > "Install command line tool": links ~/.local/bin/plexiform
// to this copy's bin/plexiform launcher. Only from that click, and only after
// the native confirmation names both paths. Something at that path that is not
// a link to a plexiform launcher is never replaced.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME = 'plexiform';

const linkPath = (home) => path.join(home, '.local', 'bin', NAME);

function target({ packaged, resourcesPath, appDir }) {
  return packaged ? path.join(resourcesPath, 'bin', NAME) : path.join(appDir, 'bin', NAME);
}

function status({ home, target: to }) {
  const link = linkPath(home);
  let exists = false, current = null;
  try {
    exists = fs.lstatSync(link).isSymbolicLink() ? 'link' : 'other';
    if (exists === 'link') current = fs.readlinkSync(link);
  } catch { exists = false; }
  const ours = !!current && path.basename(current) === NAME && path.basename(path.dirname(current)) === 'bin';
  return {
    link,
    target: to,
    installed: current === to,
    targetExists: fs.existsSync(to),
    current,
    blocked: exists === 'other' || (exists === 'link' && !ours),
  };
}

function consentDialog(s) {
  return {
    type: 'question',
    buttons: ['Cancel', 'Install'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Install the plexiform command?',
    detail: [
      'This creates one symbolic link:',
      s.link,
      `→ ${s.target}`,
      s.current ? `It replaces the existing link to ${s.current}.` : '',
      `Nothing else is changed. To remove it, delete ${s.link}.`,
    ].filter(Boolean).join('\n'),
  };
}

function install({ home, target: to }) {
  const s = status({ home, target: to });
  if (s.installed) return { ok: true, already: true, link: s.link, target: to };
  if (!s.targetExists) return { ok: false, error: `This copy of Plexiform has no command line tool at ${to}.` };
  if (s.blocked) return { ok: false, error: `Something else is already at ${s.link}. Plexiform will not replace it.` };
  fs.mkdirSync(path.dirname(s.link), { recursive: true });
  const tmp = `${s.link}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  fs.symlinkSync(to, tmp);
  try { fs.renameSync(tmp, s.link); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  return { ok: true, link: s.link, target: to };
}

async function installWithConsent({ home, target: to, confirm }) {
  const s = status({ home, target: to });
  if (s.installed) return { ok: true, already: true, link: s.link, target: to };
  if (!s.targetExists || s.blocked) return install({ home, target: to });
  if (!(await confirm(consentDialog(s)))) return { ok: false, cancelled: true };
  try { return install({ home, target: to }); } catch (err) { return { ok: false, error: `Could not create the link: ${err.message}` }; }
}

function register({ utilityHandle, allowed, dialog, BrowserWindow, home, packaged, resourcesPath, appDir }) {
  const to = target({ packaged, resourcesPath, appDir });
  utilityHandle('cli-install-status', allowed, () => status({ home, target: to }));
  utilityHandle('cli-install', allowed, (e) => installWithConsent({
    home,
    target: to,
    confirm: async (opts) => (await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) || undefined, opts)).response === 1,
  }));
}

module.exports = { linkPath, target, status, consentDialog, install, installWithConsent, register };
