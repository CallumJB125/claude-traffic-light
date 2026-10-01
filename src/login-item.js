// Open at Login. macOS and Windows have it built in (setLoginItemSettings);
// on Linux that call does nothing, so an XDG autostart entry is written
// instead: ~/.config/autostart/plexiform.desktop. An AppImage's binary lives
// in a mount that changes every launch, so the entry runs $APPIMAGE.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE_NAME = 'plexiform.desktop';

// Desktop Entry spec: a quoted Exec argument escapes " ` $ \, and % is %%.
const execQuote = (p) => `"${String(p).replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`;

function desktopEntry({ exec, name }) {
  return `[Desktop Entry]\nType=Application\nName=${name}\nExec=${execQuote(exec)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}

function create({ app, platform = process.platform, env = process.env, home = os.homedir(), execPath = process.execPath, name = 'Plexiform', fsImpl = fs, log = console.warn }) {
  if (platform !== 'linux') {
    return {
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (on) => app.setLoginItemSettings({ openAtLogin: on }),
    };
  }
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', FILE_NAME);
  return {
    file,
    get: () => fsImpl.existsSync(file),
    // A read-only or odd ~/.config must not take the tray menu or startup down with it. → whether it took.
    set: (on) => {
      try {
        if (!on) fsImpl.rmSync(file, { force: true });
        else {
          fsImpl.mkdirSync(path.dirname(file), { recursive: true });
          fsImpl.writeFileSync(file, desktopEntry({ exec: env.APPIMAGE || execPath, name }));
        }
        return true;
      } catch (err) {
        log(`[login-item] could not ${on ? 'write' : 'remove'} ${file}: ${err.message}`);
        return false;
      }
    },
  };
}

module.exports = { create, desktopEntry, execQuote };
