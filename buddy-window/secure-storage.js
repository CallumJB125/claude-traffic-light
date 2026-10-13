'use strict';

// Account and runner credentials require the OS password store. Electron's
// Linux basic_text backend is reversible plaintext, even when availability
// reports true. Never weaken storage to make first-run sign-in succeed.
const LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
function storageHelp(platform = process.platform) {
  if (platform === 'darwin') return 'Open Keychain Access and unlock your login keychain, then try again in Plexiform. If macOS asks, check that the request names Plexiform and Plexiform Safe Storage. No Terminal command is needed.';
  if (platform === 'linux') return 'Unlock your desktop password store (Passwords and Keys or KWallet), then try again in Plexiform. A secure password store is required; no Plexiform setup command is needed.';
  return 'Unlock your computer and try again in Plexiform. If secure storage is still unavailable, restart the app or contact support.';
}
function createSecureStorage(storage, platform = process.platform) {
  const available = () => {
    try { return storage?.isEncryptionAvailable() === true && (platform !== 'linux' || LINUX_BACKENDS.has(storage.getSelectedStorageBackend?.())); }
    catch { return false; }
  };
  const requireStorage = () => {
    if (!available()) throw new Error(`Secure storage is unavailable. ${storageHelp(platform)}`);
    return storage;
  };
  return {
    available,
    encrypt: text => requireStorage().encryptString(text),
    decrypt: bytes => requireStorage().decryptString(bytes),
  };
}
module.exports = { createSecureStorage, storageHelp };
