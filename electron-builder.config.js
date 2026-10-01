// Installer config for Mac, Windows and Linux. It layers on package.json's
// "build" block rather than replacing it, so other branches that add to
// build.files keep working; the release workflow and the dist scripts pass
// `-c electron-builder.config.js`.
//
// Names the person sees (file names, DMG title, shortcuts, the Linux menu
// entry) come from brand.js. productName and appId in package.json are
// "Plexiform" and dev.plexiform.app; Electron derives the data folder, the
// safeStorage Keychain entry and the login item from them, so an install made
// under the old name is carried across on its first launch
// (src/rename-migration.js).
//
// Signing is off until Callum has a Developer ID. build/sign.js falls back to
// ad-hoc signing, which Apple Silicon needs to run the app at all.
const path = require('path');
const Brand = require('./brand.js');
const base = require('./package.json').build;


const artifact = (ext) => `${Brand.name}-\${version}-\${os}-\${arch}.${ext}`;

module.exports = {
  ...base,
  artifactName: artifact('${ext}'),
  // Written into app-update.yml. The updater never reads it (src/updater/
  // points electron-updater at each signed release's own folder); it is
  // here because electron-builder writes the latest*.yml feed files from it.
  publish: [{ provider: 'generic', url: Brand.urls.updates }],

  mac: {
    ...base.mac,
    // Ad-hoc ('-') until a Developer ID is provided. electron-builder 26
    // skips the custom sign hook (build/sign.js) when it finds no identity,
    // which would leave only the linker's signature and the calendar helper
    // without its narrow entitlements; 25 called the hook regardless.
    identity: process.env.CSC_LINK || process.env.CSC_NAME ? undefined : '-',
    // The zip is what latest-mac.yml points at; the DMG is what people download.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
  },
  dmg: { title: `${Brand.name} \${version}`, background: 'build/dmg-background.png' },

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
    installerSidebar: 'build/installerSidebar.bmp',
    uninstallerSidebar: 'build/installerSidebar.bmp',
    installerHeader: 'build/installerHeader.bmp',
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
