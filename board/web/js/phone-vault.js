// The phone's device token at rest: IndexedDB, AES-GCM encrypted under a
// non-extractable CryptoKey kept in the same database. Never localStorage,
// never a URL, never a cookie. This keeps the raw `bdt_` out of storage
// dumps and backups of browser data; it does NOT stop script running on this
// origin (it could use the key): that is what the CSP and the text-only
// renderer are for. See PHONE.md "Threat model".

const DB = 'plexiform-phone';
const STORE = 'vault';

/** A {get, set, del} key-value store over IndexedDB (structured clone keeps CryptoKeys). */
export function idbKv(indexedDB = globalThis.indexedDB) {
  let dbp = null;
  const open = () => (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    del: (k) => run('readwrite', (s) => s.delete(k)),
  };
}

export function createVault({ kv, subtle = globalThis.crypto.subtle, getRandomValues = (a) => globalThis.crypto.getRandomValues(a) }) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  async function key(create) {
    let k = await kv.get('key');
    if (!k && create) {
      k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await kv.set('key', k);
    }
    return k ?? null;
  }
  return {
    async save(token) {
      // A fresh key per sign-in: nothing from an earlier sign-in decrypts.
      await kv.del('key');
      const k = await key(true);
      const iv = getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(token)));
      await kv.set('token', { v: 1, iv, data });
    },
    async load() {
      const rec = await kv.get('token');
      const k = rec && await key(false);
      if (!rec || !k) return null;
      try {
        return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, k, rec.data));
      } catch {
        await this.clear();
        return null;
      }
    },
    async clear() {
      await kv.del('token');
      await kv.del('key');
    },
  };
}
