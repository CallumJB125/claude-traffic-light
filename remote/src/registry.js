// The desktop's list of paired devices. Storage is injected ({load, save}):
// memoryStorage() here for tests and the PWA-free desktop core, and
// node/file-store.js fileStorage() for the real 0600 JSON file. A revoked
// device keeps its record (for the audit trail) but can never act again.
import { importPublicRaw, fingerprint } from './keys.js';
import { importAgreementPublic } from './envelope.js';

export function memoryStorage(initial = null) {
  let data = initial ? structuredClone(initial) : null;
  return {
    async load() { return data ? structuredClone(data) : null; },
    async save(next) { data = structuredClone(next); },
  };
}

export function cleanName(name) {
  // Control and bidi-override characters would let a name spoof the UI.
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim();
  return s.slice(0, 64) || 'Phone';
}

export class DeviceRegistry {
  constructor({ storage = memoryStorage(), clock = () => Date.now() } = {}) {
    this.storage = storage;
    this.clock = clock;
    this.data = null;
    this.keys = new Map();
    this.queue = Promise.resolve();
  }

  // Every mutation runs after the previous one: no lost updates in-process.
  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async #load() {
    if (!this.data) {
      const d = await this.storage.load();
      this.data = d && d.v === 1 && d.devices && typeof d.devices === 'object' ? d : { v: 1, devices: {} };
    }
    return this.data;
  }

  // agreeKey: the device's static ECDH public key for the end-to-end relay (envelope.js), from pairing.
  add({ publicKey, agreeKey = null, name, ownerId }) {
    return this.#serial(async () => {
      if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('ownerId required');
      await importPublicRaw(publicKey);
      if (agreeKey !== null) await importAgreementPublic(agreeKey);
      const deviceId = await fingerprint(publicKey);
      const d = await this.#load();
      // A revoked key stays revoked: re-pairing must use a fresh key.
      if (d.devices[deviceId]?.revokedAt) throw new Error('this device key was revoked; pair again with a new key');
      const now = this.clock();
      const rec = { deviceId, publicKey, agreeKey, name: cleanName(name), ownerId, createdAt: now, lastUsedAt: null, revokedAt: null };
      d.devices[deviceId] = rec;
      await this.storage.save(d);
      this.keys.delete(deviceId);
      return { ...rec };
    });
  }

  async get(deviceId) {
    await this.queue;
    const d = await this.#load();
    const rec = Object.prototype.hasOwnProperty.call(d.devices, deviceId) ? d.devices[deviceId] : null;
    return rec ? { ...rec } : null;
  }

  async list() {
    await this.queue;
    const d = await this.#load();
    return Object.values(d.devices).map((r) => ({ ...r }));
  }

  // The verification key for an active device, or null if unknown/revoked.
  async activeKey(deviceId) {
    const rec = await this.get(deviceId);
    if (!rec || rec.revokedAt) return null;
    if (!this.keys.has(deviceId)) this.keys.set(deviceId, await importPublicRaw(rec.publicKey));
    return { record: rec, key: this.keys.get(deviceId) };
  }

  // The relay's peer(dev) for createDesktopChannel: an active device's ECDH public key, or null (unknown, revoked, or paired before end-to-end).
  async activeAgreeKey(deviceId) {
    const rec = await this.get(deviceId);
    return rec && !rec.revokedAt && typeof rec.agreeKey === 'string' ? rec.agreeKey : null;
  }

  // A device's passkey (webauthn.js verifyRegistration), set once: replacing it means pairing again.
  setPasskey(deviceId, { credentialId, publicKey, signCount = 0 }) {
    return this.#serial(async () => {
      if (typeof credentialId !== 'string' || !/^[A-Za-z0-9_-]{16,1366}$/.test(credentialId)) throw new TypeError('bad credential id');
      await importPublicRaw(publicKey);
      const d = await this.#load();
      const rec = Object.prototype.hasOwnProperty.call(d.devices, deviceId) ? d.devices[deviceId] : null;
      if (!rec || rec.revokedAt) return false;
      if (rec.passkey) return false;
      rec.passkey = { credentialId, publicKey, signCount: Number.isSafeInteger(signCount) && signCount >= 0 ? signCount : 0, registeredAt: this.clock() };
      await this.storage.save(d);
      return true;
    });
  }

  setSignCount(deviceId, signCount) {
    return this.#serial(async () => {
      const d = await this.#load();
      const rec = d.devices[deviceId];
      if (!rec?.passkey || rec.revokedAt || !Number.isSafeInteger(signCount) || signCount < rec.passkey.signCount) return;
      rec.passkey.signCount = signCount;
      await this.storage.save(d);
    });
  }

  touch(deviceId) {
    return this.#serial(async () => {
      const d = await this.#load();
      const rec = d.devices[deviceId];
      if (!rec || rec.revokedAt) return;
      rec.lastUsedAt = this.clock();
      await this.storage.save(d);
    });
  }

  revoke(deviceId) {
    return this.#serial(async () => {
      const d = await this.#load();
      const rec = Object.prototype.hasOwnProperty.call(d.devices, deviceId) ? d.devices[deviceId] : null;
      if (!rec || rec.revokedAt) return false;
      rec.revokedAt = this.clock();
      await this.storage.save(d);
      this.keys.delete(deviceId);
      return true;
    });
  }

  revokeAll() {
    return this.#serial(async () => {
      const d = await this.#load();
      const now = this.clock();
      let n = 0;
      for (const rec of Object.values(d.devices)) if (!rec.revokedAt) { rec.revokedAt = now; n++; }
      await this.storage.save(d);
      this.keys.clear();
      return n;
    });
  }
}
