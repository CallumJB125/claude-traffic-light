// Installer config for Mac, Windows and Linux. It layers on package.json's
// "build" block rather than replacing it, so other branches that add to
// build.files keep working; the release workflow and the dist scripts pass
// `-c electron-builder.config.js`.
//
// Names the person sees (file names, DMG title, shortcuts, the Linux menu
// entry) come from brand.js. productName and appId stay as they are until the
// Stage 2 rename: Electron derives the data folder, the safeStorage Keychain
// entry and the login item from them, so changing them now would reset every
// install (.omc/plans/rename-plexiform.md).
//
// Signing is off until Callum has a Developer ID. build/sign.js falls back to
// ad-hoc signing, which Apple Silicon needs to run the app at all.
const path = require('path');
const Brand = require('./brand.js');
const base = require('./package.json').build;

// Where the installed app looks for updates: GitHub Releases now, the R2
// bucket at download.plexiform.dev once it is live (a brand.js change).
const FEED = process.env.PLEXIFORM_UPDATE_FEED || Brand.urls.updates || 'https://github.com/CallumJB125/claude-traffic-light/releases/latest/download';

const artifact = (ext) => `${Brand.name}-\${version}-\${os}-\${arch}.${ext}`;

module.exports = {
  ...base,
  artifactName: artifact('${ext}'),
  // electron-updater reads app-update.yml (written from this) to find the feed.
  publish: [{ provider: 'generic', url: FEED }],

  mac: {
    ...base.mac,
    // The zip is what latest-mac.yml points at; the DMG is what people download.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
  },
  dmg: { title: `${Brand.name} \${version}` },

  win: {
    ...base.win,
    // NSIS only: a portable .exe cannot update itself.
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
  },
  nsis: {
    ...base.nsis,
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: Brand.name,
    uninstallDisplayName: Brand.name,
    artifactName: artifact('${ext}'),
    deleteAppDataOnUninstall: false,
    // Takes Plexiform's hooks out of the agents' configs before the exe goes.
    include: 'build/installer.nsh',
  },

  linux: {
    // AppImage updates itself; the .deb is for people who want apt.
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'Development',
    // NxN.png per size; electron-builder reads the size from the name.
    icon: 'build/icons',
    executableName: 'plexiform',
    synopsis: Brand.tagline,
    description: Brand.tagline,
    maintainer: `${Brand.name} <${Brand.email('support')}>`,
    desktop: { entry: { Name: Brand.name, Comment: Brand.tagline } },
  },
  deb: {
    artifactName: artifact('${ext}'),
    // prerm: takes Plexiform's hooks out of each user's agent configs on
    // remove. electron-builder has no option for it; fpm does.
    fpm: ['--before-remove', path.join(__dirname, 'build', 'linux', 'prerm.sh')],
  },
  appImage: { artifactName: artifact('${ext}') },
};
