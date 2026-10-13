// This deployment adapter has no bucket, policy, ACL, presign or delete method.
import fs from 'node:fs';
import { finished } from 'node:stream/promises';
import { open } from './files.mjs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { OffsiteError, fail } from './schema.mjs';

export function storageConfig({ endpoint, bucket, accessKeyId, secretAccessKey, sessionToken = null }, { testLoopback = false } = {}) {
  let url; try { url = new URL(endpoint); } catch { fail('CONFIG'); }
  const r2 = /^[0-9a-f]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port
    || !(url.protocol === 'https:' && r2)) {
    if (!(testLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)) fail('CONFIG');
  }
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    || typeof accessKeyId !== 'string' || !accessKeyId.length || typeof secretAccessKey !== 'string' || !secretAccessKey.length
    || (sessionToken !== null && typeof sessionToken !== 'string')) fail('CONFIG');
  return { endpoint: url.origin, bucket, credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } };
}
function error(e) {
  const status = e?.$metadata?.httpStatusCode;
  if (status === 412) return new OffsiteError('EXISTS');
  if (status === 409 || status === 429 || status >= 500 || ['TimeoutError', 'AbortError'].includes(e?.name) || ['ECONNRESET','ETIMEDOUT','ECONNREFUSED','EAI_AGAIN'].includes(e?.code)) return new OffsiteError('RETRY');
  if (status === 401 || status === 403) return new OffsiteError('AUTH');
  if (status === 404) return new OffsiteError('MISSING');
  return new OffsiteError('STORAGE');
}
export class S3Store {
  constructor(config, { testLoopback = false, client = null } = {}) {
    const c = storageConfig(config, { testLoopback }); this.bucket = c.bucket;
    // Drill receipts may claim real off-site acceptance only for a validated R2 origin.
    this.kind = client ? 'injected-client' : testLoopback ? 'loopback-fixture' : 'r2';
    this.client = client ?? new S3Client({ ...c, bucket: undefined, region: 'auto', forcePathStyle: true, maxAttempts: 1,
      followRegionRedirects: false, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }); // privacy-flow: paired-offsite
  }
  async put(key, file, expected, { signal } = {}) {
    // Open synchronously before handing the stream to the SDK. Always await
    // destruction so delayed opens/errors cannot outlive the upload or lock.
    const { fd, size } = open(file, expected.byte_length);
    if (size !== expected.byte_length) { fs.closeSync(fd); fail('BYTES'); }
    const body = fs.createReadStream(null, { fd, autoClose: true });
    const done = finished(body, { cleanup: true }).catch(() => {});
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: expected.byte_length,
        IfNoneMatch: '*', ContentType: 'application/octet-stream', CacheControl: 'no-store' }), { abortSignal: signal });
    } catch (e) { throw error(e); } finally { body.destroy(); await done; }
  }
  async get(key, { signal } = {}) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      return { body: result.Body, byte_length: result.ContentLength };
    } catch (e) { throw error(e); }
  }
  close() { this.client.destroy?.(); }
}
