'use strict';
const path = require('node:path');
module.exports = {
  appId: 'dev.plexiform.terminal', productName: 'Plexiform Terminal',
  electronVersion: '44.3.0', asar: true,
  directories: { app: __dirname, output: path.resolve(__dirname, '../../dist/terminal') },
  files: ['main.js', 'preload.js', 'keeper-client.js', 'metadata.js', 'takeover.js', 'manifest.json', 'THIRD_PARTY_NOTICES.md', 'renderer/**/*', 'native/keeper-socket/keeper-socket.node', 'node_modules/**/*', '!node_modules/**/*.map'],
  asarUnpack: ['native/**/*.node'],
  extraResources: [{ from: path.resolve(__dirname, '../../native/keeper-build'), to: 'keeper', filter: ['Plexiform Session Keeper.app/**/*'] }],
  artifactName: 'Plexiform-Terminal-Development-Preview-${version}-${arch}.${ext}',
  // Alternate rank: Plexiform hands over with `open -a`; Finder keeps Terminal.app as the default for .command.
  fileAssociations: [{ ext: 'command', name: 'Shell Script', role: 'Shell', rank: 'Alternate' }],
  mac: { identity: '-', category: 'public.app-category.developer-tools', target: [{ target: 'zip', arch: ['arm64'] }], entitlements: path.join(__dirname, 'entitlements.dev.plist'), entitlementsInherit: path.join(__dirname, 'entitlements.dev.plist'), extendInfo: { LSMinimumSystemVersion: '13.0', PlexiformDevelopmentPreview: true, PlexiformTakeover: true } },
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true },
};
