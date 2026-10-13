// Approximate metadata-only admission pressure; never a hard disk lock.
import { lstatSync } from 'node:fs';
import { HubError } from './db.js';

export const STORAGE_CHECK_MS = 60_000;
const MiB = 1024 * 1024;
const RESUME_AT = 0.9;
const CONFIG_ERROR = 'DB_SIZE_MAX_MB must be a positive safe whole number of MiB';

export function validateStorageMax(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / MiB)) throw new Error(CONFIG_ERROR);
  return value;
}

export function parseStorageMax(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error(CONFIG_ERROR);
  return validateStorageMax(Number(value));
}

/** Missing WAL is normal; a missing/unreadable/nonregular DB is unknown. */
export function dbFileSize(path) {
  if (path === ':memory:') return 0; // explicit isolated fixture database only
  const size = (name, optional) => {
    let entry;
    try { entry = lstatSync(name); }
    catch (error) { if (optional && error.code === 'ENOENT') return 0; throw new Error('storage sample unavailable'); }
    if (!entry.isFile() || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('storage sample unavailable');
    return entry.size;
  };
  const bytes = size(path, false) + size(`${path}-wal`, true);
  if (!Number.isSafeInteger(bytes)) throw new Error('storage sample unavailable');
  return bytes;
}

export class StorageWatch {
  constructor(hub, { maxMb = hub.config.dbSizeMaxMb, size = () => dbFileSize(hub.config.dbPath) } = {}) {
    this.hub = hub;
    this.maxMb = validateStorageMax(maxMb);
    this.enabled = this.maxMb != null;
    this.size = size;
    this.paused = false;
    this.status = 'disabled';
    this.checkedAt = -Infinity;
    this.check();
  }

  check() {
    if (!this.enabled) return false;
    const now = this.hub.mono();
    if (Number.isFinite(now) && now >= this.checkedAt && now - this.checkedAt < STORAGE_CHECK_MS) return this.paused;
    this.checkedAt = Number.isFinite(now) ? now : -Infinity;
    let bytes = null;
    try { if (Number.isFinite(now)) bytes = this.size(); } catch { /* fail closed; no path/error text in logs */ }
    const known = Number.isSafeInteger(bytes) && bytes >= 0;
    const max = this.maxMb * MiB;
    const paused = !known || (this.paused ? bytes >= max * RESUME_AT : bytes > max);
    const status = !known ? 'unknown' : paused ? 'paused' : 'available';
    if (status !== this.status) {
      // Only state transitions; fixed texts and rounded sizes, no private path.
      if (paused || this.paused) this.hub.log.warn(paused
        ? 'storage pressure: new accounts, teams, cards and comments paused'
        : 'storage pressure: new accounts, teams, cards and comments resumed',
      { status, max_mb: this.maxMb, ...(known ? { size_mb: Math.round(bytes / MiB) } : {}) });
    }
    this.status = status;
    this.paused = paused;
    return paused;
  }
}

export const storagePaused = hub => hub.storage?.check() === true;
export function requireStorage(hub) {
  if (storagePaused(hub)) throw new HubError('QUOTA_EXCEEDED', 'This hub is low on storage: nothing new can be added right now. Try again later.', { resource: 'storage' });
}
