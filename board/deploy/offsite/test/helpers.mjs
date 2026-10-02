import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, generateKeyPairSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createBackup } from '../../pi/backup-lib.mjs';
import { OffsiteError, hash } from '../schema.mjs';
import { consume } from '../files.mjs';

export function rig(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'offsite-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), outbox = path.join(root, 'outbox'); fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(outbox, { mode: 0o700 });
  const conn = new DatabaseSync(path.join(data, 'board.db'));
  conn.exec("PRAGMA journal_mode=WAL; CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('original'); CREATE TABLE client_artifact_versions(id TEXT PRIMARY KEY, sha256 TEXT, byte_length INTEGER); CREATE TABLE decisions(artifact_id TEXT, sha256 TEXT, decision TEXT)");
  t.after(() => conn.close());
  const bytes = Buffer.from('Exact privately approved client version'), id = randomUUID(), sha256 = hash(bytes);
  fs.mkdirSync(path.join(data, 'client-artifacts'), { mode: 0o700 }); fs.writeFileSync(path.join(data, 'client-artifacts', `${id}.bin`), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'client-artifacts', `${randomUUID()}.bin`), 'orphan upload', { mode: 0o600 });
  conn.prepare('INSERT INTO client_artifact_versions VALUES (?,?,?)').run(id, sha256, bytes.length);
  conn.prepare('INSERT INTO decisions VALUES (?,?,?)').run(id, sha256, 'approve');
  const { bundle } = createBackup({ dataDir: data });
  const signing = generateKeyPairSync('ed25519'), installation = randomUUID();
  return { root, data, outbox, conn, bytes, id, sha256, bundle, signing, installation,
    options: { outbox, installation, recipientId:'recovery-a', signingKeyId:'signer-a', signingKey:signing.privateKey },
    trustedKeys: new Map([['signer-a', signing.publicKey]]) };
}
// Test-only cipher lets schema/fault tests run without an external executable.
// Acceptance tests separately use real age and fixture recovery identities.
export function fixtureCipher() {
  const key = randomBytes(32);
  const all = async input => { const parts = []; for await (const b of input) parts.push(b); return Buffer.concat(parts); };
  return {
    async encrypt(input, target, max) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv), data = await all(input);
      return consume(Readable.from([Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()])]), target, { max }); },
    async decrypt(input, target, max) { const b = await all(input), c = createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16));
      return consume(Readable.from([Buffer.concat([c.update(b.subarray(12,-16)), c.final()])]), target, { max }); },
  };
}
export class MemoryStore {
  constructor() { this.bytes = new Map(); this.calls = []; this.hook = null; }
  async put(key, file, expected) {
    this.calls.push(['put', key]); await this.hook?.('put', key);
    if (this.bytes.has(key)) throw new OffsiteError('EXISTS');
    const b = fs.readFileSync(file); if (b.length !== expected.byte_length) throw new OffsiteError('BYTES'); this.bytes.set(key, b);
  }
  async get(key) {
    this.calls.push(['get', key]); await this.hook?.('get', key);
    const b = this.bytes.get(key); if (!b) throw new OffsiteError('MISSING'); return { body: Readable.from([b]), byte_length: b.length };
  }
}
