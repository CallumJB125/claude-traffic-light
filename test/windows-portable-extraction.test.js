'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Initialize the builder's public entry point before its internal target.
require('app-builder-lib');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
const { Arch } = require('builder-util');
const config = require('../electron-builder.config');
const lock = require('../package-lock.json');

// Exercise the locked builder's real define generation. Its documented
// effectiveOptionComputed stop hook returns before the build queue, signing
// or compiler; package bytes and platform resources are synthetic.
async function portableDefines(options) {
  let result;
  const forbidden = () => { throw new Error('Define inspection must not build or sign an installer'); };
  const appInfo = {
    id: 'dev.plexiform.synthetic', name: 'synthetic', productName: 'Synthetic',
    productFilename: 'Synthetic', description: 'Synthetic fixture', version: '1.0.0',
    copyright: 'Synthetic', buildVersion: '1.0.0', getVersionInWeirdWindowsForm: () => '1.0.0.0',
  };
  const target = {
    name: 'portable', isPortable: true, isWebInstaller: false, isUnicodeEnabled: true,
    options, outDir: path.join(__dirname, 'synthetic-output'),
    packager: {
      appInfo, config: {}, platformSpecificBuildOptions: {}, compression: 'store', projectDir: __dirname,
      info: { metadata: {}, buildResourcesDir: __dirname, emitArtifactBuildStarted: async () => {}, emitArtifactBuildCompleted: forbidden },
      expandArtifactNamePattern: () => 'synthetic-portable.exe', getIconPath: async () => null, signIf: forbidden,
      packagerOptions: { effectiveOptionComputed: async ([defines]) => { result = defines; return true; } },
    },
    packageHelper: { packArch: async () => ({ fileInfo: { path: 'synthetic-package.7z', sha512: Buffer.from('synthetic bytes').toString('base64') }, unpackedSize: 128 }) },
    installerFilenamePattern: () => 'synthetic-portable.exe',
    computeVersionKey: NsisTarget.prototype.computeVersionKey,
    configureDefinesForAllTypeOfInstaller: NsisTarget.prototype.configureDefinesForAllTypeOfInstaller,
    buildQueueManager: { add: forbidden }, executeMakensis: forbidden,
  };
  await NsisTarget.prototype.buildInstaller.call(target, new Map([[Arch.x64, 'synthetic-app']]));
  assert.ok(result, 'builder must reach the stop hook without build side effects');
  return result;
}

test('locked portable target gives concurrent GUI and hook launches separate extraction directories', async () => {
  const defines = await portableDefines(config.portable);
  assert.equal(Object.hasOwn(defines, 'UNPACK_DIR_NAME'), false,
    'a per-build unpack folder lets a hook invocation overwrite the running portable app');
  assert.equal(defines.REQUEST_EXECUTION_LEVEL, 'user');
});

test('exact locked builder differentiates per-launch extraction from the old default and false setting', async () => {
  const version = require('app-builder-lib/package.json').version;
  assert.equal(version, '26.16.1');
  assert.equal(lock.packages['node_modules/app-builder-lib'].version, version);
  assert.equal(lock.packages[''].devDependencies['electron-builder'], version);
  for (const options of [{}, { unpackDirName: false }, { unpackDirName: 'fixed-synthetic-directory' }]) {
    const defines = await portableDefines(options);
    assert.equal(typeof defines.UNPACK_DIR_NAME, 'string');
    assert.ok(defines.UNPACK_DIR_NAME);
  }
  assert.equal(Object.hasOwn(await portableDefines({ unpackDirName: true }), 'UNPACK_DIR_NAME'), false);
});

test('locked native portable template uses a unique launch folder when the fixed define is absent', () => {
  const template = fs.readFileSync(path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/portable.nsi'), 'utf8');
  assert.match(template, /StrCpy \$INSTDIR "\$PLUGINSDIR\\app"/);
  assert.match(template, /!ifdef UNPACK_DIR_NAME\s+StrCpy \$INSTDIR "\$TEMP\\\$\{UNPACK_DIR_NAME\}"\s+!endif/);
  assert.ok(template.indexOf('RMDir /r $INSTDIR') < template.indexOf('ExecWait'));
});
