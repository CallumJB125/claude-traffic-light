// Object stores for encrypted sync blobs (board/hub/sync.js, W3-C). Every
// body put here is ciphertext the hub cannot read.
//
// Interface: {kind, put(key, bytes), get(key) -> Uint8Array, delete(key)}.
// put never overwrites (an existing key is an error); delete of a missing key
// is fine. Keys are hub-made: "sync/<user>/<device>/<uuid>".
//
//  - memoryStore(): tests and local development; nothing leaves the process.
//  - R2SyncStore: Cloudflare R2 through its S3 API, following
//    board/deploy/offsite/s3.mjs (endpoint pinned to *.r2.cloudflarestorage.com,
//    no ACL, no presign, IfNoneMatch on put, no retries inside a request).
//    The AWS SDK is loaded only when a hub is configured with an R2 bucket
//    (it is not a board/ dependency: the operator installs it with the
//    deployment, docs/SYNC-RUNBOOK.md). Tests inject a fake SDK.

export class SyncStoreError extends Error {
  constructor(code, message = code) { super(message); this.name = 'SyncStoreError'; this.code = code; }
}

const KEY = /^sync\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}$/;
const checkKey = (key) => { if (typeof key !== 'string' || !KEY.test(key)) throw new SyncStoreError('BAD_KEY'); };

export function memoryStore() {
  const objects = new Map();
  return {
    kind: 'memory',
    objects,
    async put(key, bytes) {
      checkKey(key);
      if (objects.has(key)) throw new SyncStoreError('EXISTS');
      objects.set(key, Uint8Array.from(bytes));
    },
    async get(key) {
      checkKey(key);
      if (!objects.has(key)) throw new SyncStoreError('MISSING');
      return Uint8Array.from(objects.get(key));
    },
    async delete(key) { checkKey(key); objects.delete(key); },
  };
}

/** Validate an R2 config (same rules as offsite/s3.mjs storageConfig). → {endpoint, bucket, credentials} */
export function r2Config({ endpoint, bucket, accessKeyId, secretAccessKey } = {}) {
  let url; try { url = new URL(endpoint); } catch { throw new SyncStoreError('CONFIG', 'sync R2 endpoint is not a URL'); }
  const r2 = /^[0-9a-f]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname);
  if (url.protocol !== 'https:' || !r2 || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) {
    throw new SyncStoreError('CONFIG', 'sync R2 endpoint must be https://<account>.r2.cloudflarestorage.com');
  }
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new SyncStoreError('CONFIG', 'sync R2 bucket name is invalid');
  if (typeof accessKeyId !== 'string' || !accessKeyId || typeof secretAccessKey !== 'string' || !secretAccessKey) throw new SyncStoreError('CONFIG', 'sync R2 credentials are missing');
  return { endpoint: url.origin, bucket, credentials: { accessKeyId, secretAccessKey } };
}

function storeError(e) {
  const status = e?.$metadata?.httpStatusCode;
  if (status === 412) return new SyncStoreError('EXISTS');
  if (status === 404 || e?.name === 'NoSuchKey') return new SyncStoreError('MISSING');
  if (status === 401 || status === 403) return new SyncStoreError('AUTH');
  if (status === 409 || status === 429 || status >= 500 || ['TimeoutError', 'AbortError'].includes(e?.name)) return new SyncStoreError('RETRY');
  return new SyncStoreError('STORAGE');
}

export class R2SyncStore {
  /** sdk: {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand}; loaded on first use when not given. */
  constructor(config, { sdk = null } = {}) {
    this.config = r2Config(config);
    this.kind = 'r2';
    this.sdk = sdk;
    this.client = null;
  }

  async ready() {
    if (this.client) return this.client;
    this.sdk ??= await import('@aws-sdk/client-s3'); // privacy-flow: sync-hub-storage
    const { endpoint, credentials } = this.config;
    this.client = new this.sdk.S3Client({ endpoint, credentials, region: 'auto', forcePathStyle: true, maxAttempts: 1, followRegionRedirects: false,
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
    return this.client;
  }

  async put(key, bytes) {
    checkKey(key);
    const client = await this.ready();
    try {
      await client.send(new this.sdk.PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentLength: bytes.length,
        IfNoneMatch: '*', ContentType: 'application/octet-stream', CacheControl: 'no-store' }));
    } catch (e) { throw storeError(e); }
  }

  async get(key) {
    checkKey(key);
    const client = await this.ready();
    try {
      const out = await client.send(new this.sdk.GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return new Uint8Array(await out.Body.transformToByteArray());
    } catch (e) { throw storeError(e); }
  }

  async delete(key) {
    checkKey(key);
    const client = await this.ready();
    try { await client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })); } catch (e) {
      const err = storeError(e);
      if (err.code !== 'MISSING') throw err;
    }
  }
}

/** The store a hub config names: an injected store object (tests), {kind:'r2', ...} or nothing (sync off). */
export function storeFrom(spec) {
  if (!spec) return null;
  if (typeof spec.put === 'function' && typeof spec.get === 'function' && typeof spec.delete === 'function') return spec;
  if (spec.kind === 'memory') return memoryStore();
  if (spec.kind === 'r2') return new R2SyncStore(spec);
  throw new SyncStoreError('CONFIG', `unknown sync store kind '${spec.kind}'`);
}
