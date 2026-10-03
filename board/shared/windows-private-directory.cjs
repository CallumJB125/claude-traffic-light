'use strict';
// Startup validation only. Operations using private files or control pipes
// must hold their own native directory lease while operating on those objects.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_PATH = 4096;
const DEADLINE_MS = 5000;
function helperPath(moduleDir = __dirname) {
  // Utility processes need not expose Electron's resourcesPath. Derive the
  // trusted bundled location from this module in app.asar or app.asar.unpacked.
  const appRoot = path.resolve(moduleDir, '..', '..');
  if (['app.asar', 'app.asar.unpacked'].includes(path.basename(appRoot))) return path.join(path.dirname(appRoot), 'native', 'windows-private-directory.exe');
  return path.join(appRoot, 'native', 'bin', 'windows-private-directory.exe');
}

function createClient({ execute = spawnSync, executable = helperPath(), platform = process.platform } = {}) {
  return {
    ensureDirectory(dir) {
      if (platform !== 'win32') throw new Error('Windows private-directory helper requires Windows');
      if (typeof dir !== 'string' || dir.length > MAX_PATH || !/^[A-Za-z]:\\/.test(dir) || /[\0\r\n]/.test(dir) || dir.includes('/')) throw new Error('Invalid private directory path');
      const bytes = Buffer.from(dir, 'utf16le');
      const input = Buffer.alloc(4 + bytes.length);
      input.writeUInt32LE(bytes.length, 0); bytes.copy(input, 4);
      let result;
      try {
        result = execute(executable, [], { input, encoding: 'utf8', timeout: DEADLINE_MS, maxBuffer: 1024, windowsHide: true, shell: false }); // privacy-flow: windows-private-directory
      } finally { input.fill(0); bytes.fill(0); }
      if (!result || result.error || result.signal || result.status !== 0) throw new Error('Windows private directory could not be verified');
      let receipt;
      try { receipt = JSON.parse(result.stdout); } catch { throw new Error('Invalid private directory receipt'); }
      if (!receipt || Array.isArray(receipt) || Object.keys(receipt).sort().join(',') !== 'fileId,ok,volume' || receipt.ok !== true || typeof receipt.volume !== 'string' || typeof receipt.fileId !== 'string' || !/^[a-f0-9]{16}$/.test(receipt.volume) || !/^[a-f0-9]{32}$/.test(receipt.fileId)) throw new Error('Invalid private directory receipt');
      return Object.freeze({ volume: receipt.volume, fileId: receipt.fileId });
    },
  };
}
module.exports = { helperPath, createClient, ensureDirectory: (...args) => createClient().ensureDirectory(...args), DEADLINE_MS };
