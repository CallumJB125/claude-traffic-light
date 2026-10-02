import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateBackup, stageRestore } from '../../pi/backup-lib.mjs';
import { prepare, upload, retrieve, readPrepared, forkPrepared } from '../offsite-lib.mjs';
import { prefix, hash, OffsiteError, MAX_WINDOW_MS } from '../schema.mjs';
import { locked, replaceJson } from '../files.mjs';
import { rig, MemoryStore, fixtureCipher } from './helpers.mjs';

async function prepared(t, over = {}) {
  const r=rig(t), cipher=fixtureCipher(), store=new MemoryStore();
  const p=await prepare({...r.options,bundle:r.bundle,cipher,...over});
  const options={...r.options,transport:p.transport_id,trustedKeys:r.trustedKeys,store,wait:async()=>{},...over};
  return {...r,cipher,store,p,options};
}
test('paired WAL and exact approval survive private outbox, remote confirmation and fresh retrieval', async t=>{
  const r=await prepared(t,{policy:{chunkBytes:4096}});
  const dir=path.join(r.outbox,r.p.transport_id);
  assert.ok(!fs.existsSync(path.join(dir,'plain')));
  const p=readPrepared({...r.options,policy:{...r.options.policy}});
  assert.ok(p.state.objects.length>1,'database is split into real chunks');
  r.conn.exec("UPDATE state SET value='later'");fs.rmSync(r.bundle,{recursive:true});
  const receipt=await upload(r.options);assert.equal(receipt.transport_id,r.p.transport_id);
  const puts=r.store.calls.filter(c=>c[0]==='put');assert.ok(puts.at(-1)[1].endsWith('/completion.json'));
  assert.ok(!Buffer.concat([...r.store.bytes.values()]).includes(r.bytes));
  const destination=path.join(r.root,'retrieved');
  const got=await retrieve({...r.options,cipher:r.cipher,destination});assert.equal(got.artifact_count,1);
  assert.equal(validateBackup(destination).artifacts.length,1);
  assert.deepEqual(fs.readFileSync(path.join(destination,'client-artifacts',`${r.id}.bin`)),r.bytes);
  const db=new DatabaseSync(path.join(destination,'board.db'),{readOnly:true});
  assert.equal(db.prepare('SELECT value FROM state').get().value,'original');
  assert.equal(db.prepare('SELECT sha256 FROM decisions').get().sha256,r.sha256);db.close();
  stageRestore({bundle:destination,destination:path.join(r.root,'working')});
  await assert.rejects(retrieve({...r.options,cipher:r.cipher,destination}),e=>e.code==='DESTINATION_EXISTS');
});

test('lost PUT response and process restart retry exactly; completed retries only recheck remote bytes',async t=>{
  const r=await prepared(t);let lost=true;
  const put=r.store.put.bind(r.store);r.store.put=async(...args)=>{await put(...args);if(lost){lost=false;throw new OffsiteError('RETRY');}};
  await upload(r.options);const puts=r.store.calls.filter(c=>c[0]==='put').length;
  await upload({...r.options,clock:()=>Date.now()+MAX_WINDOW_MS*2});
  assert.equal(r.store.calls.filter(c=>c[0]==='put').length,puts,'completed old receipt never republishes missing objects');
  const entry=[...r.store.bytes.keys()].find(k=>k.endsWith('/000000.age'));r.store.bytes.delete(entry);
  await assert.rejects(upload(r.options),e=>e.code==='MISSING');
  assert.equal(r.store.calls.filter(c=>c[0]==='put').length,puts);
});

test('interrupted upload preserves outbox; resume confirms existing bytes without rewriting',async t=>{
  const r=await prepared(t);let fail=true;
  r.store.hook=(kind,key)=>{if(fail&&kind==='put'&&key.endsWith('/manifest.age'))throw new OffsiteError('AUTH');};
  await assert.rejects(upload(r.options),e=>e.code==='AUTH');
  assert.ok(![...r.store.bytes.keys()].some(k=>k.endsWith('/completion.json')));
  assert.ok(!fs.existsSync(path.join(r.outbox,r.p.transport_id,'receipt.json')));
  const before=r.store.bytes.get(prefix(r.installation,r.p.transport_id)+'000000.age');fail=false;await upload(r.options);
  assert.deepEqual(r.store.bytes.get(prefix(r.installation,r.p.transport_id)+'000000.age'),before);
});

test('different existing ciphertext cannot be overwritten or publish completion',async t=>{
  const r=await prepared(t),key=prefix(r.installation,r.p.transport_id)+'000000.age';r.store.bytes.set(key,Buffer.from('different'));
  await assert.rejects(upload(r.options),e=>e.code==='BYTES');assert.deepEqual(r.store.bytes.get(key),Buffer.from('different'));
  assert.equal(r.store.calls.filter(c=>c[0]==='put').length,0);
});

test('expired or rolled-back publication refuses completion; fresh explicit fork keeps snapshot identity',async t=>{
  const r=await prepared(t);let wall=Date.now();r.store.hook=(kind,key)=>{if(kind==='put'&&key.endsWith('/manifest.age'))wall+=MAX_WINDOW_MS;};
  await assert.rejects(upload({...r.options,clock:()=>wall}),e=>e.code==='PUBLICATION_WINDOW');
  assert.ok(![...r.store.bytes.keys()].some(k=>k.endsWith('/completion.json')));
  r.store.hook=null;
  await assert.rejects(upload({...r.options,clock:()=>Date.now()-10000}),e=>e.code==='PUBLICATION_WINDOW');
  const fork=await forkPrepared({...r.options,clock:()=>wall});assert.notEqual(fork.transport_id,r.p.transport_id);
  assert.equal(fork.snapshot_at,r.p.snapshot_at);assert.ok(fs.existsSync(path.join(r.outbox,r.p.transport_id)));
  await upload({...r.options,transport:fork.transport_id,clock:()=>wall});
});

test('quota and source corruption fail before encryption or creating a ready set',async t=>{
  const r=rig(t);let called=0;const cipher={encrypt(){called++;throw Error('must not run');}};
  await assert.rejects(prepare({...r.options,bundle:r.bundle,cipher,policy:{maxOutbox:1024}}),e=>e.code==='OUTBOX_QUOTA');
  assert.equal(called,0);assert.deepEqual(fs.readdirSync(r.outbox),[]);
  await assert.rejects(prepare({...r.options,bundle:r.bundle,cipher,policy:{chunkBytes:1}}),e=>e.code==='LIMITS');
  assert.equal(called,0);
  fs.appendFileSync(path.join(r.bundle,'board.db'),'corrupt');await assert.rejects(prepare({...r.options,bundle:r.bundle,cipher}));assert.equal(called,0);
});

for(const corruption of ['signature','key','installation','transport','missing','ciphertext','truncation','symlink','mapping'])test(`retrieval fails closed for ${corruption} and keeps existing data`,async t=>{
  const r=await prepared(t),base=prefix(r.installation,r.p.transport_id);await upload(r.options);
  const options={...r.options,cipher:r.cipher,destination:path.join(r.root,'new')};
  if(['signature','installation','transport'].includes(corruption)){
    const c=JSON.parse(r.store.bytes.get(base+'completion.json'));
    if(corruption==='signature')c.created_at='2000-01-01T00:00:00.000Z';else c[`${corruption}_id`]=randomUUID();r.store.bytes.set(base+'completion.json',Buffer.from(JSON.stringify(c)));
  }
  if(corruption==='key')options.trustedKeys=new Map([['signer-a',generateKeyPairSync('ed25519').publicKey]]);
  if(corruption==='missing')r.store.bytes.delete(base+'000000.age');
  if(corruption==='ciphertext'){const b=Buffer.from(r.store.bytes.get(base+'000000.age'));b[0]^=1;r.store.bytes.set(base+'000000.age',b);}
  if(corruption==='truncation')r.store.bytes.set(base+'000000.age',r.store.bytes.get(base+'000000.age').subarray(0,3));
  if(corruption==='symlink'){const other=path.join(r.root,'alias');fs.symlinkSync(r.root,other);options.destination=path.join(other,'new');}
  if(corruption==='mapping'){
    const d=path.join(r.outbox,r.p.transport_id),s=JSON.parse(fs.readFileSync(path.join(d,'ready.json')));s.objects[0].name='../outside';replaceJson(path.join(d,'ready.json'),s);
    await assert.rejects(upload(r.options));return;
  }
  await assert.rejects(retrieve(options));assert.equal(fs.existsSync(options.destination),false);
  assert.ok(!fs.readdirSync(r.root).some(n=>n.startsWith('.retrieve-')));
  assert.deepEqual(fs.readFileSync(path.join(r.data,'client-artifacts',`${r.id}.bin`)),r.bytes);
});

test('single outbox lock prevents simultaneous writers and reclaims only a dead known owner',async t=>{
  const r=rig(t);let release;
  const first=locked(r.outbox,()=>new Promise(resolve=>release=resolve));
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(locked(r.outbox,async()=>{}),e=>e.code==='LOCKED');release();await first;
  const lock=path.join(r.outbox,'.lock');fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:2147483647,token:randomUUID()}),{mode:0o600});
  await locked(r.outbox,async()=>{});assert.equal(fs.existsSync(lock),false);
});

test('hanging network is bounded and does not publish a receipt',async t=>{
  const r=await prepared(t);r.store.get=()=>new Promise(()=>{});
  await assert.rejects(upload({...r.options,timeoutMs:20}),e=>e.code==='RETRY');
  assert.ok(!fs.existsSync(path.join(r.outbox,r.p.transport_id,'receipt.json')));
});
