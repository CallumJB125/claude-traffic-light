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
  const unavailable = () => new Error(`Secure storage is unavailable. ${storageHelp(platform)}`);
  const available = () => {
    try { return storage?.isEncryptionAvailable() === true && (platform !== 'linux' || LINUX_BACKENDS.has(storage.getSelectedStorageBackend?.())); }
    catch { return false; }
  };
  const requireStorage = () => {
    if (!available()) throw new Error(`Secure storage is unavailable. ${storageHelp(platform)}`);
    return storage;
  };
  const availableAsync = async () => {
    try {
      // Electron's Linux async encryptor can silently select a POSIX fallback;
      // its cached synchronous backend name cannot attest the async provider.
      // Keep Linux on the existing guarded API until that provider is verified.
      if ((platform !== 'darwin' && platform !== 'win32') || typeof storage?.isAsyncEncryptionAvailable !== 'function' ||
          typeof storage.encryptStringAsync !== 'function' || typeof storage.decryptStringAsync !== 'function') return false;
      // Do not call isEncryptionAvailable: it can synchronously wait on Keychain.
      return await storage.isAsyncEncryptionAvailable() === true;
    } catch { return false; }
  };
  const requireStorageAsync = async () => {
    if (!await availableAsync()) throw unavailable();
    return storage;
  };
  const secureAsyncBytes = bytes => Buffer.isBuffer(bytes) && bytes.length > 0;
  return {
    available,
    encrypt: text => requireStorage().encryptString(text),
    decrypt: bytes => requireStorage().decryptString(bytes),
    availableAsync,
    encryptAsync: async text => {
      try {
        if (typeof text !== 'string') throw unavailable();
        const native = await requireStorageAsync();
        const bytes = await native.encryptStringAsync(text);
        if (!secureAsyncBytes(bytes)) throw unavailable();
        return bytes;
      } catch { throw unavailable(); }
    },
    decryptAsync: async bytes => {
      try {
        if (!secureAsyncBytes(bytes)) throw unavailable();
        const native = await requireStorageAsync();
        const value = await native.decryptStringAsync(bytes);
        if (!value || typeof value.result !== 'string' || typeof value.shouldReEncrypt !== 'boolean') throw unavailable();
        // Rotation is advisory. Reading a legacy credential must never rewrite
        // it or retry cryptography without the account owner's explicit save.
        return value.result;
      } catch { throw unavailable(); }
    },
  };
}
module.exports = { createSecureStorage, storageHelp };
