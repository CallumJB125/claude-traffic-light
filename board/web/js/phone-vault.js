// The phone's device token at rest: IndexedDB, AES-GCM encrypted under a
// non-extractable CryptoKey kept in the same database. Never localStorage,
// never a URL, never a cookie. This keeps the raw `bdt_` out of storage
// dumps and backups of browser data; it does NOT stop script running on this
// origin (it could use the key): that is what the CSP and the text-only
// renderer are for. See PHONE.md "Threat model".
//
// It also keeps the phone's end-to-end relay keys (phone-e2e.js,
// docs/relay-e2e-threat-model.md): one static ECDH P-256 key, generated here
// non-extractable (the private half is a CryptoKey that never leaves this
// browser as bytes), and the computers it is paired with ({did, dev,
// desktopAgree} per host device id: public values only). Signing out wipes
// both, so a new sign-in must pair again.
import { generateAgreementKey, exportAgreementPublic, importAgreementPublic } from './phone-e2e.js';

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

const ID = /^[A-Za-z0-9_-]{1,64}$/;

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
      await kv.del('agree');
      await kv.del('pairings');
    },
    /** This phone's static ECDH key pair, made on first use: {privateKey (non-extractable), publicKey, publicRaw}. */
    async agreementKey() {
      let k = await kv.get('agree');
      if (!k?.privateKey || k.privateKey.extractable !== false) {
        const pair = await generateAgreementKey({ extractable: false });
        k = { privateKey: pair.privateKey, publicKey: pair.publicKey };
        await kv.set('agree', k);
      }
      return { ...k, publicRaw: await exportAgreementPublic(k.publicKey) };
    },
    /** host device id -> {did, dev, desktopAgree}: the computers this phone is paired with. */
    async pairings() {
      const p = await kv.get('pairings');
      return p && typeof p === 'object' ? { ...p } : {};
    },
    /** After a pairing (W2-B): the desktop's id, this phone's id there, and the desktop's ECDH public key. */
    async savePairing(hostId, { did, dev, desktopAgree }) {
      if (typeof hostId !== 'string' || !hostId || !ID.test(did) || !ID.test(dev)) throw new TypeError('bad pairing');
      await importAgreementPublic(desktopAgree);
      const all = await this.pairings();
      all[hostId] = { did, dev, desktopAgree };
      await kv.set('pairings', all);
    },
    async forgetPairing(hostId) {
      const all = await this.pairings();
      delete all[hostId];
      await kv.set('pairings', all);
    },
  };
}
