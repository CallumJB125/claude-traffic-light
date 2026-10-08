import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createPublicKey } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { stageRestore, validateBackup } from '../pi/backup-lib.mjs';
import { DEFAULTS, FORMAT, MAX_COMPLETION, MAX_WINDOW_MS, MAX_OBJECTS, OffsiteError, fail, encode, hash, closed, limits, paired, internal,
  prefix, uuid, keyId, objectName, object, cipherMax, objectsHash, signedCompletion, verifyCompletion } from './schema.mjs';
import { directory, syncDir, readJson, json, replaceJson, check, source, consume, digest, usage, locked, exclusive, writeAll } from './files.mjs';

const now = () => Date.now();
const stamp = (clock) => new Date(clock()).toISOString();
const fields = ['completion', 'objects', 'upload_started_at'];
export function readPrepared({ outbox, transport, installation, trustedKeys, policy = DEFAULTS }) {
  policy = limits(policy);
  const dir = path.join(directory(outbox), uuid(transport)); directory(dir);
  const state = readJson(path.join(dir, 'ready.json'), policy.maxManifest); closed(state, fields);
  verifyCompletion(state.completion, { installation, transport, trustedKeys, policy });
  if (!Array.isArray(state.objects) || state.objects.length !== state.completion.object_count || objectsHash(state.objects) !== state.completion.objects_hash) fail();
  state.objects.forEach((o, i) => object(o, objectName(i), cipherMax(policy.chunkBytes > policy.maxArtifact ? policy.chunkBytes : policy.maxArtifact)));
  if (state.upload_started_at !== null && (typeof state.upload_started_at !== 'string' || !Number.isFinite(Date.parse(state.upload_started_at)) || new Date(state.upload_started_at).toISOString() !== state.upload_started_at)) fail();
  for (const o of [...state.objects, state.completion.manifest]) check(path.join(dir, o.name), o);
  check(path.join(dir, 'completion.json'), { sha256: hash(encode(state.completion)), byte_length: encode(state.completion).length });
  return { dir, state };
}
function budget(outbox, needed, policy) { if (usage(outbox) + needed > policy.maxOutbox) fail('OUTBOX_QUOTA'); }
function estimate(m, policy) {
  const count = Math.ceil(m.database.byte_length / policy.chunkBytes) + m.artifacts.length;
  if (count > MAX_OBJECTS) fail('LIMITS');
  const total = m.database.byte_length + m.artifacts.reduce((n, a) => n + a.byte_length, 0);
  return 2 * total + count * 8192 + 3 * policy.maxManifest;
}
export async function prepare({ bundle, outbox, installation, recipientId, signingKeyId, signingKey, cipher, policy: over = {}, clock = now, drill = false }) {
  const policy = limits(over); uuid(installation); keyId(recipientId); keyId(signingKeyId);
  if (signingKey?.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519') fail('KEY');
  return locked(outbox, async () => {
    const m = paired(validateBackup(bundle), policy); budget(outbox, estimate(m, policy), policy);
    const transport = randomUUID(), dir = path.join(outbox, transport); directory(dir, { create: true }); syncDir(outbox);
    const plain = path.join(dir, 'plain'); let ready = false;
    try {
      stageRestore({ bundle, destination: plain });
      const files = [], objects = []; let index = 0;
      for (const [i, f] of [m.database, ...m.artifacts].entries()) {
        const parts = [], size = i === 0 ? policy.chunkBytes : f.byte_length;
        for (let offset = 0; offset < f.byte_length; offset += size) {
          const length = Math.min(size, f.byte_length - offset), name = objectName(index++);
          const wire = await cipher.encrypt(source(path.join(plain, f.file), { start: offset, length }), path.join(dir, name), cipherMax(length));
          parts.push({ name, ...wire, plain_bytes: length }); objects.push({ name, ...wire });
        }
        files.push({ file: f.file, parts });
      }
      const manifest = { format: `${FORMAT}-manifest`, recipient_id: recipientId, chunk_bytes: policy.chunkBytes, paired: m, files };
      internal(manifest, policy); const bytes = encode(manifest); if (bytes.length > policy.maxManifest) fail('LIMITS');
      const encrypted = await cipher.encrypt((async function* () { yield bytes; })(), path.join(dir, 'manifest.age'), cipherMax(policy.maxManifest));
      const completion = signedCompletion({ format: FORMAT, installation_id: installation, transport_id: transport, snapshot_at: m.created_at,
        created_at: stamp(clock), signing_key_id: signingKeyId, manifest: { name: 'manifest.age', ...encrypted },
        object_count: objects.length, objects_hash: objectsHash(objects), ...(drill === true ? { drill: true } : {}) }, signingKey);
      verifyCompletion(completion, { installation, transport, trustedKeys: new Map([[signingKeyId, createPublicKey(signingKey)]]), policy });
      json(path.join(dir, 'completion.json'), completion);
      fs.rmSync(plain, { recursive: true }); syncDir(dir);
      json(path.join(dir, 'ready.json'), { completion, objects, upload_started_at: null }); ready = true;
      return { transport_id: transport, object_count: objects.length, snapshot_at: m.created_at };
    } finally { if (!ready) { fs.rmSync(dir, { recursive: true, force: true }); syncDir(outbox); } }
  });
}
export async function forkPrepared({ outbox, transport, installation, signingKeyId, signingKey, trustedKeys, policy: over = {}, clock = now }) {
  const policy = limits(over);
  return locked(outbox, async () => {
    const { dir: previous, state } = readPrepared({ outbox, transport, installation, trustedKeys, policy });
    budget(outbox, [...state.objects, state.completion.manifest].reduce((n, o) => n + o.byte_length, 0) + policy.maxManifest, policy);
    const fresh = randomUUID(), dir = path.join(outbox, fresh); directory(dir, { create: true }); let ready = false;
    try {
      for (const o of [...state.objects, state.completion.manifest]) await consume(source(path.join(previous, o.name)), path.join(dir, o.name), { max: o.byte_length, expected: o });
      const completion = signedCompletion({ ...state.completion, transport_id: fresh, created_at: stamp(clock), signing_key_id: keyId(signingKeyId) }, signingKey);
      verifyCompletion(completion, { installation, transport: fresh, trustedKeys, policy });
      json(path.join(dir, 'completion.json'), completion); syncDir(outbox);
      json(path.join(dir, 'ready.json'), { completion, objects: state.objects, upload_started_at: null }); ready = true;
      return { transport_id: fresh, snapshot_at: completion.snapshot_at };
    } finally { if (!ready) { fs.rmSync(dir, { recursive: true, force: true }); syncDir(outbox); } }
  });
}
async function download(store, key, file, { max, expected = null, timeoutMs = 30_000 }) {
  const controller = new AbortController(); let stream; let rejectTimeout;
  const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); stream?.destroy?.(); rejectTimeout(new OffsiteError('RETRY')); }, timeoutMs);
  try {
    const response = await Promise.race([store.get(key, { signal: controller.signal }), timedOut]); stream = response.body;
    if (!stream || !Number.isSafeInteger(response.byte_length) || response.byte_length < 1 || response.byte_length > max
      || (expected && response.byte_length !== expected.byte_length)) fail('BYTES');
    return await Promise.race([consume(stream, file, { max, expected, signal: controller.signal }), timedOut]);
  } catch (e) { if (controller.signal.aborted) fail('RETRY'); throw e; }
  finally { clearTimeout(timer); controller.abort(); stream?.destroy?.(); }
}
async function ensureRemote(store, key, local, expected, dir, { attempts, timeoutMs, wait }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const downloaded = path.join(dir, `.readback-${randomUUID()}`);
    try {
      try { await download(store, key, downloaded, { max: expected.byte_length, expected, timeoutMs }); return; }
      catch (e) { if (e.code !== 'MISSING') throw e; }
      const controller = new AbortController(); let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new OffsiteError('RETRY')); }, timeoutMs); });
      try { await Promise.race([store.put(key, local, expected, { signal: controller.signal }), timeout]); }
      catch (e) { if (!['EXISTS', 'RETRY'].includes(e.code)) throw e; }
      finally { clearTimeout(timer); controller.abort(); }
      await download(store, key, downloaded, { max: expected.byte_length, expected, timeoutMs }); return;
    } catch (e) {
      if (!['RETRY', 'MISSING'].includes(e.code) || attempt === attempts - 1) throw e;
      await wait(Math.min(250 * 2 ** attempt, 2000));
    } finally { if (fs.existsSync(downloaded)) fs.unlinkSync(downloaded); }
  }
}
export async function upload({ outbox, transport, installation, trustedKeys, store, policy: over = {}, clock = now, attempts = 3, timeoutMs = 30_000, wait = pause }) {
  const policy = limits(over);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('LIMITS');
  return locked(outbox, async () => {
    const { dir, state } = readPrepared({ outbox, transport, installation, trustedKeys, policy });
    // Reserve room for one readback plus an atomic state/receipt rewrite.
    budget(outbox, policy.maxManifest + Math.max(...state.objects.map(o => o.byte_length), state.completion.manifest.byte_length, MAX_COMPLETION), policy);
    const base = prefix(installation, transport), options = { attempts, timeoutMs, wait };
    const bytes = encode(state.completion), completion = { byte_length: bytes.length, sha256: hash(bytes) };
    const completedFile = path.join(dir, `.completed-${randomUUID()}`); let completed = false;
    try { await download(store, base + 'completion.json', completedFile, { max: completion.byte_length, expected: completion, timeoutMs }); completed = true; }
    catch (e) { if (e.code !== 'MISSING') throw e; }
    finally { if (fs.existsSync(completedFile)) fs.unlinkSync(completedFile); }
    if (!completed && !state.upload_started_at) { state.upload_started_at = stamp(clock); replaceJson(path.join(dir, 'ready.json'), state); }
    const withinWindow = (reserve = 0) => { const elapsed = clock() - Date.parse(state.upload_started_at);
      if (elapsed < 0 || elapsed > MAX_WINDOW_MS - reserve) fail('PUBLICATION_WINDOW'); };
    for (const o of [...state.objects, state.completion.manifest]) {
      if (completed) {
        const checked = path.join(dir, `.readback-${randomUUID()}`);
        try { await download(store, base + o.name, checked, { max: o.byte_length, expected: o, timeoutMs }); }
        finally { if (fs.existsSync(checked)) fs.unlinkSync(checked); }
      } else { withinWindow(); await ensureRemote(store, base + o.name, path.join(dir, o.name), o, dir, options); }
    }
    if (!completed) {
      withinWindow(attempts * 3 * timeoutMs + 5000);
      await ensureRemote(store, base + 'completion.json', path.join(dir, 'completion.json'), completion, dir, options);
    }
    const receipt = { format: `${FORMAT}-receipt`, installation_id: installation, transport_id: transport,
      snapshot_at: state.completion.snapshot_at, confirmed_at: stamp(clock), object_count: state.objects.length, completion_sha256: completion.sha256 };
    replaceJson(path.join(dir, 'receipt.json'), receipt); return receipt;
  });
}

// Local cleanup is explicit and can only remove a complete selected outbox.
// The storage adapter is used for GET verification only; remote retention and
// deletion remain outside this helper's authority.
export async function pruneConfirmed({ outbox, transport, installation, trustedKeys, store, policy: over = {}, timeoutMs = 30_000 }) {
  const policy = limits(over);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('LIMITS');
  return locked(outbox, async () => {
    const { dir, state } = readPrepared({ outbox, transport, installation, trustedKeys, policy });
    const receipt = readJson(path.join(dir, 'receipt.json'), MAX_COMPLETION);
    closed(receipt, ['format','installation_id','transport_id','snapshot_at','confirmed_at','object_count','completion_sha256']);
    const bytes = encode(state.completion), completion = { name:'completion.json', byte_length:bytes.length, sha256:hash(bytes) };
    if (receipt.format !== `${FORMAT}-receipt` || receipt.installation_id !== installation || receipt.transport_id !== transport
      || receipt.snapshot_at !== state.completion.snapshot_at || receipt.object_count !== state.objects.length || receipt.completion_sha256 !== completion.sha256
      || typeof receipt.confirmed_at !== 'string' || !Number.isFinite(Date.parse(receipt.confirmed_at)) || new Date(receipt.confirmed_at).toISOString() !== receipt.confirmed_at) fail('NOT_CONFIRMED');
    budget(outbox, Math.max(...state.objects.map(o=>o.byte_length), state.completion.manifest.byte_length, MAX_COMPLETION), policy);
    const base = prefix(installation, transport);
    for (const o of [completion, ...state.objects, state.completion.manifest]) {
      const file = path.join(dir, `.readback-${randomUUID()}`);
      try { await download(store, base + o.name, file, { max:o.byte_length, expected:o, timeoutMs }); }
      finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
    }
    fs.rmSync(dir, { recursive:true }); syncDir(outbox);
    return { pruned:true, transport_id:transport, snapshot_at:state.completion.snapshot_at };
  });
}

export async function retrieve({ store, installation, transport, trustedKeys, cipher, destination, policy: over = {}, timeoutMs = 30_000, drill = false }) {
  const policy = limits(over), base = prefix(installation, transport);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('LIMITS');
  directory(path.dirname(destination));
  if (fs.existsSync(destination)) fail('DESTINATION_EXISTS');
  const temp = path.join(path.dirname(destination), `.retrieve-${randomUUID()}`); directory(temp, { create: true });
  const bundle = path.join(temp, 'bundle'); directory(bundle, { create: true }); directory(path.join(bundle, 'client-artifacts'), { create: true });
  let published = false;
  try {
    await download(store, base + 'completion.json', path.join(temp, 'completion.json'), { max: MAX_COMPLETION, timeoutMs });
    const completion = readJson(path.join(temp, 'completion.json'), MAX_COMPLETION); verifyCompletion(completion, { installation, transport, trustedKeys, policy });
    if ((completion.drill === true) !== (drill === true)) fail('DRILL_ARTIFACT');
    await download(store, base + 'manifest.age', path.join(temp, 'manifest.age'), { max: completion.manifest.byte_length, expected: completion.manifest, timeoutMs });
    await cipher.decrypt(source(path.join(temp, 'manifest.age')), path.join(temp, 'manifest.json'), policy.maxManifest);
    const manifest = readJson(path.join(temp, 'manifest.json'), policy.maxManifest), objects = internal(manifest, policy);
    if (objects.length !== completion.object_count || objectsHash(objects) !== completion.objects_hash || manifest.paired.created_at !== completion.snapshot_at) fail('SIGNATURE');
    // Each destination is derived by the closed manifest's fixed-name/UUID
    // rules. No archive extractor or caller-supplied local file is used.
    for (const f of manifest.files) {
      const file = path.join(bundle, f.file), fd = exclusive(file);
      try {
        for (const part of f.parts) {
          const encrypted = path.join(temp, 'part.age'), plain = path.join(temp, 'part.bin');
          await download(store, base + part.name, encrypted, { max: part.byte_length, expected: part, timeoutMs });
          await cipher.decrypt(source(encrypted), plain, part.plain_bytes);
          if (digest(plain, part.plain_bytes).byte_length !== part.plain_bytes) fail('BYTES');
          for await (const bytes of source(plain)) writeAll(fd, bytes);
          fs.unlinkSync(encrypted); fs.unlinkSync(plain);
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      check(file, manifest.paired.database.file === f.file ? manifest.paired.database : manifest.paired.artifacts.find(a => a.file === f.file));
    }
    json(path.join(bundle, 'manifest.json'), manifest.paired); syncDir(path.join(bundle, 'client-artifacts')); syncDir(bundle);
    validateBackup(bundle);
    // An exclusive reservation prevents a concurrent caller from being
    // silently replaced by rename. Only our newly reserved directory is removed.
    fs.mkdirSync(destination, { mode: 0o700 });
    try { fs.renameSync(path.join(bundle, 'board.db'), path.join(destination, 'board.db'));
      fs.renameSync(path.join(bundle, 'client-artifacts'), path.join(destination, 'client-artifacts'));
      fs.renameSync(path.join(bundle, 'manifest.json'), path.join(destination, 'manifest.json'));
      syncDir(destination); syncDir(path.dirname(destination)); published = true;
    } catch (e) { fs.rmSync(destination, { recursive: true, force: true }); throw e; }
    return { verified: true, installation_id: installation, transport_id: transport, snapshot_at: completion.snapshot_at, artifact_count: manifest.paired.artifacts.length };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); if (!published) syncDir(path.dirname(destination)); }
}
